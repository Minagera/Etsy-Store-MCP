# Etsy Store MCP

An MCP (Model Context Protocol) server that connects Claude to the [Etsy Open
API v3](https://developers.etsy.com/documentation/) for your own shop —
search and manage listings, set required category attributes, fix prices
through the correct endpoint, upload images and digital files, and publish,
all as tools Claude can call directly.

## Features

- **Digital and physical listings** — `create_draft_listing` takes an
  explicit `listing_type` (`physical` | `download` | `both`), so digital
  goods don't get stuck behind a `shipping_profile_id` requirement that only
  applies to physical items.
- **Category properties** — `get_taxonomy_properties`, `get_listing_properties`,
  and `update_listing_property` handle categories (e.g. Clip Art & Image
  Files) that reject publishing until a required attribute like "Craft type"
  is set.
- **Price updates that actually work** — `update_listing_price` goes through
  Etsy's inventory/offerings endpoint, since the plain listing PATCH endpoint
  silently ignores `price` and `quantity` for most listings.
- **Automatic OAuth token refresh** — once you provide a refresh token, the
  server refreshes its own access token proactively before it expires and
  reactively on a 401, persisting the rotated token to a local cache file so
  you don't have to re-run the OAuth script by hand.
- **Filterable taxonomy search** — `search_taxonomy` accepts an optional
  `query`/`parent_id` filter instead of always pulling the entire category
  tree.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get Etsy API credentials

1. Create an app in the [Etsy Developer Portal](https://www.etsy.com/developers/your-apps)
   to get an API key (`keystring` and `shared_secret`).
2. Run Etsy's OAuth 2.0 authorization flow once to get an access token and
   refresh token with the scopes you need (`listings_r`, `listings_w`,
   `shops_r`, and `listings_d` if you want `delete_listing`).

### 3. Configure environment variables

| Variable             | Required | Description |
|-----------------------|----------|-------------|
| `ETSY_TOKEN`           | Yes      | `<keystring>:<shared_secret>` from your app, joined with a colon. Sent as the `x-api-key` header on every request; the keystring half also acts as `client_id` for token refresh. |
| `ETSY_OAUTH_TOKEN`     | No       | OAuth access token with `listings_w` (and `listings_r`/`shops_r`/`listings_d` as needed). Required for any write, and for a few reads Etsy itself scopes to OAuth (shipping profiles, listing properties). Only used to seed the token cache on first run if `ETSY_REFRESH_TOKEN` is also set. |
| `ETSY_REFRESH_TOKEN`   | No       | Enables automatic token refresh. When set, the server keeps its access token fresh on its own — see below. |
| `ETSY_SHOP_ID`         | No       | Default shop ID, so you don't need to pass `shop_id` on every call. |

### 4. Run

```bash
node index.js
```

The server speaks MCP over stdio. Point your MCP client (e.g. Claude
Desktop, or a `claude_desktop_config.json` entry) at `node index.js` in this
directory, or package it as a `.dxt` extension using `manifest.json`.

## Automatic token refresh

If you set `ETSY_REFRESH_TOKEN`, the server maintains its own token cache at
`.etsy-token-cache.json` next to `index.js`. It refreshes the access token:

- **proactively**, within 5 minutes of the cached token's expiry, and
- **reactively**, if a call ever comes back with an expired/invalid token
  error, retrying that call once with the new token.

Etsy rotates the refresh token on every use, so the newly issued refresh
token is saved back to the cache each time. Concurrent tool calls that all
observe a near-expiry token share a single in-flight refresh instead of each
triggering their own, which would otherwise race against Etsy's rotation.

**`.etsy-token-cache.json` holds a live, working OAuth token pair once the
server has run. It is gitignored — never commit it.** Anyone with that file
can act on your shop until the tokens are revoked.

Without `ETSY_REFRESH_TOKEN`, the server falls back to the static
`ETSY_OAUTH_TOKEN`, which you'll need to refresh yourself once it expires
(Etsy access tokens are typically valid for about an hour).

## Available tools

**Read (API key only, unless noted):**

- `ping` — health check against the Etsy API.
- `get_shop`, `find_shops` — shop lookup and search.
- `get_active_listings`, `get_listing`, `get_listing_images`,
  `get_listing_inventory` — listing lookup.
- `search_taxonomy` — seller taxonomy tree, filterable by `query`/`parent_id`.
- `get_taxonomy_properties` — required/optional product properties for a
  taxonomy category, with their valid values.
- `get_shipping_profiles` *(requires OAuth, `shops_r`)* — a shop's shipping
  profiles.
- `get_listing_properties` *(requires OAuth)* — properties currently set on
  a listing, plus which required properties are still missing.

**Write (require an OAuth access token with `listings_w`):**

- `create_draft_listing` — create a physical, digital, or combined draft
  listing.
- `upload_listing_image` — attach an image to a listing.
- `upload_listing_file` — attach the digital deliverable to a `download`/
  `both` listing.
- `update_listing` — update title, description, tags, or state (e.g.
  publish a draft). Does not change price/quantity — use
  `update_listing_price` instead.
- `update_listing_price` — change price (and optionally quantity) through
  the listing's inventory/offerings endpoint.
- `update_listing_property` — set a required or optional product property
  (e.g. Craft type, Occasion, Color).
- `delete_listing` *(requires `listings_d`)* — permanently delete a listing.

## Security notes

- Never commit `ETSY_TOKEN`, `ETSY_OAUTH_TOKEN`, `ETSY_REFRESH_TOKEN`, or
  `.etsy-token-cache.json`. All are gitignored by default in this repo.
- If a refresh or access token is ever exposed (e.g. pasted into a chat or
  committed by mistake), revoke it from the Etsy Developer Portal and
  re-run the OAuth flow immediately.
