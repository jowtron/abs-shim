import { type RemoteEntry, type ResolvedUrl, type StorageAdapter, isAudiobookFile } from './adapter';

// pCloud OAuth adapter. Uses the user's access token to:
//   - resolve `getfilelink` for streaming (server-mediated, short-lived URL)
//   - walk folders via `listfolder` for the scanner
//
// pCloud has two API hosts: api.pcloud.com (US, locationid=1) and
// eapi.pcloud.com (EU, locationid=2). The OAuth callback tells us which to
// use; we persist that on the oauth_profiles row and pass it in here.
//
// API docs: https://docs.pcloud.com/methods/
//
// Privacy / why this is the upgrade from filedn-public:
//   - Files in pCloud stay private. No public link is ever generated.
//   - getfilelink returns a temporary direct URL on a pCloud streaming host
//     that expires (typically ~6 hours). Even if a user shares one, it dies.
//   - Range requests work end-to-end so the m4b prober still functions.

export type PcloudConfig = {
  // Path of the audiobook root inside pCloud, e.g. '/Audiobooks'. The scanner
  // and stream resolver join relative paths against this. Always begins with
  // '/' on pCloud.
  rootPath: string;
};

export type PcloudProfile = {
  accessToken: string;
  apiHost: string;       // 'api.pcloud.com' or 'eapi.pcloud.com'
};

type PcloudApiResult = { result: number; error?: string } & Record<string, unknown>;

type PcloudFileLink = PcloudApiResult & {
  hosts?: string[];
  path?: string;
  expires?: string;       // RFC2822-ish date
};

type PcloudFolderEntry = {
  name: string;
  isfolder: boolean;
  path: string;
  fileid?: number;
  folderid?: number;
  size?: number;
  modified?: string;
  contents?: PcloudFolderEntry[];
};

type PcloudListFolder = PcloudApiResult & {
  metadata?: PcloudFolderEntry;
};

// Module-scope cache of resolved pCloud streaming URLs. Persists across
// requests within a Worker isolate's lifetime (which is "many seconds, often
// minutes" under steady traffic; aggressively evicted under idle).
//
// Why this is safe wrt pCloud's IP-binding: getfilelink URLs are bound to the
// IP that *called* getfilelink — which is this Worker's egress IP. The cached
// URL is fetched again by the same Worker, so the egress IP matches. Cache
// scope is naturally per-isolate, which is per-POP, so we won't accidentally
// reuse a URL across a different egress IP boundary.
//
// Why we keep the access token out of the key: cache keys live in memory only
// and are never logged, but using the first 12 chars (enough to disambiguate
// accounts in any realistic scenario) means the full token never appears as a
// Map key. apiHost is included because EU/US pCloud accounts can have
// overlapping fileids.
type CachedStreamUrl = { url: string; expiresAt: number };
const streamUrlCache = new Map<string, CachedStreamUrl>();
// Safety margin under the pCloud `expires` timestamp. If pCloud says the URL
// is valid until T, treat it as valid until T-60s — covers clock skew and the
// occasional 6h-window race.
const CACHE_SAFETY_MARGIN_MS = 60_000;

function streamCacheKey(profile: PcloudProfile, fileIdentity: string): string {
  return `${profile.apiHost}|${profile.accessToken.slice(0, 12)}|${fileIdentity}`;
}

export class PcloudOAuthAdapter implements StorageAdapter {
  readonly provider = 'pcloud_oauth';

  constructor(
    private profile: PcloudProfile,
    private config: PcloudConfig,
  ) {}

  async resolveUrl(relPath: string, providerFileId?: string | null): Promise<ResolvedUrl> {
    const fileIdentity = providerFileId ?? this.absolutePath(relPath);
    const key = streamCacheKey(this.profile, fileIdentity);
    const now = Date.now();

    const cached = streamUrlCache.get(key);
    if (cached && cached.expiresAt > now + CACHE_SAFETY_MARGIN_MS) {
      return cached;
    }

    // Prefer fileid when we already know it (set by the scanner) — saves a
    // path lookup roundtrip per request. Fall back to path lookup otherwise.
    const params = new URLSearchParams();
    if (providerFileId) {
      params.set('fileid', providerFileId);
    } else {
      params.set('path', this.absolutePath(relPath));
    }
    // forcedownload=0 + skipfilename=1: stream inline rather than triggering a
    // download dialog if the URL ever leaks into a browser tab.
    params.set('forcedownload', '0');
    params.set('skipfilename', '1');

    const data = await this.call<PcloudFileLink>('getfilelink', params);
    if (!data.hosts?.length || !data.path) {
      throw new Error(`pCloud getfilelink returned no host/path: ${JSON.stringify(data)}`);
    }
    const url = `https://${data.hosts[0]}${data.path}`;
    // pCloud `expires` is RFC 2822; if missing, conservatively assume 1h.
    const expiresAt = data.expires ? Date.parse(data.expires) : now + 60 * 60_000;
    const entry: CachedStreamUrl = { url, expiresAt };
    streamUrlCache.set(key, entry);
    return entry;
  }

