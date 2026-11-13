import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /**
   * One KV namespace for everything this Worker stores: the OAuth provider's
   * clients, grants and hashed tokens, plus the Etsy token pair under the
   * `etsy:` prefix.
   */
  OAUTH_KV: KVNamespace;

  /** Secret. "<keystring>:<shared_secret>" from the Etsy developer portal. */
  ETSY_TOKEN: string;

  /** Var. The only Etsy shop this server will act on, e.g. "12345678". */
  ETSY_SHOP_ID: string;

  /**
   * Var. The public origin this Worker is served from, no trailing slash,
   * e.g. "https://etsy-mcp.example.workers.dev". OAuth metadata and the Etsy
   * callback URL are built from it, so it has to match the real address.
   */
  PUBLIC_URL: string;

  /** Var, optional. Space-separated Etsy OAuth scopes to request. */
  ETSY_SCOPES?: string;

  /**
   * Var, optional. "owner/repo" of the one private GitHub repo that
   * upload_listing_file and upload_listing_image may read with github_path.
   */
  GITHUB_FILES_REPO?: string;

  /** Secret, optional. GitHub token that can read GITHUB_FILES_REPO. Only used for github_path. */
  GITHUB_TOKEN?: string;

  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** What a completed authorization stores with the grant (encrypted by the library). */
export interface GrantProps {
  etsyUserId: string;
  shopId: string;
}

export const DEFAULT_ETSY_SCOPES = "listings_r listings_w listings_d shops_r";
export const MCP_SCOPE = "etsy:shop";

export function publicOrigin(env: Env): string {
  const raw = (env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("PUBLIC_URL is not set in wrangler.jsonc vars.");
  return raw;
}
