#!/usr/bin/env node
// etsy-mcp — MCP server for Etsy Open API v3 shop/listing management.
//
// Env vars:
//   ETSY_TOKEN          required. "<keystring>:<shared_secret>" — used as
//                       the x-api-key header on every request.
//   ETSY_OAUTH_TOKEN    optional. OAuth 2.0 access token with listings_w
//                       (and listings_r/listings_d as needed). Required
//                       for any write: creating/updating/publishing
//                       listings, uploading images, deleting listings.
//                       Without it, read-only tools still work.
//   ETSY_REFRESH_TOKEN  optional. Etsy OAuth refresh token. When set, the
//                       server automatically exchanges it for a new access
//                       token whenever a call fails on an expired token, and
//                       again proactively once the cached token nears
//                       expiry — no manual re-run of the OAuth script needed.
//                       Etsy rotates the refresh token on every use; the new
//                       one is cached alongside the new access token.
//   ETSY_SHOP_ID        optional. Default shop_id so tools don't need it
//                       passed in every call.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE_URL = "https://openapi.etsy.com/v3/application";
const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";

const ETSY_TOKEN = process.env.ETSY_TOKEN;
const DEFAULT_SHOP_ID = process.env.ETSY_SHOP_ID || "";
const KEYSTRING = (ETSY_TOKEN || "").split(":")[0];

// The token cache lives next to this script on disk, not in an env var, so a
// refreshed token survives past this process — Claude Desktop only reads
// env vars once at launch, so writing back to process.env alone would be
// lost on the next restart. Config-provided tokens seed the cache on first
// run; after that, the cache file is the source of truth.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_CACHE_PATH = path.join(__dirname, ".etsy-token-cache.json");

let tokenCache = null; // { access_token, refresh_token, expires_at (ms epoch) }

async function loadTokenCache() {
  if (tokenCache) return tokenCache;
  try {
    const raw = await readFile(TOKEN_CACHE_PATH, "utf8");
    tokenCache = JSON.parse(raw);
  } catch {
    // No cache yet — seed from the config-provided env vars, if present.
    const accessToken = process.env.ETSY_OAUTH_TOKEN || "";
    const refreshToken = process.env.ETSY_REFRESH_TOKEN || "";
    tokenCache = accessToken || refreshToken
      ? { access_token: accessToken, refresh_token: refreshToken, expires_at: 0 }
      : null;
  }
  return tokenCache;
}

