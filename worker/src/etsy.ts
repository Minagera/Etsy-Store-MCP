// Etsy Open API v3 client for the Worker. Tokens live in KV, not on disk.
//
// The token pair is seeded when Matt authorizes the connector in Claude (the
// /authorize flow sends him through Etsy's own OAuth and saves what comes
// back), and refreshed here as it nears expiry.

import { defaultFetch } from "./fetch";
import type { Env } from "./env";

export const ETSY_BASE_URL = "https://openapi.etsy.com/v3/application";
export const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
export const ETSY_CONNECT_URL = "https://www.etsy.com/oauth/connect";

export interface EtsyTokens {
  access_token: string;
  refresh_token: string;
  /** ms since epoch */
  expires_at: number;
  etsy_user_id?: string;
}

export class EtsyReauthRequired extends Error {
  constructor(message?: string) {
    super(
      message ||
        "Etsy access has lapsed. Reconnect this connector in Claude (Settings, Connectors) to sign in to Etsy again."
    );
    this.name = "EtsyReauthRequired";
  }
}

export function tokenKey(shopId: string): string {
  return `etsy:tokens:${shopId}`;
}

export function keystring(env: Env): string {
  const key = (env.ETSY_TOKEN || "").split(":")[0];
  if (!key) throw new Error("ETSY_TOKEN secret is not set (expected '<keystring>:<shared_secret>').");
  return key;
}

export async function loadTokens(env: Env): Promise<EtsyTokens | null> {
  return env.OAUTH_KV.get<EtsyTokens>(tokenKey(env.ETSY_SHOP_ID), "json");
}

export async function saveTokens(env: Env, tokens: EtsyTokens): Promise<void> {
  await env.OAUTH_KV.put(tokenKey(env.ETSY_SHOP_ID), JSON.stringify(tokens));
}

/** Turn an Etsy token endpoint response into what we store. */
export function tokensFromResponse(json: any, previous?: EtsyTokens | null): EtsyTokens {
  const accessToken: string = json.access_token;
  return {
    access_token: accessToken,
    // Etsy issues a new refresh token on refresh; keep it, fall back to the old one.
    refresh_token: json.refresh_token || previous?.refresh_token || "",
    expires_at: Date.now() + (json.expires_in ? json.expires_in * 1000 : 3600 * 1000),
    // Etsy access tokens are "<user_id>.<token>".
    etsy_user_id: accessToken?.includes(".") ? accessToken.split(".")[0] : previous?.etsy_user_id,
  };
}

// One refresh per isolate at a time. Concurrent calls share it instead of
// spending the same refresh token twice.
let refreshInFlight: Promise<string> | null = null;

export function refreshAccessToken(env: Env, current: EtsyTokens, fetchImpl: typeof fetch = defaultFetch): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh(env, current, fetchImpl).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(env: Env, current: EtsyTokens, fetchImpl: typeof fetch): Promise<string> {
  if (!current.refresh_token) throw new EtsyReauthRequired();
  const res = await fetchImpl(ETSY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: keystring(env),
      refresh_token: current.refresh_token,
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (res.ok) {
    const next = tokensFromResponse(json, current);
    await saveTokens(env, next);
    return next.access_token;
  }
  if (json?.error === "invalid_grant") {
    // Another isolate may have refreshed first and rotated the token. If KV
    // now holds a different, still-valid pair, use it.
    const stored = await loadTokens(env);
    if (stored && stored.refresh_token !== current.refresh_token && stored.expires_at > Date.now() + 60_000) {
      return stored.access_token;
    }
    throw new EtsyReauthRequired();
  }
  throw new Error(`Etsy token refresh failed: ${res.status} ${JSON.stringify(json)}`);
}

export async function getValidAccessToken(env: Env, fetchImpl: typeof fetch = defaultFetch): Promise<string> {
  const tokens = await loadTokens(env);
  if (!tokens) throw new EtsyReauthRequired("No Etsy tokens stored yet. Connect this server in Claude to sign in to Etsy.");
  const fiveMinutes = 5 * 60 * 1000;
  if (!tokens.access_token || Date.now() > tokens.expires_at - fiveMinutes) {
    return refreshAccessToken(env, tokens, fetchImpl);
  }
  return tokens.access_token;
}

function looksExpired(status: number, json: any): boolean {
  return status === 401 && (json?.error === "invalid_token" || /expired/i.test(json?.error_description || ""));
}

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export interface EtsyRequest {
  method?: string;
  /** Sent as application/x-www-form-urlencoded (arrays as key[]), which Etsy's write endpoints expect. */
  form?: Record<string, unknown>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as multipart/form-data. */
  multipart?: () => FormData;
}

export class EtsyClient {
  constructor(private env: Env, private fetchImpl: typeof fetch = defaultFetch) {}

  get shopId(): string {
    return this.env.ETSY_SHOP_ID;
  }

  async request(path: string, req: EtsyRequest = {}, retried = false): Promise<any> {
    const accessToken = await getValidAccessToken(this.env, this.fetchImpl);
    const headers: Record<string, string> = {
      "x-api-key": this.env.ETSY_TOKEN,
      Authorization: `Bearer ${accessToken}`,
    };
    let body: BodyInit | undefined;
    if (req.multipart) {
      body = req.multipart(); // fetch sets the multipart boundary itself
    } else if (req.form) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(req.form)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) for (const item of v) form.append(`${k}[]`, String(item));
        else form.append(k, String(v));
      }
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = form;
    } else if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    }

    const res = await this.fetchImpl(`${ETSY_BASE_URL}${path}`, { method: req.method || "GET", headers, body });
    const json = await parse(res);
    if (!res.ok) {
      if (looksExpired(res.status, json) && !retried) {
        const tokens = await loadTokens(this.env);
        if (tokens) {
          await refreshAccessToken(this.env, tokens, this.fetchImpl);
          return this.request(path, req, true);
        }
      }
      throw new Error(`Etsy API ${res.status}: ${JSON.stringify(json)}`);
    }
    return json;
  }
}
