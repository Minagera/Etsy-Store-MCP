import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { tokenKey } from "../src/etsy";
import { MemoryKV, cookieHeader, ctxStub, fakeEtsy } from "./helpers";

const ORIGIN = "https://etsy-mcp.test";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

function makeEnv(kv: MemoryKV, overrides: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: kv as unknown as KVNamespace,
    ETSY_TOKEN: "testkeystring:testsecret",
    ETSY_SHOP_ID: "12345678",
    PUBLIC_URL: ORIGIN,
    ETSY_SCOPES: "listings_r listings_w shops_r",
    ...overrides,
  } as Env;
}

const call = (env: Env, path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }), env, ctxStub);

async function pkce() {
  const verifier = "v".repeat(20) + crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let s = "";
  for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
  return { verifier, challenge: btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
}

/** Runs the whole connect flow the way Claude and a browser would. Returns the MCP access token. */
async function connect(env: Env) {
  const reg = await call(env, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name: "Claude", token_endpoint_auth_method: "none" }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as any;

  const { verifier, challenge } = await pkce();
  const authQs = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state",
    scope: "etsy:shop",
    resource: `${ORIGIN}/mcp`,
  });
  const consent = await call(env, `/authorize?${authQs}`);
  expect(consent.status).toBe(200);
  const page = await consent.text();
  expect(page).toContain("Let Claude manage your Etsy shop?");
  expect(page).toContain("claude.ai");
  const handle = page.match(/name="handle" value="([^"]+)"/)![1];

  const approve = await call(env, "/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(consent) },
    body: new URLSearchParams({ handle, decision: "approve" }),
  });
  expect(approve.status).toBe(302);
  const etsyUrl = new URL(approve.headers.get("location")!);
  expect(etsyUrl.origin + etsyUrl.pathname).toBe("https://www.etsy.com/oauth/connect");
  expect(etsyUrl.searchParams.get("client_id")).toBe("testkeystring");
  expect(etsyUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/etsy/callback`);
  expect(etsyUrl.searchParams.get("scope")).toBe("listings_r listings_w shops_r");
  expect(etsyUrl.searchParams.get("code_challenge_method")).toBe("S256");
  const state = etsyUrl.searchParams.get("state")!;

  const back = await call(env, `/etsy/callback?code=etsy-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie: cookieHeader(consent, approve) },
  });
  return { back, client_id, verifier };
}

