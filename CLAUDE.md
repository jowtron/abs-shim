# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ABS_shim — a 100% serverless Cloudflare-native backend that mimics the Audiobookshelf (ABS) API so official and third-party ABS clients (web UI, ShelfPlayer, Pholia, mobile apps) can talk to it without modification. Driver: resilience while the user's self-hosted ABS Docker server is down. Stack: Cloudflare Workers (Hono on TypeScript), D1 (SQLite), Durable Objects, Workers Cache API, optional R2.

Storage backends are pluggable via `StorageAdapter`: filedn-public, S3-compat (R2/B2/AWS/Wasabi), WebDAV (NAS), pCloud OAuth. Multiple backends per library are supported.

## Common commands

```
npm run dev               # local wrangler dev on :13380 (also exposed via Tailscale Serve)
npm run typecheck         # tsc --noEmit (strict, exactOptionalPropertyTypes ON)
npm run deploy            # wrangler deploy to <your-shim>.workers.dev
npm run db:migrate        # apply migrations to remote D1
npm run db:migrate:local  # apply locally
npm run db:seed:local     # re-seed two books locally (DELETE-first)
npx wrangler tail --format pretty   # live prod request logs (use for debugging strict clients)
```

## Architecture

**Worker entry**: `src/index.ts`. Outer `fetch()` strips the `/audiobookshelf/` prefix that the bundled Nuxt UI hardcodes, then routes via Hono. `app.notFound` branches on path: `/api/*` and `/auth/*` return JSON 404 (critical for strict clients), everything else falls through to `[assets]` SPA.

**Routes**: `/login`, `/api/authorize`, `/api/me`, `/api/items/*`, `/api/libraries/*`, `/api/admin/*`, `/api/session/*`, `/public/proxy/*`, `/admin` (UI), plus a Socket.io stub via `ListeningSessionDO`. Other DOs: `SignupRateLimitDO` (per-IP signup throttle), `ArchiveExtractDO` (zip extraction jobs). Auth middleware (`src/auth/middleware.ts`) accepts Bearer header, `?token=` query, or `accessToken` cookie. Cookie is refreshed on every `/login` AND `/api/authorize`.

**Storage adapters** (`src/storage/`): `adapter.ts` defines the interface — `resolveUrl`, `resolveProbeUrl`, `listFolder`, optional `walkAudiobookFiles`. `factory.ts` builds an adapter from a `library_folders` row. The adapter for streaming is invoked from `src/storage/resolve.ts` — it falls back to `audio_files.filedn_url` when `rel_path` is null (preserves backward compatibility with the original seed).

For backends that can't 302 directly (WebDAV), `proxy-url.ts` mints HMAC-signed self-Worker URLs and `index.ts` has a `/public/proxy/:folderId/*` route that validates the signature and proxies bytes. Streaming through a Worker is fine — once you `return` a `Response` with a `ReadableStream` body, CF's edge runtime pipes bytes without using your Worker's CPU budget.

**Scanner** (`src/scanner/scan.ts`): `runScan()` enumerates folders for a library, calls `adapter.walkAudiobookFiles`, probes each new m4b via `src/prober/m4b.ts`, and inserts library_items + book_metadata + audio_files + chapters in one D1 batch. Public-URL adapter throws `ListingNotSupportedError` (filedn has no listing API). `addBookByPath()` is the per-file alternative.

**Prober** (`src/prober/m4b.ts`): pure-JS MP4 atom walker, reads moov via Range requests, extracts mvhd duration, udta/meta/ilst tags, covr cover. No FFmpeg.

**Admin UI** (`src/lib/admin-html.ts`): single self-contained HTML+JS embedded in the Worker (a `String.raw` template — regex escapes are verbatim), served at `/admin`. Cookie-authed with inline login form. Renders all library_folders per library (multi-backend), with attach buttons for S3/WebDAV/pCloud, chunked browser upload (zip/rar extracted client-side via libarchive.js), fetch-from-URL, and the AudioBookBay → Real-Debrid panel. Before deploying UI changes: extract the `<script>` and run `node --check` on it — there's no other syntax check.

**Fetch-from-URL + zip extraction** (pcloud_oauth folders only). `POST /api/admin/storage/folder/:id/fetch-url/start` asks pCloud to pull a direct URL itself (`downloadfileasync`); the browser polls `/progress`, which `stat`s the target and compares to the source's Content-Length (pCloud's `uploadprogress` never reports these jobs), then `/finish` registers via `addBookByPath`. Zips are handed to `ArchiveExtractDO` (`src/do/archive-extract.ts`, reader in `src/archive/zip.ts`): it Range-reads the central directory, streams each audio entry through `DecompressionStream('deflate-raw')` into pCloud's chunked upload, one alarm per entry. pCloud's own `extractarchive` API is broken (3006 on everything) — don't retry it. rar is not extracted server-side.