  resolveProbeUrl(relPath: string, providerFileId?: string | null): Promise<ResolvedUrl> {
    return this.resolveUrl(relPath, providerFileId);
  }

  async listFolder(relPath: string): Promise<RemoteEntry[]> {
    const params = new URLSearchParams();
    params.set('path', this.absolutePath(relPath));
    params.set('nofiles', '0');
    const data = await this.call<PcloudListFolder>('listfolder', params);
    if (!data.metadata?.contents) return [];
    return data.metadata.contents.map((e) => this.toRemoteEntry(e, relPath));
  }

  // Recursive walk — pCloud `listfolder?recursive=1` returns the whole subtree
  // in one call, far cheaper than per-folder fetches.
  async *walkAudiobookFiles(relPath: string): AsyncIterable<RemoteEntry> {
    const params = new URLSearchParams();
    params.set('path', this.absolutePath(relPath));
    params.set('recursive', '1');
    params.set('nofiles', '0');
    const data = await this.call<PcloudListFolder>('listfolder', params);
    if (!data.metadata) return;
    // pCloud only sets `path` on the root entry of a recursive listfolder;
    // nested contents entries are name-only. Build relPaths by accumulating
    // names as we descend instead of trying to subtract the root.
    yield* this.walkContents(data.metadata, '');
  }

  private *walkContents(node: PcloudFolderEntry, currentRel: string): Generator<RemoteEntry> {
    for (const child of node.contents ?? []) {
      const childRel = currentRel ? `${currentRel}/${child.name}` : child.name;
      if (child.isfolder) {
        yield* this.walkContents(child, childRel);
      } else if (isAudiobookFile(child.name)) {
        const entry: RemoteEntry = {
          relPath: childRel,
          isDir: false,
        };
        if (child.size != null) entry.sizeBytes = child.size;
        if (child.fileid != null) entry.providerId = String(child.fileid);
        if (child.modified) entry.modifiedAt = Date.parse(child.modified);
        yield entry;
      }
    }
  }

  private toRemoteEntry(e: PcloudFolderEntry, parentRel: string): RemoteEntry {
    const rel = parentRel ? `${parentRel.replace(/\/+$/, '')}/${e.name}` : e.name;
    const entry: RemoteEntry = { relPath: rel, isDir: e.isfolder };
    if (e.size != null) entry.sizeBytes = e.size;
    const provId = e.isfolder ? e.folderid : e.fileid;
    if (provId != null) entry.providerId = String(provId);
    if (e.modified) entry.modifiedAt = Date.parse(e.modified);
    return entry;
  }

  private absolutePath(relPath: string): string {
    const root = this.config.rootPath.replace(/\/+$/, '');
    const rel = relPath.replace(/^\/+/, '');
    return rel ? `${root}/${rel}` : root || '/';
  }

  private async call<T extends PcloudApiResult>(method: string, params: URLSearchParams): Promise<T> {
    const url = `https://${this.profile.apiHost}/${method}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.profile.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`pCloud ${method} HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const data = await res.json() as T;
    if (data.result !== 0) {
      throw new Error(`pCloud ${method} result=${data.result} ${data.error ?? ''}`);
    }
    return data;
  }
}

// OAuth-flow helpers, kept here so they live next to the adapter that uses them.
//
// pCloud OAuth2 reference: https://docs.pcloud.com/oauth2/

export const PCLOUD_AUTHORIZE_URL = 'https://my.pcloud.com/oauth2/authorize';

export function pcloudAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(PCLOUD_AUTHORIZE_URL);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('state', opts.state);
  return u.toString();
}

export type PcloudTokenResponse = {
  access_token: string;
  token_type: string;
  uid?: number;
  locationid?: number;     // 1 = US (api.pcloud.com), 2 = EU (eapi.pcloud.com)
  hostname?: string;       // canonical API host for this user's region
  result?: number;
  error?: string;
};

export async function exchangePcloudCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  // pCloud accepts the token-exchange call on either host; the response then
  // tells us which one to use going forward.
  apiHost?: string;
}): Promise<PcloudTokenResponse> {
  const host = opts.apiHost ?? 'api.pcloud.com';
  const params = new URLSearchParams();
  params.set('client_id', opts.clientId);
  params.set('client_secret', opts.clientSecret);
  params.set('code', opts.code);
  const url = `https://${host}/oauth2_token?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`pCloud oauth2_token HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const data = await res.json() as PcloudTokenResponse;
  if (data.error) {
    throw new Error(`pCloud oauth2_token error: ${data.error}`);
  }
  return data;
}