async function saveTokenCache(cache) {
  tokenCache = cache;
  try {
    await writeFile(TOKEN_CACHE_PATH, JSON.stringify(cache, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    console.error(`[etsy-mcp] warning: could not persist token cache: ${err.message}`);
  }
}

async function refreshAccessToken() {
  const cache = await loadTokenCache();
  if (!cache || !cache.refresh_token) {
    throw new Error(
      "No ETSY_REFRESH_TOKEN available to refresh with. Re-run the OAuth authorization script once to seed a refresh token, then set it in this extension's config."
    );
  }
  if (!KEYSTRING) {
    throw new Error("ETSY_TOKEN is not set — cannot refresh without the keystring (client_id).");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: KEYSTRING,
    refresh_token: cache.refresh_token,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Etsy token refresh failed: ${res.status} ${JSON.stringify(json)}`);
  }
  const expiresAt = Date.now() + (json.expires_in ? json.expires_in * 1000 : 3600 * 1000);
  const newCache = {
    access_token: json.access_token,
    // Etsy rotates the refresh token on every use — always save the new one.
    refresh_token: json.refresh_token || cache.refresh_token,
    expires_at: expiresAt,
  };
  await saveTokenCache(newCache);
  console.error("[etsy-mcp] access token refreshed automatically, valid until " + new Date(expiresAt).toISOString());
  return newCache.access_token;
}

// Returns a valid access token, refreshing first if the cached one is
// missing, expired, or within 5 minutes of expiring.
async function getValidAccessToken() {
  const cache = await loadTokenCache();
  if (!cache) return "";
  const fiveMinutes = 5 * 60 * 1000;
  if (!cache.access_token || Date.now() > cache.expires_at - fiveMinutes) {
    if (!cache.refresh_token) {
      // No refresh token on file — fall back to whatever access token we
      // have (possibly expired); the caller's own 401 handling covers this.
      return cache.access_token || "";
    }
    return refreshAccessToken();
  }
  return cache.access_token;
}

if (!ETSY_TOKEN) {
  console.error(
    "[etsy-mcp] ETSY_TOKEN is not set. Set it to '<keystring>:<shared_secret>' in this server's env block."
  );
}

function shop(shopId) {
  const id = shopId || DEFAULT_SHOP_ID;
  if (!id) {
    throw new Error(
      "No shop_id provided and ETSY_SHOP_ID is not set as a default. Pass shop_id explicitly."
    );
  }
  return id;
}

async function authHeaders({ needsWrite = false } = {}) {
  const headers = { "x-api-key": ETSY_TOKEN };
  const accessToken = await getValidAccessToken();
  if (needsWrite && !accessToken) {
    throw new Error(
      "This action requires an OAuth access token (with the relevant scope). " +
        "ETSY_TOKEN alone (the API key) does not cover this endpoint. Set ETSY_OAUTH_TOKEN and, ideally, ETSY_REFRESH_TOKEN in this extension's config."
    );
  }
  // Etsy's scope requirements per-endpoint don't cleanly split along
  // read/write lines (e.g. shipping-profiles needs shops_r on the OAuth
  // token even though it's a GET). Attach the bearer token whenever we
  // have one, on every call, so a missing scope surfaces as Etsy's own
  // 401/403 rather than us silently omitting the header.
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  return headers;
}

async function etsyFetch(path, { method = "GET", needsWrite = false, body, isForm = false, _retried = false } = {}) {
  const headers = await authHeaders({ needsWrite });
  const opts = { method, headers };

  if (body && isForm) {
    // application/x-www-form-urlencoded, as Etsy's write endpoints expect
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) form.append(`${k}[]`, item);
      } else {
        form.append(k, v);
      }
    }
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = form;
  } else if (body) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    // If the access token itself expired mid-flight (cache said valid but
    // Etsy disagrees — clock skew, or a token invalidated early), refresh
    // once and retry the same call rather than surfacing a stale-token
    // error the caller can't do anything about.
    const looksExpired =
      res.status === 401 &&
      (json?.error === "invalid_token" || /expired/i.test(json?.error_description || ""));
    if (looksExpired && !_retried) {
      const cache = await loadTokenCache();
      if (cache && cache.refresh_token) {
        await refreshAccessToken();
        return etsyFetch(path, { method, needsWrite, body, isForm, _retried: true });
      }
    }
    throw new Error(`Etsy API ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function etsyUploadImage(shopId, listingId, imagePath, opts = {}) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error(
      "Image upload requires an OAuth access token with listings_w scope. Set ETSY_OAUTH_TOKEN (and ETSY_REFRESH_TOKEN) in this extension's config."
    );
  }
  const fileBuffer = await readFile(imagePath);
  const form = new FormData();
  if (opts.rank !== undefined && opts.rank !== null) form.append("rank", String(opts.rank));
  if (opts.alt_text) form.append("alt_text", opts.alt_text);
  const fileName = imagePath.split(/[\\/]/).pop() || "image";
  form.append("image", new Blob([fileBuffer]), fileName);

  const headers = await authHeaders({ needsWrite: true });
  // Do not set Content-Type manually — fetch sets the multipart boundary.
  const res = await fetch(
    `${BASE_URL}/shops/${shopId}/listings/${listingId}/images`,
    { method: "POST", headers, body: form }
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Etsy API ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

const TOOLS = [
  // ---- read (ETSY_TOKEN / API key only) ----
  {
    name: "ping",
    description: "Health check against the Etsy API.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_shop",
    description: "Get shop details by shop_id (defaults to ETSY_SHOP_ID if omitted).",
    inputSchema: {
      type: "object",
      properties: { shop_id: { type: "string" } },
    },
  },
  {
    name: "find_shops",
    description: "Search shops by name.",
    inputSchema: {
      type: "object",
      properties: {
        shop_name: { type: "string" },
        limit: { type: "number" },
      },
      required: ["shop_name"],
    },
  },
  {
    name: "get_active_listings",
    description: "List active listings for a shop.",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "get_listing",
    description: "Get a single listing by listing_id.",
    inputSchema: {
      type: "object",
      properties: { listing_id: { type: "string" } },
      required: ["listing_id"],
    },
  },
  {
    name: "get_listing_images",
    description: "Get the images attached to a listing.",
    inputSchema: {
      type: "object",
      properties: { listing_id: { type: "string" } },
      required: ["listing_id"],
    },
  },
  {
    name: "get_listing_inventory",
    description: "Get inventory (SKUs, variations, quantities) for a listing.",
    inputSchema: {
      type: "object",
      properties: { listing_id: { type: "string" } },
      required: ["listing_id"],
    },
  },
  {
    name: "search_taxonomy",
    description:
      "Fetch the seller taxonomy tree (category nodes). No auth beyond the API key. Pass a 'query' substring (e.g. 'print', 'digital') to filter node names client-side and keep the response small — omit it only if you actually want the full tree, which can exceed response size limits. Pass 'parent_id' to fetch only a specific node's children instead of the whole tree.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        parent_id: { type: "number" },
      },
    },
  },
  {
    name: "get_shipping_profiles",
    description: "List a shop's shipping profiles (needed to create a physical listing).",
    inputSchema: {
      type: "object",
      properties: { shop_id: { type: "string" } },
    },
  },
  {
    name: "get_taxonomy_properties",
    description:
      "Get the product properties (e.g. 'Craft type', 'Occasion', 'Holiday') supported for a taxonomy_id, including whether each is required and its valid values with their value_ids. " +
      "Some categories (like Clip Art & Image Files) require at least one property set before a draft can be published. Call this after picking a taxonomy_id in create_draft_listing to find out what else the listing needs, then use update_listing_property to set it.",
    inputSchema: {
      type: "object",
      properties: { taxonomy_id: { type: "number" } },
      required: ["taxonomy_id"],
    },
  },
  {
    name: "get_listing_properties",
    description: "Get the properties currently set on a listing (property_id, current value_id(s), and which properties are still required but unset).",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string" },
        listing_id: { type: "string" },
      },
      required: ["listing_id"],
    },
  },

  // ---- write (require ETSY_OAUTH_TOKEN with listings_w) ----
  {
    name: "create_draft_listing",
    description:
      "Create a new draft listing. Required: title, description, price (USD, e.g. 24.99), quantity, " +
      "who_made ('i_did'|'collective'|'someone_else'), when_made (e.g. 'made_to_order', '2020_2024'), " +
      "taxonomy_id, is_supply (boolean), listing_type ('physical'|'download'|'both'). " +
      "shipping_profile_id is required when listing_type is 'physical' or 'both'; omit it for 'download'. " +
      "Draft listings are not visible until published and have no images or digital files yet — " +
      "for a 'download' or 'both' listing, attach the deliverable file with upload_listing_file after creating the draft.",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        price: { type: "number" },
        quantity: { type: "number" },
        who_made: { type: "string", enum: ["i_did", "collective", "someone_else"] },
        when_made: { type: "string" },
        taxonomy_id: { type: "number" },
        is_supply: { type: "boolean" },
        listing_type: {
          type: "string",
          enum: ["physical", "download", "both"],
          description:
            "'physical' (default if omitted, matching Etsy's own API default) requires shipping_profile_id. " +
            "'download' is a pure digital listing — no shipping profile, no readiness state. " +
            "'both' offers a physical version and a digital version of the same listing and needs shipping_profile_id too.",
        },
        shipping_profile_id: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        materials: { type: "array", items: { type: "string" } },
      },
      required: [
        "title",
        "description",
        "price",
        "quantity",
        "who_made",
        "when_made",
        "taxonomy_id",
        "is_supply",
      ],
    },
  },
  {
    name: "upload_listing_image",
    description:
      "Upload an image file (local path) to a draft or active listing. A listing needs at least one image before it can be published.",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string" },
        listing_id: { type: "string" },
        image_path: { type: "string" },
        rank: { type: "number" },
        alt_text: { type: "string" },
      },
      required: ["listing_id", "image_path"],
    },
  },
  {
    name: "upload_listing_file",
    description:
      "Upload a digital file (local path) to a 'download' or 'both' listing — the actual file the buyer receives on purchase " +
      "(PDF, SVG, PNG, zip, etc). A 'download' listing needs at least one file before it can be published, the same way a " +
      "physical listing needs at least one image.",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string" },
        listing_id: { type: "string" },
        file_path: { type: "string" },
        name: { type: "string" },
        rank: { type: "number" },
      },
      required: ["listing_id", "file_path"],
    },
  },
  {
    name: "update_listing",
    description:
      "Update title, description, tags, or state on an existing listing (e.g. state: 'active' to publish a draft that has at least one image/file). " +
      "Does NOT change price or quantity: Etsy silently ignores those two fields here for most listings. Use update_listing_price instead for a price or quantity change.",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string" },
        listing_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        state: { type: "string", enum: ["active", "inactive", "draft"] },
      },
      required: ["listing_id"],
    },
  },
  {
    name: "delete_listing",
    description: "Permanently delete a listing. Requires listings_d scope on the OAuth token.",
    inputSchema: {
      type: "object",
      properties: { listing_id: { type: "string" } },
      required: ["listing_id"],
    },
  },
  {
    name: "update_listing_property",
    description:
      "Set a required or optional product property on a listing (e.g. Craft type, Occasion, Holiday, Color, Size), by property_id and value_id(s). " +
      "Use get_taxonomy_properties first to find the property_id and the value_id for the value you want (e.g. Craft type -> 'Cardmaking & Scrapbooking', 'Printmaking', etc). " +
      "Pass value_ids as an array (most properties accept multiple selected values, up to a per-property max); pass values as an array of the matching display strings in the same order.",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string" },
        listing_id: { type: "string" },
        property_id: { type: "number" },
        value_ids: { type: "array", items: { type: "number" } },
        values: { type: "array", items: { type: "string" } },
      },
      required: ["listing_id", "property_id", "value_ids"],
    },
  },
  {
    name: "update_listing_price",
    description:
      "Update the price of a listing (and optionally quantity) through the correct inventory endpoint. " +
      "update_listing's own price/quantity fields are silently ignored by Etsy for most listings; Etsy's API only honors price changes through the listing's inventory/offerings, which this tool handles for you. " +
      "For a simple, no-variation listing this is a drop-in price change: pass just listing_id and price (and quantity if you want to change it too).",
    inputSchema: {
      type: "object",
      properties: {
        shop_id: { type: "string" },
        listing_id: { type: "string" },
        price: { type: "number" },
        quantity: { type: "number" },
      },
      required: ["listing_id", "price"],
    },
  },
];

