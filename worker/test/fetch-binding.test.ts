import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { EtsyClient, tokenKey } from "../src/etsy";
import { buildServer } from "../src/mcp";
import { MemoryKV, fakeEtsy } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

/**
 * The Workers runtime throws "Illegal invocation" when the global fetch runs
 * with a `this` that isn't the global object, e.g. `this.fetchImpl(...)` on a
 * client that stored it. Node doesn't, so mimic Workers here.
 */
function strictGlobalFetch() {
  const etsy = fakeEtsy();
  const strict = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    return etsy.fetchImpl(input, init);
  };
  vi.stubGlobal("fetch", strict);
  return etsy;
}

async function envWithTokens() {
  const kv = new MemoryKV();
  await kv.put(
    tokenKey("12345678"),
    JSON.stringify({ access_token: "111222.tok", refresh_token: "111222.ref", expires_at: Date.now() + 30 * 60_000 }),
  );
  return { OAUTH_KV: kv as unknown as KVNamespace, ETSY_TOKEN: "testkeystring:testsecret", ETSY_SHOP_ID: "12345678", PUBLIC_URL: "https://etsy-mcp.test" } as Env;
}

describe("default fetch is safe to store and call as a method", () => {
  it("EtsyClient with no injected fetch", async () => {
    const etsy = strictGlobalFetch();
    const client = new EtsyClient(await envWithTokens());
    await expect(client.request("/openapi-ping")).resolves.toBeDefined();
    expect(etsy.calls.some((c) => c.url.includes("/openapi-ping"))).toBe(true);
  });

  it("a tool call through buildServer with no injected fetch", async () => {
    strictGlobalFetch();
    const server = buildServer(await envWithTokens()) as any;
    const handler = server._requestHandlers.get("tools/call");
    const res = await handler({ method: "tools/call", params: { name: "ping", arguments: {} } }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).not.toMatch(/Illegal invocation/);
  });
});
