import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { EtsyClient, EtsyReauthRequired, getValidAccessToken, tokenKey } from "../src/etsy";
import { loadFile } from "../src/files";
import { callTool } from "../src/tools";
import { MemoryKV, fakeEtsy } from "./helpers";

function env(kv: MemoryKV): Env {
  return {
    OAUTH_KV: kv as unknown as KVNamespace,
    ETSY_TOKEN: "testkeystring:testsecret",
    ETSY_SHOP_ID: "12345678",
    PUBLIC_URL: "https://etsy-mcp.test",
  } as Env;
}

async function seed(kv: MemoryKV, expiresAt: number) {
  await kv.put(
    tokenKey("12345678"),
    JSON.stringify({ access_token: "111222.old", refresh_token: "111222.oldrefresh", expires_at: expiresAt })
  );
}

describe("Etsy tokens in KV", () => {
  it("uses a fresh stored token without refreshing", async () => {
    const kv = new MemoryKV();
    await seed(kv, Date.now() + 30 * 60_000);
    const { fetchImpl, calls } = fakeEtsy();
    expect(await getValidAccessToken(env(kv), fetchImpl)).toBe("111222.old");
    expect(calls).toHaveLength(0);
  });

  it("refreshes a token near expiry and saves the rotated pair", async () => {
    const kv = new MemoryKV();
    await seed(kv, Date.now() + 60_000);
    const { fetchImpl, calls } = fakeEtsy();
    expect(await getValidAccessToken(env(kv), fetchImpl)).toBe("111222.access1");
    const form = new URLSearchParams(String(calls[0].body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("testkeystring");
    expect(form.get("refresh_token")).toBe("111222.oldrefresh");
    const stored = JSON.parse(kv.store.get(tokenKey("12345678"))!.value);
    expect(stored.refresh_token).toBe("111222.refresh1");
  });

  it("shares one refresh between concurrent calls", async () => {
    const kv = new MemoryKV();
    await seed(kv, 0);
    const { fetchImpl, calls } = fakeEtsy();
    const e = env(kv);
    const tokens = await Promise.all([getValidAccessToken(e, fetchImpl), getValidAccessToken(e, fetchImpl)]);
    expect(tokens).toEqual(["111222.access1", "111222.access1"]);
    expect(calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
  });

  it("asks for a reconnect when Etsy rejects the refresh token", async () => {
    const kv = new MemoryKV();
    await seed(kv, 0);
    const { fetchImpl } = fakeEtsy({ refreshFails: true });
    await expect(getValidAccessToken(env(kv), fetchImpl)).rejects.toBeInstanceOf(EtsyReauthRequired);
  });

  it("asks for a connect when nothing is stored", async () => {
    const { fetchImpl } = fakeEtsy();
    await expect(getValidAccessToken(env(new MemoryKV()), fetchImpl)).rejects.toBeInstanceOf(EtsyReauthRequired);
  });
});

describe("files by URL", () => {
  const { fetchImpl } = fakeEtsy();

  it("downloads an https file and names it from the URL", async () => {
    const f = await loadFile({ url: "https://images.example.com/photo.jpg" }, fetchImpl);
    expect(f.name).toBe("photo.jpg");
    expect(f.contentType).toBe("image/jpeg");
    expect([...f.bytes]).toEqual([1, 2, 3, 4]);
  });

  it("refuses plain http", async () => {
    await expect(loadFile({ url: "http://images.example.com/photo.jpg" }, fetchImpl)).rejects.toThrow(/https/);
  });

  it("refuses a web page instead of a file", async () => {
    await expect(loadFile({ url: "https://example.com/page" }, fetchImpl)).rejects.toThrow(/direct download/);
  });

  it("enforces the size cap", async () => {
    await expect(loadFile({ url: "https://images.example.com/photo.jpg" }, fetchImpl, 3)).rejects.toThrow(/limit/);
  });

  it("decodes base64 and data: URLs", async () => {
    const a = await loadFile({ base64: "AQIDBA==", name: "x.bin" });
    expect([...a.bytes]).toEqual([1, 2, 3, 4]);
    const b = await loadFile({ base64: "data:image/png;base64,AQIDBA==" });
    expect([...b.bytes]).toEqual([1, 2, 3, 4]);
  });
});

describe("files from the private GitHub repo", () => {
  const gh = { repo: "Owner/files-repo", token: "ghtest" };
  function ghFetch() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/missing.pdf")) return new Response("nope", { status: 404 });
      return new Response(new Uint8Array([5, 6, 7]), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("reads a file with the token and raw media type", async () => {
    const { fetchImpl, calls } = ghFetch();
    const f = await loadFile({ githubPath: "etsy-products/My_File.pdf", githubRef: "claude/branch-1" }, fetchImpl, undefined, gh);
    expect([...f.bytes]).toEqual([5, 6, 7]);
    expect(f.name).toBe("My_File.pdf");
    expect(f.contentType).toBe("application/pdf");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/Owner/files-repo/contents/etsy-products/My_File.pdf?ref=claude%2Fbranch-1"
    );
    const h = calls[0].init?.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer ghtest");
    expect(h.Accept).toBe("application/vnd.github.raw");
  });

  it("refuses paths that climb out or look like URLs", async () => {
    const { fetchImpl, calls } = ghFetch();
    for (const p of ["../secret", "a/../../b", "/etc/passwd", "https://evil.example/x", "a//b"]) {
      await expect(loadFile({ githubPath: p }, fetchImpl, undefined, gh)).rejects.toThrow(/github_path/);
    }
    expect(calls).toHaveLength(0);
  });

  it("explains when it isn't set up", async () => {
    const { fetchImpl } = ghFetch();
    await expect(loadFile({ githubPath: "x.pdf" }, fetchImpl, undefined, {})).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it("reports a missing file plainly", async () => {
    const { fetchImpl } = ghFetch();
    await expect(loadFile({ githubPath: "missing.pdf" }, fetchImpl, undefined, gh)).rejects.toThrow(/Not found/);
  });

  it("takes only one source", async () => {
    await expect(loadFile({ githubPath: "x.pdf", url: "https://a.example/x.pdf" }, undefined, undefined, gh)).rejects.toThrow(/only one/);
  });
});

describe("tools", () => {
  it("rejects non-numeric IDs before calling Etsy", async () => {
    const kv = new MemoryKV();
    await seed(kv, Date.now() + 30 * 60_000);
    const { fetchImpl, calls } = fakeEtsy();
    const client = new EtsyClient(env(kv), fetchImpl);
    await expect(callTool("get_listing", { listing_id: "../shops/1" }, client, fetchImpl)).rejects.toThrow(/numeric/);
    expect(calls).toHaveLength(0);
  });

  it("requires a shipping profile for physical drafts", async () => {
    const kv = new MemoryKV();
    await seed(kv, Date.now() + 30 * 60_000);
    const { fetchImpl } = fakeEtsy();
    const client = new EtsyClient(env(kv), fetchImpl);
    await expect(
      callTool(
        "create_draft_listing",
        { title: "t", description: "d", price: 1, quantity: 1, who_made: "i_did", when_made: "made_to_order", taxonomy_id: 1, is_supply: false },
        client,
        fetchImpl
      )
    ).rejects.toThrow(/shipping_profile_id/);
  });

  it("get_active_listings uses the same shop listings path as get_shop_listings with state active", async () => {
    const kv = new MemoryKV();
    await seed(kv, Date.now() + 30 * 60_000);
    const { fetchImpl, calls } = fakeEtsy();
    const client = new EtsyClient(env(kv), fetchImpl);
    await callTool("get_active_listings", { limit: 7, offset: 14 }, client, fetchImpl);
    await callTool("get_shop_listings", { state: "active", limit: 7, offset: 14 }, client, fetchImpl);
    const urls = calls.filter((c) => c.url.includes("/listings")).map((c) => c.url);
    expect(urls).toEqual([
      "https://openapi.etsy.com/v3/application/shops/12345678/listings?state=active&limit=7&offset=14",
      "https://openapi.etsy.com/v3/application/shops/12345678/listings?state=active&limit=7&offset=14",
    ]);
    expect(urls.join(" ")).not.toContain("/listings/active");
  });

  it("get_active_listings defaults to 25 and offset 0", async () => {
    const kv = new MemoryKV();
    await seed(kv, Date.now() + 30 * 60_000);
    const { fetchImpl, calls } = fakeEtsy();
    const client = new EtsyClient(env(kv), fetchImpl);
    await callTool("get_active_listings", {}, client, fetchImpl);
    expect(calls.find((c) => c.url.includes("/listings"))!.url).toBe(
      "https://openapi.etsy.com/v3/application/shops/12345678/listings?state=active&limit=25&offset=0"
    );
  });
});