export function apiHostFromLocationId(locationid: number | undefined, fallback?: string): string {
  if (fallback) return fallback;
  return locationid === 2 ? 'eapi.pcloud.com' : 'api.pcloud.com';
}

// `userinfo` returns the account email so we can label the connection in the
// admin UI ("Connected as joseph@gmail.com"). Optional but useful.
export async function pcloudUserinfo(profile: PcloudProfile): Promise<{ email?: string }> {
  const url = `https://${profile.apiHost}/userinfo`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${profile.accessToken}` } });
  if (!res.ok) return {};
  const data = await res.json().catch(() => ({})) as { email?: string };
  return data.email ? { email: data.email } : {};
}

// ─── Chunked upload ────────────────────────────────────────────────────────
//
// Workers have a 100 MB request-body limit on the Free plan (500 MB Paid).
// Audiobook files routinely exceed both, so the browser uploads in chunks of
// ~25 MB and the Worker streams each chunk straight to pCloud's upload_write.
// No buffering on our side — `fetch(... body: requestBody)` pipes the bytes
// through. pCloud's API:
//   upload_create  → returns { uploadid }
//   upload_write   → PUT raw bytes with ?uploadid=X&uploadoffset=Y
//   upload_save    → saves the assembled bytes to a path, returns metadata
// Reference: https://docs.pcloud.com/methods/fileops/

export type PcloudUploadCreate = PcloudApiResult & { uploadid?: number };

export async function pcloudUploadCreate(profile: PcloudProfile): Promise<number> {
  const url = `https://${profile.apiHost}/upload_create`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${profile.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`pCloud upload_create HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const data = await res.json() as PcloudUploadCreate;
  if (data.result !== 0 || !data.uploadid) {
    throw new Error(`pCloud upload_create result=${data.result} ${data.error ?? ''}`);
  }
  return data.uploadid;
}

