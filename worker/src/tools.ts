// Tool definitions and handlers, ported from the local stdio server (index.js).
//
// Differences from the local version:
// - The server is locked to one shop (ETSY_SHOP_ID). Shop-scoped tools don't
//   take a shop_id, so a tool call can't point it at someone else's shop.
// - Images and digital files come in as an https URL or base64, not a local path.
// - get_shop_listings is new: lists drafts, inactive or expired listings too.

import { defaultFetch } from "./fetch";
import { EtsyClient } from "./etsy";
import { loadFile } from "./files";

type Json = Record<string, any>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
}

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

export const TOOLS: ToolDef[] = [
  // ---- read ----
  {
    name: "ping",
    description: "Health check against the Etsy API.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "get_shop",
    description: "Get shop details. Defaults to this server's shop; pass shop_id to look up another shop.",
    inputSchema: { type: "object", properties: { shop_id: { type: "string" } } },
    annotations: READ,
  },
  {
    name: "find_shops",
    description: "Search shops by name.",
    inputSchema: {
      type: "object",
      properties: { shop_name: { type: "string" }, limit: { type: "number" } },
      required: ["shop_name"],
    },
    annotations: READ,
  },
  {
    name: "get_active_listings",
    description: "List this shop's active listings.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" }, offset: { type: "number" } },
    },
    annotations: READ,
  },
  {
    name: "get_shop_listings",
    description:
      "List this shop's listings in a given state: 'active', 'inactive', 'sold_out', 'draft' or 'expired'. Use it to find drafts that still need images or properties, or expired listings worth renewing.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["active", "inactive", "sold_out", "draft", "expired"] },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["state"],
    },
    annotations: READ,
  },
  {
    name: "get_listing",
    description: "Get a single listing by listing_id.",
    inputSchema: { type: "object", properties: { listing_id: { type: "string" } }, required: ["listing_id"] },
    annotations: READ,
  },
  {
    name: "get_listing_images",
    description: "Get the images attached to a listing.",
    inputSchema: { type: "object", properties: { listing_id: { type: "string" } }, required: ["listing_id"] },
    annotations: READ,
  },
  {
    name: "get_listing_inventory",
    description: "Get inventory (SKUs, variations, quantities) for a listing.",
    inputSchema: { type: "object", properties: { listing_id: { type: "string" } }, required: ["listing_id"] },
    annotations: READ,
  },
  {
    name: "search_taxonomy",
    description:
      "Fetch the seller taxonomy tree (category nodes). Pass a 'query' substring (e.g. 'print', 'digital') to filter node names and keep the response small; omit it only if you want the full tree, which can exceed response size limits. Pass 'parent_id' to get only one node's children.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, parent_id: { type: "number" } } },
    annotations: READ,
  },
  {
    name: "get_shipping_profiles",
    description: "List this shop's shipping profiles (needed to create a physical listing).",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "get_taxonomy_properties",
    description:
      "Get the product properties (e.g. 'Craft type', 'Occasion', 'Holiday') for a taxonomy_id, including whether each is required and its valid values with their value_ids. " +
      "Some categories (like Clip Art & Image Files) need a property set before a draft can be published. Call this after picking a taxonomy_id, then use update_listing_property.",
    inputSchema: { type: "object", properties: { taxonomy_id: { type: "number" } }, required: ["taxonomy_id"] },
    annotations: READ,
  },
  {
    name: "get_listing_properties",
    description:
      "Get the properties currently set on a listing (property_id, value_id(s)) and which required properties are still unset.",
    inputSchema: { type: "object", properties: { listing_id: { type: "string" } }, required: ["listing_id"] },
    annotations: READ,
  },

  // ---- write ----
  {
    name: "create_draft_listing",
    description:
      "Create a new draft listing. Required: title, description, price (USD, e.g. 24.99), quantity, " +
      "who_made ('i_did'|'collective'|'someone_else'), when_made (e.g. 'made_to_order', '2020_2024'), " +
      "taxonomy_id, is_supply (boolean). listing_type is 'physical' (default), 'download' or 'both'. " +
      "shipping_profile_id is required for 'physical' and 'both'; omit it for 'download'. " +
      "Shops using Etsy's production-partner readiness flow also need readiness_state_id for 'physical' or 'both'. " +
      "Drafts aren't visible until published and have no images or files yet: add them with upload_listing_image and, for 'download' or 'both', upload_listing_file.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        price: { type: "number" },
        quantity: { type: "number" },
        who_made: { type: "string", enum: ["i_did", "collective", "someone_else"] },
        when_made: { type: "string" },
        taxonomy_id: { type: "number" },
        is_supply: { type: "boolean" },
        listing_type: { type: "string", enum: ["physical", "download", "both"] },
        shipping_profile_id: { type: "number" },
        readiness_state_id: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        materials: { type: "array", items: { type: "string" } },
      },
      required: ["title", "description", "price", "quantity", "who_made", "when_made", "taxonomy_id", "is_supply"],
    },
    annotations: WRITE,
  },
  {
    name: "upload_listing_image",
    description:
      "Attach an image to a listing, from an https URL (a direct link to the image file) or base64 content. A listing needs at least one image before it can be published. Max 20 MB.",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: { type: "string" },
        image_url: { type: "string", description: "https:// direct link to the image file." },
        image_base64: { type: "string", description: "Base64 image bytes (or a data: URL), for small images." },
        file_name: { type: "string" },
        rank: { type: "number" },
        alt_text: { type: "string" },
      },
      required: ["listing_id"],
    },
    annotations: WRITE,
  },
  {
    name: "upload_listing_file",
    description:
      "Attach the digital file a buyer receives (PDF, SVG, PNG, zip, etc.) to a 'download' or 'both' listing, from an https URL (a direct download link) or base64 content. Max 20 MB.",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: { type: "string" },
        file_url: { type: "string", description: "https:// direct download link." },
        file_base64: { type: "string", description: "Base64 file bytes (or a data: URL), for small files." },
        name: { type: "string", description: "File name the buyer sees." },
        rank: { type: "number" },
      },
      required: ["listing_id"],
    },
    annotations: WRITE,
  },
  {
    name: "update_listing",
    description:
      "Update title, description, tags, or state on a listing (state 'active' publishes a draft that has at least one image or file). " +
      "Does not change price or quantity: use update_listing_price for that.",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        state: { type: "string", enum: ["active", "inactive", "draft"] },
      },
      required: ["listing_id"],
    },
    annotations: WRITE,
  },
  {
    name: "delete_listing",
    description: "Permanently delete a listing. Can't be undone.",
    inputSchema: { type: "object", properties: { listing_id: { type: "string" } }, required: ["listing_id"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "update_listing_property",
    description:
      "Set a product property on a listing (e.g. Craft type, Occasion, Color) by property_id and value_id(s). " +
      "Use get_taxonomy_properties first to find them. Pass value_ids as an array, and values as the matching display strings in the same order.",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: { type: "string" },
        property_id: { type: "number" },
        value_ids: { type: "array", items: { type: "number" } },
        values: { type: "array", items: { type: "string" } },
      },
      required: ["listing_id", "property_id", "value_ids"],
    },
    annotations: WRITE,
  },
  {
    name: "update_listing_price",
    description:
      "Change a listing's price (and optionally quantity) through the inventory endpoint, which is the only place Etsy honors price changes. " +
      "For a listing without variations, pass listing_id and price.",
    inputSchema: {
      type: "object",
      properties: { listing_id: { type: "string" }, price: { type: "number" }, quantity: { type: "number" } },
      required: ["listing_id", "price"],
    },
    annotations: WRITE,
  },
];