const server = new Server(
  { name: "etsy-mcp", version: "1.4.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    switch (name) {
      case "ping":
        result = await etsyFetch("/openapi-ping");
        break;

      case "get_shop":
        result = await etsyFetch(`/shops/${shop(args.shop_id)}`);
        break;

      case "find_shops":
        result = await etsyFetch(
          `/shops?shop_name=${encodeURIComponent(args.shop_name)}&limit=${args.limit || 10}`
        );
        break;

      case "get_active_listings":
        result = await etsyFetch(
          `/shops/${shop(args.shop_id)}/listings/active?limit=${args.limit || 25}`
        );
        break;

      case "get_listing":
        result = await etsyFetch(`/listings/${args.listing_id}`);
        break;

      case "get_listing_images":
        result = await etsyFetch(`/listings/${args.listing_id}/images`);
        break;

      case "get_listing_inventory":
        result = await etsyFetch(`/listings/${args.listing_id}/inventory`);
        break;

      case "search_taxonomy": {
        const full = await etsyFetch("/seller-taxonomy/nodes");
        if (!args.query && args.parent_id === undefined) {
          // No filter requested — warn rather than silently returning
          // a payload that may blow the caller's size limit.
          result = full;
          break;
        }
        const flatten = (nodes, acc = []) => {
          for (const n of nodes || []) {
            acc.push({
              id: n.id,
              level: n.level,
              name: n.name,
              parent_id: n.parent_id,
              full_path_taxonomy_ids: n.full_path_taxonomy_ids,
            });
            if (n.children && n.children.length) flatten(n.children, acc);
          }
          return acc;
        };
        let flat = flatten(full.results);
        if (args.parent_id !== undefined) {
          flat = flat.filter((n) => n.parent_id === args.parent_id);
        }
        if (args.query) {
          const q = args.query.toLowerCase();
          flat = flat.filter((n) => n.name.toLowerCase().includes(q));
        }
        result = { count: flat.length, results: flat };
        break;
      }

      case "get_shipping_profiles":
        result = await etsyFetch(`/shops/${shop(args.shop_id)}/shipping-profiles`, {
          needsWrite: true,
        });
        break;

      case "get_taxonomy_properties":
        result = await etsyFetch(`/seller-taxonomy/nodes/${args.taxonomy_id}/properties`);
        break;

      case "get_listing_properties":
        result = await etsyFetch(
          `/shops/${shop(args.shop_id)}/listings/${args.listing_id}/properties`,
          { needsWrite: true }
        );
        break;

      case "create_draft_listing": {
        // Mirror Etsy's own API default (physical) when the caller doesn't
        // specify — but do it explicitly so the body always states its
        // listing_type instead of relying on Etsy's implicit default,
        // which is what silently produced "physical" before this field
        // existed on this tool at all.
        const listingType = args.listing_type || "physical";
        if ((listingType === "physical" || listingType === "both") && !args.shipping_profile_id) {
          throw new Error(
            `listing_type '${listingType}' requires shipping_profile_id. ` +
              `For a pure digital item, pass listing_type: "download" instead (no shipping profile needed).`
          );
        }
        const body = {
          quantity: args.quantity,
          title: args.title,
          description: args.description,
          price: args.price,
          who_made: args.who_made,
          when_made: args.when_made,
          taxonomy_id: args.taxonomy_id,
          is_supply: args.is_supply,
          type: listingType,
          tags: args.tags,
          materials: args.materials,
        };
        if (listingType !== "download") {
          body.shipping_profile_id = args.shipping_profile_id;
        }
        result = await etsyFetch(`/shops/${shop(args.shop_id)}/listings`, {
          method: "POST",
          needsWrite: true,
          isForm: true,
          body,
        });
        break;
      }

      case "upload_listing_image":
        result = await etsyUploadImage(
          shop(args.shop_id),
          args.listing_id,
          args.image_path,
          { rank: args.rank, alt_text: args.alt_text }
        );
        break;

      case "upload_listing_file": {
        const accessToken = await getValidAccessToken();
        if (!accessToken) {
          throw new Error(
            "File upload requires an OAuth access token with listings_w scope. Set ETSY_OAUTH_TOKEN (and ETSY_REFRESH_TOKEN) in this extension's config."
          );
        }
        const fileBuffer = await readFile(args.file_path);
        const form = new FormData();
        if (args.rank !== undefined && args.rank !== null) form.append("rank", String(args.rank));
        const fileName = args.name || args.file_path.split(/[\\/]/).pop() || "file";
        form.append("name", fileName);
        form.append("file", new Blob([fileBuffer]), fileName);

        const headers = await authHeaders({ needsWrite: true });
        const res = await fetch(
          `${BASE_URL}/shops/${shop(args.shop_id)}/listings/${args.listing_id}/files`,
          { method: "POST", headers, body: form }
        );
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text };
        }
        if (!res.ok) {
          throw new Error(`Etsy API ${res.status}: ${JSON.stringify(json)}`);
        }
        result = json;
        break;
      }

      case "update_listing": {
        const body = {
          title: args.title,
          description: args.description,
          tags: args.tags,
          state: args.state,
        };
        result = await etsyFetch(
          `/shops/${shop(args.shop_id)}/listings/${args.listing_id}`,
          { method: "PATCH", needsWrite: true, isForm: true, body }
        );
        break;
      }

      case "delete_listing":
        result = await etsyFetch(`/listings/${args.listing_id}`, {
          method: "DELETE",
          needsWrite: true,
        });
        break;

      case "update_listing_property": {
        const body = {
          value_ids: args.value_ids,
        };
        if (args.values) body.values = args.values;
        result = await etsyFetch(
          `/shops/${shop(args.shop_id)}/listings/${args.listing_id}/properties/${args.property_id}`,
          { method: "PUT", needsWrite: true, isForm: true, body }
        );
        break;
      }

      case "update_listing_price": {
        // Etsy ignores price/quantity sent to the plain listing PATCH endpoint;
        // price only actually changes through the listing's inventory/offerings.
        const current = await etsyFetch(
          `/listings/${args.listing_id}/inventory`,
          { needsWrite: true }
        );
        const products = (current.products || []).map((p) => ({
          sku: p.sku || undefined,
          property_values: p.property_values || [],
          offerings: (p.offerings || []).map((o) => ({
            price: args.price,
            quantity: args.quantity !== undefined ? args.quantity : o.quantity,
            is_enabled: o.is_enabled !== false,
          })),
        }));
        result = await etsyFetch(
          `/listings/${args.listing_id}/inventory`,
          {
            method: "PUT",
            needsWrite: true,
            body: {
              products,
              price_on_property: current.price_on_property || [],
              quantity_on_property: current.quantity_on_property || [],
              sku_on_property: current.sku_on_property || [],
            },
          }
        );
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[etsy-mcp] server running on stdio, version 1.4.0");
