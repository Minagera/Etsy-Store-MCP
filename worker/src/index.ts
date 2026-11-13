// etsy-mcp as a remote MCP server on Cloudflare Workers.
//
// Routes:
//   POST /mcp                                   MCP (Streamable HTTP), needs a bearer token
//   GET  /authorize, POST /authorize            consent page, then Etsy sign-in
//   GET  /etsy/callback                         Etsy's OAuth redirect back here
//   POST /token, POST /register                 OAuth token endpoint and client registration
//   GET  /.well-known/oauth-protected-resource/mcp, /.well-known/oauth-authorization-server
//                                               discovery documents Claude reads first

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { makeDefaultHandler } from "./auth";
import { MCP_SCOPE, publicOrigin, type Env } from "./env";
import { McpApiHandler } from "./mcp";

export function buildProvider(env: Env, defaultHandler = makeDefaultHandler()): OAuthProvider<Env> {
  const origin = publicOrigin(env);
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: McpApiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [MCP_SCOPE],
    requiredScopes: [MCP_SCOPE],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Etsy Shop Manager",
    },
    clientIdMetadataDocumentEnabled: true,
    // Claude refreshes on its own. Grants stay alive while the connector is used,
    // and lapse after 60 idle days.
    accessTokenTTL: 3600,
    refreshTokenTTL: 60 * 24 * 3600,
    refreshTokenIdleTTL: 60 * 24 * 3600,
  });
}

// The provider needs absolute URLs, which come from env, so build it on first
// request and reuse it for the life of the isolate.
let cached: { origin: string; provider: OAuthProvider<Env> } | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = publicOrigin(env);
    if (!cached || cached.origin !== origin) cached = { origin, provider: buildProvider(env) };
    return cached.provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
