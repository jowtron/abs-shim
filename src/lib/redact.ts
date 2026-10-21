// Credential redaction shared by the admin surface (src/routes/admin.ts) and
// the internal ops page (src/routes/ops.ts). Folder `config_json` can hold
// secrets (S3 secretAccessKey, WebDAV password); neither UI ever needs to read
// them back, so strip them before they leave the Worker.

export const SECRET_CONFIG_KEYS = new Set(['secretAccessKey', 'password']);

export function safeJson(s: string | null | undefined): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

export function redactSecrets(config: unknown): unknown {
  if (!config || typeof config !== 'object') return config;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    out[k] = SECRET_CONFIG_KEYS.has(k) ? '••••••' : v;
  }
  return out;
}

// Query parameters that carry a secret, blanked in anything logged. `token`
// is an access token (Pholia and the bundled UI authenticate with ?token=, so
// it is on nearly every request, 30-day JWTs included); `sig` signs a
// /public/proxy or /public/audible-staged link, which is a pass to that file;
// `code` is pCloud's OAuth authorisation code on the callback. Until
// 2026-10-19 hono's logger wrote every URL whole into Workers Logs.
const SECRET_QUERY = /([?&](?:token|sig|code)=)[^&\s]*/gi;
// A query value that is itself a URL keeps only its scheme and host: a
// private podcast feed is pasted into search as `?q=` (the library search)
// and `?term=` (/api/search/podcast), and its path IS the subscriber's key
// (Supercast, 2026-10-21). Matches the URL encoded or not.
const URL_VALUE = /([?&][^=&\s]+=)(https?(?:%3A|:)(?:%2F|\/){2}[^%/&\s]*)[^&\s]*/gi;

export function redactUrlSecrets(s: string): string {
  return s.replace(SECRET_QUERY, '$1…').replace(URL_VALUE, '$1$2…');
}