// Stream `body` to pCloud at the given offset. `body` can be a ReadableStream
// (preferred — zero-copy from the inbound Worker request) or a Uint8Array.
// `contentLength` is required when streaming because pCloud rejects chunked
// transfer-encoding here.
export async function pcloudUploadWrite(
  profile: PcloudProfile,
  args: { uploadId: number; offset: number; body: ReadableStream<Uint8Array> | Uint8Array; contentLength: number },
): Promise<void> {
  const params = new URLSearchParams();
  params.set('uploadid', String(args.uploadId));
  params.set('uploadoffset', String(args.offset));
  const url = `https://${profile.apiHost}/upload_write?${params.toString()}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${profile.accessToken}`,
      'Content-Length': String(args.contentLength),
      'Content-Type': 'application/octet-stream',
    },
    body: args.body,
    // Required for streaming bodies in workerd/undici-style fetch.
    duplex: 'half',
  } as RequestInit & { duplex?: 'half' });
  if (!res.ok) {
    throw new Error(`pCloud upload_write HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const data = await res.json() as PcloudApiResult;
  if (data.result !== 0) {
    throw new Error(`pCloud upload_write result=${data.result} ${data.error ?? ''}`);
  }
}

export type PcloudSavedFile = PcloudApiResult & {
  metadata?: { fileid: number; path: string; name: string; size: number };
};

// Finalize. `path` is the absolute pCloud path including filename, e.g.
// "/Audiobooks/The Hobbit/hobbit.m4b". pCloud creates parent folders only if
// `createparents=1` is set — we set it because upload-by-extraction will
// frequently include nested subfolders the user has never created.
export async function pcloudUploadSave(
  profile: PcloudProfile,
  args: { uploadId: number; path: string },
): Promise<PcloudSavedFile> {
  const params = new URLSearchParams();
  params.set('uploadid', String(args.uploadId));
  params.set('path', args.path);
  params.set('createparents', '1');
  const url = `https://${profile.apiHost}/upload_save?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${profile.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`pCloud upload_save HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const data = await res.json() as PcloudSavedFile;
  if (data.result !== 0) {
    throw new Error(`pCloud upload_save result=${data.result} ${data.error ?? ''}`);
  }
  return data;
}

// ─── Fetch-from-URL (server-side download) ──────────────────────────────────
//
// pCloud can pull a file from a public URL into the user's account on its own
// servers: `downloadfileasync` queues the job and returns immediately. The
// Worker never touches the bytes, so there's no body-size or wall-clock
// concern — this is how "paste a download link" in /admin works.
//
// The docs say `uploadprogress?progresshash=…` reports the job's status.
// Tested 2026-08-22: it answers 1900 "Upload not found" for the whole life
// of an async download, even while the file is visibly landing. So there is
// no progress API — completion is detected by stat-ing the target path and
// comparing its size to the source's Content-Length (see admin routes).
//
// The blocking sibling `downloadfile` exists too but returns only when the
// transfer finishes, which would pin a Worker request open for the whole
// transfer. Always use the async form. Also observed: a URL pCloud can't
// fetch (e.g. w3.org refuses it) is NOT an error — result 0, and the file
// just never appears.

async function pcloudGet<T extends PcloudApiResult>(
  profile: PcloudProfile, method: string, params: URLSearchParams,
): Promise<T> {
  const url = `https://${profile.apiHost}/${method}?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${profile.accessToken}` } });
  if (!res.ok) {
    throw new Error(`pCloud ${method} HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return await res.json() as T;
}

export type PcloudMetadata = {
  fileid?: number; folderid?: number; path?: string; name: string; size?: number; isfolder: boolean;
};

// `createfolderifnotexists` only creates the leaf, so walk the path one
// segment at a time. Returns the folderid of the deepest folder — that is
// what downloadfileasync wants (passing `path` works too, but folderid
// avoids a second round of path-encoding ambiguity on pCloud's side).
export async function pcloudEnsureFolder(profile: PcloudProfile, absPath: string): Promise<number> {
  const segs = absPath.split('/').filter(Boolean);
  let folderId = 0; // root
  let cur = '';
  for (const seg of segs) {
    cur += `/${seg}`;
    const params = new URLSearchParams();
    params.set('path', cur);
    const data = await pcloudGet<PcloudApiResult & { metadata?: PcloudMetadata }>(profile, 'createfolderifnotexists', params);
    if (data.result !== 0 || data.metadata?.folderid == null) {
      throw new Error(`pCloud createfolderifnotexists(${cur}) result=${data.result} ${data.error ?? ''}`);
    }
    folderId = data.metadata.folderid;
  }
  return folderId;
}

// Returns null when the path doesn't exist (pCloud result 2009/2010).
export async function pcloudStat(profile: PcloudProfile, absPath: string): Promise<PcloudMetadata | null> {
  const params = new URLSearchParams();
  params.set('path', absPath);
  const data = await pcloudGet<PcloudApiResult & { metadata?: PcloudMetadata }>(profile, 'stat', params);
  // Observed: 2055 when the leaf is missing, 2002 when a parent folder is
  // missing ("A component of parent directory does not exist"), 2005 for a
  // missing directory. 2009/2010 are the documented file-not-found /
  // invalid-path codes. All of them mean "not there".
  if ([2055, 2002, 2005, 2009, 2010].includes(data.result)) return null;
  if (data.result !== 0 || !data.metadata) {
    throw new Error(`pCloud stat(${absPath}) result=${data.result} ${data.error ?? ''}`);
  }
  return data.metadata;
}

// Queue a server-side download of `url` into `folderId`, saved as `name`.
// `target` is documented as a "comma-separated urlencoded list", i.e. the
// value is decoded once as a query param and then split on commas, so the
// filename itself has to be encoded a second time — verified live: single
// encoding turned "GH, Single.md" into a file called "GH".
export async function pcloudDownloadFileAsync(
  profile: PcloudProfile,
  args: { url: string; folderId: number; name: string },
): Promise<void> {
  const params = new URLSearchParams();
  params.set('url', args.url);
  params.set('folderid', String(args.folderId));
  params.set('target', encodeURIComponent(args.name));
  const data = await pcloudGet<PcloudApiResult>(profile, 'downloadfileasync', params);
  if (data.result !== 0) {
    throw new Error(`pCloud downloadfileasync result=${data.result} ${data.error ?? ''}`);
  }
}

// Short-lived direct URL for reading a file's bytes (Range-capable). Same
// IP-binding caveat as the adapter's resolveUrl: only the caller's egress IP
// can use it, so resolve and consume within one execution context.
export async function pcloudFileLink(profile: PcloudProfile, absPath: string): Promise<string> {
  const params = new URLSearchParams();
  params.set('path', absPath);
  params.set('forcedownload', '0');
  params.set('skipfilename', '1');
  const data = await pcloudGet<PcloudApiResult & { hosts?: string[]; path?: string }>(profile, 'getfilelink', params);
  if (data.result !== 0 || !data.hosts?.length || !data.path) {
    throw new Error(`pCloud getfilelink(${absPath}) result=${data.result} ${data.error ?? ''}`);
  }
  return `https://${data.hosts[0]}${data.path}`;
}

export async function pcloudDeleteFile(profile: PcloudProfile, absPath: string): Promise<void> {
  const params = new URLSearchParams();
  params.set('path', absPath);
  const data = await pcloudGet<PcloudApiResult>(profile, 'deletefile', params);
  if (data.result !== 0 && data.result !== 2055 && data.result !== 2009) {
    throw new Error(`pCloud deletefile(${absPath}) result=${data.result} ${data.error ?? ''}`);
  }
}
