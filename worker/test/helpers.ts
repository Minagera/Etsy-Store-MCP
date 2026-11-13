// In-memory stand-ins for KV and Etsy, so the whole flow runs under vitest.

export class MemoryKV {
  store = new Map<string, { value: string; expiresAt?: number; metadata?: unknown }>();

  async get(key: string, type?: any): Promise<any> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    const kind = typeof type === "string" ? type : type?.type;
    if (kind === "json") return JSON.parse(entry.value);
    return entry.value;
  }

  async put(key: string, value: string, opts: any = {}): Promise<void> {
    let expiresAt: number | undefined;
    if (opts.expirationTtl) expiresAt = Date.now() + opts.expirationTtl * 1000;
    if (opts.expiration) expiresAt = opts.expiration * 1000;
    this.store.set(key, { value: String(value), expiresAt, metadata: opts.metadata });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(opts: any = {}): Promise<any> {
    const keys = [...this.store.keys()]
      .filter((k) => !opts.prefix || k.startsWith(opts.prefix))
      .sort()
      .map((name) => ({ name, metadata: this.store.get(name)?.metadata }));
    return { keys, list_complete: true, cacheStatus: null };
  }
}

export interface EtsyFakeOptions {
  shopId?: string;
  userId?: string;
  refreshFails?: boolean;
}

/** A fake fetch that answers the Etsy endpoints the server calls, and records them. */
export function fakeEtsy(opts: EtsyFakeOptions = {}) {
  const shopId = opts.shopId ?? "12345678";
  const userId = opts.userId ?? "111222";
  const calls: { url: string; method: string; headers: Headers; body?: any }[] = [];
  let tokenCounter = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url, method, headers: new Headers(init.headers), body: init.body });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url === "https://api.etsy.com/v3/public/oauth/token") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "refresh_token" && opts.refreshFails) {
        return json({ error: "invalid_grant", error_description: "refresh token expired" }, 400);
      }
      tokenCounter++;
      return json({
        access_token: `${userId}.access${tokenCounter}`,
        refresh_token: `${userId}.refresh${tokenCounter}`,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (url === "https://openapi.etsy.com/v3/application/users/me") {
      return json({ user_id: Number(userId), shop_id: Number(shopId) });
    }
    if (url.startsWith("https://openapi.etsy.com/v3/application/openapi-ping")) {
      return json({ application_id: 1 });
    }
    if (url.startsWith(`https://openapi.etsy.com/v3/application/shops/${shopId}/listings/`) && url.endsWith("/images")) {
      return json({ listing_image_id: 9, ok: true }, 201);
    }
    if (url.startsWith(`https://openapi.etsy.com/v3/application/shops/${shopId}/listings?state=`)) {
      return json({ count: 1, results: [{ listing_id: 5, state: "draft" }] });
    }
    if (url === "https://images.example.com/photo.jpg") {
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/jpeg" } });
    }
    if (url === "https://example.com/page") {
      return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    }
    return json({ error: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;

  return { fetchImpl, calls };
}

export const ctxStub = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

/** Collect Set-Cookie values into a Cookie header, the way a browser would. */
export function cookieHeader(...responses: Response[]): string {
  const jar = new Map<string, string>();
  for (const r of responses) {
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (/max-age=0/i.test(c) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