function id(value: unknown, field: string): string {
  const s = String(value ?? "").trim();
  if (!/^\d+$/.test(s)) throw new Error(`${field} must be a numeric Etsy ID.`);
  return s;
}

function limitParam(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 100) : fallback;
}

function offsetParam(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export async function callTool(
  name: string,
  args: Json,
  etsy: EtsyClient,
  fetchImpl: typeof fetch = defaultFetch
): Promise<unknown> {
  const shopId = etsy.shopId;
  switch (name) {
    case "ping":
      return etsy.request("/openapi-ping");

    case "get_shop":
      return etsy.request(`/shops/${args.shop_id ? id(args.shop_id, "shop_id") : shopId}`);

    case "find_shops":
      return etsy.request(
        `/shops?shop_name=${encodeURIComponent(String(args.shop_name || ""))}&limit=${limitParam(args.limit, 10)}`
      );

    case "get_active_listings":
      return etsy.request(
        `/shops/${shopId}/listings/active?limit=${limitParam(args.limit, 25)}&offset=${offsetParam(args.offset)}`
      );

    case "get_shop_listings": {
      const state = String(args.state || "");
      if (!["active", "inactive", "sold_out", "draft", "expired"].includes(state)) {
        throw new Error("state must be one of active, inactive, sold_out, draft, expired.");
      }
      return etsy.request(
        `/shops/${shopId}/listings?state=${state}&limit=${limitParam(args.limit, 25)}&offset=${offsetParam(args.offset)}`
      );
    }

    case "get_listing":
      return etsy.request(`/listings/${id(args.listing_id, "listing_id")}`);

    case "get_listing_images":
      return etsy.request(`/listings/${id(args.listing_id, "listing_id")}/images`);

    case "get_listing_inventory":
      return etsy.request(`/listings/${id(args.listing_id, "listing_id")}/inventory`);

    case "search_taxonomy": {
      const full = await etsy.request("/seller-taxonomy/nodes");
      if (!args.query && args.parent_id === undefined) return full;
      const flat: Json[] = [];
      const walk = (nodes: Json[] = []) => {
        for (const n of nodes) {
          flat.push({
            id: n.id,
            level: n.level,
            name: n.name,
            parent_id: n.parent_id,
            full_path_taxonomy_ids: n.full_path_taxonomy_ids,
          });
          if (n.children?.length) walk(n.children);
        }
      };
      walk(full.results);
      let out = flat;
      if (args.parent_id !== undefined) out = out.filter((n) => n.parent_id === Number(args.parent_id));
      if (args.query) {
        const q = String(args.query).toLowerCase();
        out = out.filter((n) => String(n.name).toLowerCase().includes(q));
      }
      return { count: out.length, results: out };
    }

    case "get_shipping_profiles":
      return etsy.request(`/shops/${shopId}/shipping-profiles`);

    case "get_taxonomy_properties":
      return etsy.request(`/seller-taxonomy/nodes/${id(args.taxonomy_id, "taxonomy_id")}/properties`);

    case "get_listing_properties": {
      const listingId = id(args.listing_id, "listing_id");
      const listing = await etsy.request(`/listings/${listingId}`);
      const taxonomyId = listing.taxonomy_id;
      const [taxonomyProps, listingProps] = await Promise.all([
        taxonomyId !== undefined && taxonomyId !== null
          ? etsy.request(`/seller-taxonomy/nodes/${taxonomyId}/properties`)
          : Promise.resolve({ results: [] }),
        etsy.request(`/shops/${shopId}/listings/${listingId}/properties`),
      ]);
      const set = new Set((listingProps.results || []).map((p: Json) => p.property_id));
      return {
        taxonomy_id: taxonomyId,
        properties: listingProps.results || [],
        missing_required: (taxonomyProps.results || [])
          .filter((p: Json) => p.is_required && !set.has(p.property_id))
          .map((p: Json) => ({ property_id: p.property_id, name: p.name })),
      };
    }

    case "create_draft_listing": {
      const listingType = args.listing_type || "physical";
      if ((listingType === "physical" || listingType === "both") && !args.shipping_profile_id) {
        throw new Error(
          `listing_type '${listingType}' requires shipping_profile_id. For a digital item, pass listing_type "download".`
        );
      }
      const form: Json = {
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
        form.shipping_profile_id = args.shipping_profile_id;
        if (args.readiness_state_id !== undefined) form.readiness_state_id = args.readiness_state_id;
      }
      return etsy.request(`/shops/${shopId}/listings`, { method: "POST", form });
    }

    case "upload_listing_image": {
      const listingId = id(args.listing_id, "listing_id");
      const file = await loadFile({ url: args.image_url, base64: args.image_base64, name: args.file_name }, fetchImpl);
      return etsy.request(`/shops/${shopId}/listings/${listingId}/images`, {
        method: "POST",
        multipart: () => {
          const form = new FormData();
          if (args.rank !== undefined && args.rank !== null) form.append("rank", String(args.rank));
          if (args.alt_text) form.append("alt_text", String(args.alt_text));
          form.append("image", new Blob([file.bytes], { type: file.contentType }), file.name);
          return form;
        },
      });
    }

    case "upload_listing_file": {
      const listingId = id(args.listing_id, "listing_id");
      const file = await loadFile({ url: args.file_url, base64: args.file_base64, name: args.name }, fetchImpl);
      return etsy.request(`/shops/${shopId}/listings/${listingId}/files`, {
        method: "POST",
        multipart: () => {
          const form = new FormData();
          if (args.rank !== undefined && args.rank !== null) form.append("rank", String(args.rank));
          form.append("name", file.name);
          form.append("file", new Blob([file.bytes], { type: file.contentType }), file.name);
          return form;
        },
      });
    }

    case "update_listing":
      return etsy.request(`/shops/${shopId}/listings/${id(args.listing_id, "listing_id")}`, {
        method: "PATCH",
        form: { title: args.title, description: args.description, tags: args.tags, state: args.state },
      });

    case "delete_listing":
      return etsy.request(`/listings/${id(args.listing_id, "listing_id")}`, { method: "DELETE" });

    case "update_listing_property": {
      const form: Json = { value_ids: args.value_ids };
      if (args.values) form.values = args.values;
      return etsy.request(
        `/shops/${shopId}/listings/${id(args.listing_id, "listing_id")}/properties/${id(args.property_id, "property_id")}`,
        { method: "PUT", form }
      );
    }

    case "update_listing_price": {
      const listingId = id(args.listing_id, "listing_id");
      const current = await etsy.request(`/listings/${listingId}/inventory`);
      const products = (current.products || []).map((p: Json) => ({
        sku: p.sku || undefined,
        property_values: p.property_values || [],
        offerings: (p.offerings || []).map((o: Json) => ({
          price: args.price,
          quantity: args.quantity !== undefined ? args.quantity : o.quantity,
          is_enabled: o.is_enabled !== false,
        })),
      }));
      return etsy.request(`/listings/${listingId}/inventory`, {
        method: "PUT",
        json: {
          products,
          price_on_property: current.price_on_property || [],
          quantity_on_property: current.quantity_on_property || [],
          sku_on_property: current.sku_on_property || [],
        },
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
