export type Env = {
  DB: D1Database;
  SESSION: DurableObjectNamespace;
  // Per-IP signup throttle — see src/do/signup-limiter.ts.
  SIGNUP_LIMITER: DurableObjectNamespace;
  // Server-side zip extraction jobs — see src/do/archive-extract.ts.
  ARCHIVE_EXTRACT: DurableObjectNamespace;
  ASSETS: Fetcher; // Cloudflare static-assets binding for the bundled ABS web UI.
  COVERS: R2Bucket; // Persistent cover cache — see src/routes/items.ts.
  // Secrets (set via `wrangler secret put`):
  JWT_SECRET?: string;
  // AES-256-GCM key (base64, 32 bytes) for per-tenant secrets in D1 — see src/lib/secret-box.ts.
  SETTINGS_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PCLOUD_CLIENT_ID?: string;
  PCLOUD_CLIENT_SECRET?: string;
  // Optional override for the worker's public origin. Used as a fallback
  // when minting proxy URLs outside of a request context (e.g. scheduled
  // scans). Normally we derive the origin from the incoming request URL.
  PUBLIC_ORIGIN?: string;
  // Internal ops page (/ops) — gated by Cloudflare Access. See src/ops/access.ts.
  // OPS_ALLOWED_EMAILS: comma-separated allowlist of CF-Access emails.
  // OPS_ACCESS_TEAM_DOMAIN: <team>.cloudflareaccess.com (for the JWKS + issuer).
  // OPS_ACCESS_AUD: the Access application's AUD tag (audience claim to require).
  OPS_ALLOWED_EMAILS?: string;
  OPS_ACCESS_TEAM_DOMAIN?: string;
  OPS_ACCESS_AUD?: string;
  // Cloudflare Turnstile (bot defense on the public signup form). SITE_KEY is
  // public (embedded in the form); SECRET is server-side (siteverify). When
  // unset, Turnstile is simply not enforced. See src/lib/notify.ts.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  // Pushover (notify the owner when someone requests access). When unset, no
  // notification is sent. PUSHOVER_TOKEN = app token, PUSHOVER_USER_KEY = user.
  PUSHOVER_TOKEN?: string;
  PUSHOVER_USER_KEY?: string;
};
