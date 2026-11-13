// The /mcp endpoint. OAuthProvider has already checked the bearer token by the
// time a request gets here; ctx.props holds what the authorization stored.
//
// Stateless Streamable HTTP: each POST gets a fresh server and transport, and
// responses come back as plain JSON. No Durable Objects needed.

import { defaultFetch } from "./fetch";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Env, GrantProps } from "./env";
import { EtsyClient, EtsyReauthRequired } from "./etsy";
import { TOOLS, callTool } from "./tools";

export const SERVER_VERSION = "2.0.0";

export function buildServer(env: Env, fetchImpl: typeof fetch = defaultFetch): Server {
  const server = new Server({ name: "etsy-mcp", version: SERVER_VERSION }, { capabilities: { tools: {} } });
  const etsy = new EtsyClient(env, fetchImpl);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as any }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const result = await callTool(name, args as Record<string, unknown>, etsy, fetchImpl, {
        repo: env.GITHUB_FILES_REPO,
        token: env.GITHUB_TOKEN,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      const message = err instanceof EtsyReauthRequired ? err.message : `Error: ${err?.message || String(err)}`;
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  return server;
}

export async function handleMcp(request: Request, env: Env, props: GrantProps | undefined): Promise<Response> {
  // Belt and braces: the grant must be for the shop this Worker is configured for.
  if (!props || String(props.shopId) !== String(env.ETSY_SHOP_ID)) {
    return new Response("This connection isn't authorized for this shop. Reconnect it in Claude.", { status: 403 });
  }

  // Stateless server: no standalone SSE stream and no sessions to end.
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  const server = buildServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const McpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleMcp(request, env, (ctx as any).props as GrantProps | undefined);
  },
};