async function finish(env: Env, back: Response, client_id: string, verifier: string) {
  expect(back.status).toBe(302);
  const toClaude = new URL(back.headers.get("location")!);
  expect(toClaude.origin + toClaude.pathname).toBe(CLAUDE_CALLBACK);
  expect(toClaude.searchParams.get("state")).toBe("claude-state");
  const tokenRes = await call(env, "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: toClaude.searchParams.get("code")!,
      redirect_uri: CLAUDE_CALLBACK,
      client_id,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(tokenRes.status).toBe(200);
  return ((await tokenRes.json()) as any).access_token as string;
}

const rpc = (env: Env, token: string, id: number, method: string, params: unknown = {}) =>
  call(env, "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

describe("remote Etsy MCP worker", () => {
  let etsy: ReturnType<typeof fakeEtsy>;

  beforeEach(() => {
    etsy = fakeEtsy();
    vi.stubGlobal("fetch", etsy.fetchImpl);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("challenges an unauthenticated /mcp request with discovery metadata", async () => {
    const env = makeEnv(new MemoryKV());
    const res = await call(env, "/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);

    const prm = await call(env, "/.well-known/oauth-protected-resource/mcp");
    expect(prm.status).toBe(200);
    const doc = (await prm.json()) as any;
    expect(doc.resource).toBe(`${ORIGIN}/mcp`);
    expect(doc.authorization_servers).toEqual([ORIGIN]);

    const as = (await (await call(env, "/.well-known/oauth-authorization-server")).json()) as any;
    expect(as.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(as.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
  });

  it("connects the shop owner end to end and serves tools", async () => {
    const kv = new MemoryKV();
    const env = makeEnv(kv);
    const { back, client_id, verifier } = await connect(env);
    const token = await finish(env, back, client_id, verifier);

    // Etsy tokens landed in KV, keyed by shop.
    const stored = JSON.parse(kv.store.get(tokenKey("12345678"))!.value);
    expect(stored.access_token).toBe("111222.access1");
    expect(stored.refresh_token).toBe("111222.refresh1");

    // The Etsy code exchange used PKCE and the registered callback URL.
    const exchange = etsy.calls.find((c) => c.url.endsWith("/oauth/token"))!;
    const form = new URLSearchParams(String(exchange.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe(`${ORIGIN}/etsy/callback`);
    expect(form.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);

    const init = await rpc(env, token, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.status).toBe(200);
    expect(((await init.json()) as any).result.serverInfo.name).toBe("etsy-mcp");

    const list = (await (await rpc(env, token, 2, "tools/list")).json()) as any;
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toContain("upload_listing_image");
    expect(names).toContain("get_shop_listings");
    const upload = list.result.tools.find((t: any) => t.name === "upload_listing_image");
    expect(upload.inputSchema.properties).toHaveProperty("image_url");
    expect(upload.inputSchema.properties).not.toHaveProperty("image_path");

    const drafts = (await (await rpc(env, token, 3, "tools/call", { name: "get_shop_listings", arguments: { state: "draft" } })).json()) as any;
    expect(drafts.result.isError).toBeFalsy();
    expect(drafts.result.content[0].text).toContain('"state": "draft"');

    const img = (await (
      await rpc(env, token, 4, "tools/call", {
        name: "upload_listing_image",
        arguments: { listing_id: "5", image_url: "https://images.example.com/photo.jpg", alt_text: "Front" },
      })
    ).json()) as any;
    expect(img.result.isError).toBeFalsy();
    const post = etsy.calls.find((c) => c.url.endsWith("/listings/5/images"))!;
    expect(post.method).toBe("POST");
    expect(post.headers.get("authorization")).toBe("Bearer 111222.access1");
    expect(post.headers.get("x-api-key")).toBe("testkeystring:testsecret");
    expect(post.body).toBeInstanceOf(FormData);

    // Stateless server: GET is refused rather than held open.
    const get = await call(env, "/mcp", { headers: { authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);
  });

  it("refuses an Etsy account that doesn't own the configured shop", async () => {
    etsy = fakeEtsy({ shopId: "999" });
    vi.stubGlobal("fetch", etsy.fetchImpl);
    const kv = new MemoryKV();
    const env = makeEnv(kv);
    const { back } = await connect(env);
    expect(back.status).toBe(403);
    expect(await back.text()).toContain("own the shop this connector is set up for");
    expect(kv.store.has(tokenKey("12345678"))).toBe(false);
  });

  it("returns access_denied to Claude when the Etsy sign-in is cancelled", async () => {
    const env = makeEnv(new MemoryKV());
    // Re-run the first half of the flow, but come back from Etsy with an error.
    const reg = (await (
      await call(env, "/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name: "Claude", token_endpoint_auth_method: "none" }),
      })
    ).json()) as any;
    const { challenge } = await pkce();
    const consent = await call(
      env,
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: reg.client_id,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s1",
        resource: `${ORIGIN}/mcp`,
      })}`
    );
    const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)![1];
    const approve = await call(env, "/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(consent) },
      body: new URLSearchParams({ handle, decision: "approve" }),
    });
    const state = new URL(approve.headers.get("location")!).searchParams.get("state")!;
    const back = await call(env, `/etsy/callback?error=access_denied&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookieHeader(consent, approve) },
    });
    expect(back.status).toBe(302);
    const loc = new URL(back.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("s1");
  });

  it("rejects a consent form posted without the browser's cookie", async () => {
    const env = makeEnv(new MemoryKV());
    const res = await call(env, "/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: "forged", decision: "approve" }),
    });
    expect(res.status).toBe(400);
  });
});
