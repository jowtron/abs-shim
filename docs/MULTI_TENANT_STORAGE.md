# Multi-tenant cloud storage architecture

## Goal

Run ABS_shim as a SaaS that hosts the API + UI on Cloudflare and lets each
tenant (a household, a small group, an individual) point at **their own** cloud
storage holding **their own** audiobook files. We never touch the bytes; we
broker metadata + 302 redirects to the user's storage.

## Non-goals

- Hosting audio files ourselves. Audiobooks are large; CF egress + storage
  isn't free; users typically already have files somewhere.
- Transcoding or per-format conversion.
- Custom domains per tenant in the MVP (each tenant uses a path prefix on a
  shared `*.audioshim.example` host until paid tier adds custom domains).

## Storage adapter contract

A storage adapter is a small interface; the shim invokes it once per audio
request. Adapters never see user data; they only know "given a relative path
inside a tenant's folder, return a URL the audio client can fetch directly."

```ts
interface StorageAdapter {
  // Generate a URL the client can stream from. The Worker 302-redirects to
  // this URL — bytes never traverse our infrastructure. May be a long-lived
  // public URL or a freshly-signed short-lived one.
  resolveUrl(relPath: string): Promise<{ url: string; expiresAt?: number }>;

  // Same as resolveUrl, but the URL is used by the prober for HTTP Range
  // requests against the moov atom. For most adapters this is the same URL.
  resolveProbeUrl(relPath: string): Promise<{ url: string; expiresAt?: number }>;
}
```

Per-tenant config is one row in D1:

```sql
CREATE TABLE tenant_storage (
  tenant_id          TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,         -- 'public_url' | 'r2' | 's3' | 'b2' | 'pcloud_filedn' | 'dropbox' | …
  config_json        TEXT NOT NULL,         -- adapter-specific (base URL, OAuth tokens, region, bucket)
  display_name       TEXT,
  created_at         INTEGER NOT NULL,
  last_verified_at   INTEGER
);
```

## Tier 1: public-URL providers (MVP)

These all work with one shape: a public base URL + relative paths.

| Provider | Base URL pattern | Range? | Setup |
|---|---|---|---|
| pCloud public folder | `https://filedn.com/<token>/<folder>/` | ✅ | Toggle "public folder" in pCloud UI; copy URL |
| **Cloudflare R2** | `https://<custom-domain>/` (preferred) or `https://pub-<id>.r2.dev/` | ✅ | Create bucket → make public → set up domain |
| Backblaze B2 | `https://f000.backblazeb2.com/file/<bucket>/` or custom CDN | ✅ | Bucket type "public" |
| AWS S3 (website mode) | `https://<bucket>.s3-website-<region>.amazonaws.com/` | ✅ | Static website hosting + public read policy |
| Google Cloud Storage | `https://storage.googleapis.com/<bucket>/` | ✅ | Uniform bucket-level access, public read |
| Wasabi | S3-compatible URL | ✅ | Same as S3 |

The "public_url" adapter is six lines:

```ts
class PublicUrlAdapter implements StorageAdapter {
  constructor(private base: string) {}
  resolveUrl(rel: string)      { return Promise.resolve({ url: this.join(rel) }); }
  resolveProbeUrl(rel: string) { return Promise.resolve({ url: this.join(rel) }); }
  private join(rel: string)    { return new URL(rel, this.base).toString(); }
}
```

**One single adapter covers ~80% of the practical user base** because R2,
B2, S3, GCS, pCloud-filedn all just need a base URL.

### Tenant signup flow for Tier 1