**AudioBookBay → Real-Debrid** (`src/lib/abb.ts`, `src/lib/realdebrid.ts`, `src/routes/abb.ts` at `/api/admin/abb`). Credentials are per tenant in `tenant_settings` (migration 0005), sealed with AES-GCM via the `SETTINGS_KEY` secret (`src/lib/secret-box.ts`). The browser drives the flow: `resolve` → `torrents` (add + select) → poll `torrents/:id` → `fetch-url/*` per direct link → `DELETE torrents/:id`. Multi-file releases are added one torrent per audio file because RD packs multi-file selections into a rar. ABB search queries must be lower-case (capitals → 301 to the homepage). `fetch-url/finish` only registers single m4b/m4a/aac files, so after the last fetch lands both UIs `POST /api/admin/libraries/:id/scan` — that's what picks up mp3 (multi-file) releases; don't drop it. Pholia's "Add" tab calls these same routes (plus the scan route) — keep the two repos in sync when changing them.

**Pholia is not bundled here (but does call shim-only routes).** Pholia (github.com/jowtron/pholia) has its own Cloudflare Pages deploy at pholia.pages.dev with its own D1 database (`pholia-accounts`) backing a passkey-protected saved-server vault. WebAuthn passkeys are bound to RP ID = the browser's hostname, so re-hosting Pholia under `/pholia/` on the shim would break every existing passkey (users would have to re-register on the shim hostname). The /admin UI links out to pholia.pages.dev in a new tab; users sign in there and point Pholia at this shim as their ABS server. Don't try to bundle Pholia under a sub-path here. Pholia (checkout `/Users/joseph/Claude_Code/pholia/pholia`, deploys on push via GitHub Actions) detects the shim by probing `GET /api/admin/abb/settings` and shows its "Add" tab only on a shim with a Real-Debrid token configured.

## Strict-client compatibility (ShelfPlayer)

ShelfPlayer uses strict Swift Codable — one field type mismatch fails the entire response, and array-decode failures wipe whole shelves. Lessons learned and locked into the code:

- `publishedYear` is a STRING in the wire format, not a number (despite being stored as INTEGER in D1). Don't change `String(m.publish_year)` in `src/lib/abs-shapes.ts`.
- `media.tracks` is required for playback — built from audioFiles with cumulative `startOffset` in `buildTracks()`.
- `/api/*` paths MUST return JSON 404, never the SPA index.html — strict clients parse HTML 200 as garbage and go offline.
- See `~/.claude/projects/-Users-joseph-Claude-Code-ABS-shim/memory/reference_shelfplayer_quirks.md` for the full debugging methodology.

When adding a new client integration: open `wrangler tail --format pretty` and use `gh api repos/<owner>/<repo>/contents/<path> --jq '.content' | base64 -d` to read Swift Codable structs. Diff the strict types against `src/lib/abs-shapes.ts` output.

## Schema (D1)

Migrations in `migrations/`. Initial schema (0001) plus storage additions (0002): library_folders gained `provider`, `config_json`, `profile_id`; audio_files gained `rel_path`, `provider_file_id`; new tables `oauth_profiles`, `oauth_state`. 0003 moov cache, 0004 multi-tenancy (`tenants`, `tenant_members`, `invites`, `tenant_id` columns), 0005 `tenant_settings` (per-tenant key/value; `server_settings` stays instance-wide). IDs are TEXT (UUIDs or `li_…`/`mp_…`). Timestamps INTEGER ms-epoch. JSON-shaped fields are TEXT, accessed via `JSON.parse`.

`audio_files.filedn_url` is legacy/back-compat for the original seed; new rows insert `rel_path` instead, and `resolveStreamUrl` picks the right path.

## Production state

- Deployed to a Cloudflare Worker (URL configured in `wrangler.toml`).
- D1 `abs-shim-db` seeded via `npm run db:seed:local`. Real folders are added at runtime through the `/admin` UI rather than committed to the seed file.
- Storage: pluggable via StorageAdapter (filedn-public, pCloud OAuth, S3-compat, WebDAV). Multiple backends per library are supported.
- Required wrangler secrets: `JWT_SECRET` (mandatory), `SETTINGS_KEY` (32 random bytes, base64 — AES-GCM key for per-tenant secrets such as the AudioBookBay password and Real-Debrid token; see `src/lib/secret-box.ts`). Optional: `PCLOUD_CLIENT_ID`, `PCLOUD_CLIENT_SECRET` (only if using pCloud OAuth). S3 and WebDAV credentials are entered via the `/admin` UI and stored as plaintext JSON in D1 (`library_folders.config_json`); the `/api/admin/storage/status` response redacts them.
- Bootstrap: hit `/init` once to create the root user. Verified working clients: bundled ABS web UI, Pholia, ShelfPlayer.

## Conventions

- Hono routes are thin; logic lives in `src/lib/`, `src/db/`, `src/storage/`, `src/scanner/`.
- Don't introduce new runtime dependencies casually — Workers Free has size constraints; current dep list is just `hono`.
- Don't add `nodejs_compat` — pure-JS only on the Worker side.
- TypeScript is strict (`exactOptionalPropertyTypes`); guard against undefined explicitly when building objects with optional fields.
- Comments explain the *why*, not the what. Many comments in this codebase reference past bugs ("Don't change this — without it ShelfPlayer goes offline"), which are load-bearing.
