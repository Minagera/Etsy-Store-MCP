// The authorize flow. Claude sends Matt here when he connects the server.
//
// 1. GET  /authorize      Show a consent page naming the app that asked.
// 2. POST /authorize      On Allow, send the browser to Etsy's OAuth page.
// 3. GET  /etsy/callback  Exchange Etsy's code, check the Etsy account owns
//                         ETSY_SHOP_ID, save the Etsy tokens in KV, and finish
//                         the authorization back to Claude.
//
// So signing in to Etsy as the shop owner is what proves it's Matt. Anyone
// else who reaches the page gets as far as Etsy and is refused at step 3.

import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { DEFAULT_ETSY_SCOPES, MCP_SCOPE, publicOrigin, type Env, type GrantProps } from "./env";
import { ETSY_BASE_URL, ETSY_CONNECT_URL, ETSY_TOKEN_URL, keystring, saveTokens, tokensFromResponse } from "./etsy";

export const ETSY_CALLBACK_PATH = "/etsy/callback";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function html(body: string, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  h.set("X-Frame-Options", "DENY");
  return new Response(body, { status, headers: h });
}

function page(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}
.box{border:1px solid #ddd;border-radius:8px;padding:1rem 1.25rem}
button{font:inherit;padding:.5rem 1rem;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer}
button.primary{background:#f1641e;border-color:#f1641e;color:#fff}
.warn{background:#fff4e5;border-radius:6px;padding:.5rem .75rem}
</style></head><body>${inner}</body></html>`;
}

export function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName || "An app");
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  return page(
    `Connect ${details.clientName || "an app"} to your Etsy shop`,
    `<div class="box">
<h1 style="font-size:1.3rem">Let ${name} manage your Etsy shop?</h1>
<p>${origin} Access goes to <strong>${escape(details.redirectHost)}</strong>.</p>
${
  details.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on your own computer. Continue only if you just started connecting from it.</p>`
    : ""
}
<p>It will be able to read your listings and create, edit, publish and delete them. Next you'll sign in to Etsy as the shop owner.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<p><button class="primary" name="decision" value="approve">Continue to Etsy</button>
<button name="decision" value="deny">Cancel</button></p>
</form></div>`
  );
}

function errorPage(message: string, status = 400): Response {
  return html(page("Couldn't connect", `<div class="box"><h1 style="font-size:1.3rem">Couldn't connect</h1><p>${escape(message)}</p></div>`), status);
}

function base64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function s256(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export function etsyRedirectUri(env: Env): string {
  return `${publicOrigin(env)}${ETSY_CALLBACK_PATH}`;
}

export async function etsyAuthorizeUrl(env: Env, state: string, verifier: string): Promise<string> {
  const url = new URL(ETSY_CONNECT_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", keystring(env));
  url.searchParams.set("redirect_uri", etsyRedirectUri(env));
  url.searchParams.set("scope", (env.ETSY_SCOPES || DEFAULT_ETSY_SCOPES).trim());
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function handleAuthorizeGet(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return html(consentPage(details, consent.handle), 200, consent.headers);
}

async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") || "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: [MCP_SCOPE] });
  // Etsy's PKCE verifier: 43-128 chars of [A-Za-z0-9-._~].
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  headers.set("Location", await etsyAuthorizeUrl(env, state, verifier));
  return new Response(null, { status: 302, headers });
}

async function handleEtsyCallback(request: Request, env: Env, fetchImpl: typeof fetch): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
  const params = new URL(request.url).searchParams;

  if (params.get("error") || !params.get("code")) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied", "Etsy sign-in was cancelled."));
    return new Response(null, { status: 302, headers });
  }

  const tokenRes = await fetchImpl(ETSY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: keystring(env),
      redirect_uri: etsyRedirectUri(env),
      code: params.get("code")!,
      code_verifier: data.verifier,
    }),
  });
  const tokenJson: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    console.error("Etsy code exchange failed", tokenRes.status, tokenJson?.error);
    return errorPage("Etsy didn't accept the sign-in. Try connecting again.", 502);
  }
  const tokens = tokensFromResponse(tokenJson);

  // Who signed in, and do they own the shop this server is for?
  const meRes = await fetchImpl(`${ETSY_BASE_URL}/users/me`, {
    headers: { "x-api-key": env.ETSY_TOKEN, Authorization: `Bearer ${tokens.access_token}` },
  });
  const me: any = await meRes.json().catch(() => ({}));
  if (!meRes.ok) {
    console.error("Etsy /users/me failed", meRes.status);
    return errorPage("Couldn't confirm which Etsy account signed in. Try connecting again.", 502);
  }
  if (String(me.shop_id ?? "") !== String(env.ETSY_SHOP_ID)) {
    return errorPage("That Etsy account doesn't own the shop this connector is set up for.", 403);
  }

  await saveTokens(env, { ...tokens, etsy_user_id: String(me.user_id ?? tokens.etsy_user_id ?? "") });

  const props: GrantProps = { etsyUserId: String(me.user_id), shopId: String(me.shop_id) };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: `etsy-${props.etsyUserId}`,
    metadata: { shopId: props.shopId },
    scope: original.scope,
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

export function makeDefaultHandler(fetchImpl?: typeof fetch) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/authorize" && request.method === "GET") return await handleAuthorizeGet(request, env);
        if (url.pathname === "/authorize" && request.method === "POST") return await handleAuthorizePost(request, env);
        if (url.pathname === ETSY_CALLBACK_PATH && request.method === "GET") {
          return await handleEtsyCallback(request, env, fetchImpl ?? fetch);
        }
        if (url.pathname === "/" || url.pathname === "/health") {
          return new Response("etsy-mcp is running. Add /mcp as a custom connector in Claude.\n", {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        if (error instanceof AuthorizationError && error.redirectTo) {
          return Response.redirect(error.redirectTo, 302);
        }
        if (error instanceof AuthorizationError) return errorPage(error.description || "This sign-in link expired. Start again from Claude.");
        if (error instanceof CimdFetchError) return errorPage("This app could not be verified.");
        throw error;
      }
    },
  };
}
