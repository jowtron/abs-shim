export type Env = {
  DB: D1Database;
  SESSION: DurableObjectNamespace;
  ASSETS: Fetcher; // Cloudflare static-assets binding for the bundled ABS web UI.
  // Secrets (set via `wrangler secret put`):
  JWT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PCLOUD_CLIENT_ID?: string;
  PCLOUD_CLIENT_SECRET?: string;
  // Optional override for the worker's public origin. Used as a fallback
  // when minting proxy URLs outside of a request context (e.g. scheduled
  // scans). Normally we derive the origin from the incoming request URL.
  PUBLIC_ORIGIN?: string;
};
