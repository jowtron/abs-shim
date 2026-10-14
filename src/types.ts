export type Env = {
  DB: D1Database;
  SESSION: DurableObjectNamespace;
  // Per-IP signup throttle — see src/do/signup-limiter.ts.
  SIGNUP_LIMITER: DurableObjectNamespace;
  // Server-side zip extraction jobs — see src/do/archive-extract.ts.
  ARCHIVE_EXTRACT: DurableObjectNamespace;
  ASSETS: Fetcher; // Cloudflare static-assets binding for the bundled ABS web UI.
  COVERS: R2Bucket; // Persistent cover cache — see src/routes/items.ts.
  // wharf-router service binding + its bearer (secret) — the Audible
  // importer submits jobs through it; see src/lib/wharf.ts. Optional: the
  // Audible routes answer 503 when either is missing.
  WHARF_ROUTER?: Fetcher;
  ROUTER_TOKEN?: string;
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
  // Shared key the wharf nodes send with their hourly pCloud-token report
  // (POST /api/node-health, ops/pcloud-health/). Unset = the route answers 503.
  NODE_HEALTH_KEY?: string;
  // Web Push (src/lib/push.ts): the VAPID pair new-episode notifications are
  // signed with. Public = base64url 65-byte uncompressed P-256 point, private
  // = base64url 32-byte scalar. Unset = /api/push/status says configured:
  // false. NEVER rotate once devices have subscribed (see pushConfig).
  // VAPID_SUBJECT overrides the JWT's `sub` (default the shim's https URL).
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  // Cloudflare Email Sending (the send_email binding): password-reset links
  // and the notices that go with them (src/lib/email.ts). jderrick.app is
  // onboarded on this account (the PBX's voicemail mail uses it), so the
  // From address must be on it. Loosely typed like cf-pbx's, and optional:
  // without it "Forgot password?" says this server can't send email.
  EMAIL?: { send(message: {
    to: string | string[];
    from: { email: string; name?: string };
    replyTo?: string;
    subject: string;
    html?: string;
    text?: string;
  }): Promise<unknown> };
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
};