1. Pick provider (each card links to a 30-second screencast walking through
   the provider's "make a public folder" UX).
2. Paste the resulting base URL.
3. Shim probes one known file (e.g. user uploads a 1KB `verify.txt`,
   shim fetches it via Range) to confirm CORS-free + Range-supported.
4. Done. Library scan begins.

### Why not OAuth for these?

Each of R2/S3/B2/GCS *does* have an API and signed URLs. We could integrate
all of them, but:
- It's per-provider code we'd have to maintain.
- Per-request signing is a CPU/latency cost we don't currently need.
- Public URLs work and the user already has the cloud account configured.

The trade-off the user accepts: their audiobook folder is publicly readable.
Acceptable for most personal libraries; a paid tier could add signed URLs
later.

## Tier 2: OAuth-only providers (Phase 2)

These don't expose stable public URLs — share links are throttled,
short-lived, or don't support Range:

- **Dropbox** — `dropbox.com/scl/...` share links don't honour Range
  reliably; the API gives temporary direct URLs.
- **Google Drive** — public file links don't stream cleanly; requires
  OAuth + per-request `files.get?alt=media`.
- **OneDrive / SharePoint** — public links work for download but not range;
  Graph API with OAuth is needed.

Each provider needs:
- OAuth app registration (we register one app per provider, all tenants
  share the client_id).
- Token storage in D1 with refresh logic.
- An adapter that calls the provider API to mint a fresh download URL.
- 302 to that URL with appropriate cache headers (short max-age — the URL
  itself usually expires in minutes).

```ts
class DropboxAdapter implements StorageAdapter {
  constructor(private tokens: OAuthTokens, private rootPath: string) {}
  async resolveUrl(rel: string) {
    const access = await this.refreshIfNeeded();
    const r = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: this.rootPath + '/' + rel }),
    });
    const { link } = await r.json();
    return { url: link, expiresAt: Date.now() + 4 * 60 * 60_000 };
  }
  resolveProbeUrl = this.resolveUrl;
}
```

OAuth setup overhead per provider: ~1 day of work + DC review. Only justified
once we have demand.

## Tier 3: rclone-as-a-service (speculative)

rclone supports ~50 providers with a single binary. We could run `rclone
serve http` somewhere and use it as a backend, but:
- It's a Go binary, not Workers-compatible.
- Need to host it somewhere with stable IP (i.e. not serverless).
- Defeats the "all-Cloudflare" appeal.

Unlikely to ship unless many users demand niche providers (Mega, Yandex,
Jottacloud, etc.).

## Per-request flow

```
ABS client → GET /api/items/:id/file/:fileId → Worker
  ↓ look up audio_files.adapter_relpath in D1
  ↓ instantiate adapter from tenant_storage.config_json
  ↓ adapter.resolveUrl(relpath) → URL
  ↓ Worker → 302 → URL
ABS client → URL (range request) → user's cloud storage
```

Bytes go directly between client and cloud — never through our Worker. CF
charges us only for the metadata + 302 redirect, which is microseconds of
CPU.

## Per-request flow (cover/probe)

Same as above except the Worker also makes a Range request itself to read
the moov atom. That request DOES go through our Worker (CPU + egress), but:
- It's small (~64KB per book per cache miss).
- Cached in Workers Cache API + R2 once extracted.
- One-time per book; subsequent loads are cache hits.

## Tenant isolation

- D1 row scoping: every metadata query joins on `tenant_id`. Single shared
  D1 database; rows tagged. Move to per-tenant DB only if scaling pain
  emerges.
- Auth: each tenant's users are scoped to that tenant. JWT contains
  `tenant_id`; middleware enforces it on every authenticated request.
- Storage isolation: each tenant has its own `tenant_storage` row with
  their own credentials. Adapters are constructed fresh per request from
  that row — no global state, no cross-tenant leakage.
- Quota: simple counters in D1 (probe count/day, request count/day) per
  tenant. Free tier hard-cap before Worker hits CF's daily limit.

## Open questions

- **Custom domains.** Free tier could use `<tenant>.audioshim.example`;
  paid tier adds full custom domains via CF for SaaS. Defer.
- **Account recovery.** Google OAuth login (already on the roadmap) gives
  us recovery for free; without it, password reset emails need an SMTP
  service. Use Resend or AWS SES.
- **Library scanning.** Public-URL adapters can list a folder via the
  provider's directory listing if any. R2/S3/B2 all support `?list-type=2`.
  pCloud filedn does NOT — needs a manifest file the user keeps current.
  Phase 2: implement scanners per provider; phase 1: user uploads a
  manifest JSON.
- **WebDAV.** Nextcloud, Synology, QNAP all expose WebDAV public shares.
  Range works. One more public-URL adapter variant. Add to Tier 1 if
  demand.
