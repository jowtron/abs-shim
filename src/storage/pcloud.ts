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

export class PcloudOAuthAdapter implements StorageAdapter {
  readonly provider = 'pcloud_oauth';

  constructor(
    private profile: PcloudProfile,
    private config: PcloudConfig,
  ) {}

  async resolveUrl(relPath: string, providerFileId?: string | null): Promise<ResolvedUrl> {
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
    const expiresAt = data.expires ? Date.parse(data.expires) : Date.now() + 60 * 60_000;
    return { url, expiresAt };
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
    const root = data.metadata.path;
    yield* this.walkContents(data.metadata, root);
  }

  private *walkContents(node: PcloudFolderEntry, rootPath: string): Generator<RemoteEntry> {
    for (const child of node.contents ?? []) {
      if (child.isfolder) {
        yield* this.walkContents(child, rootPath);
      } else if (isAudiobookFile(child.name)) {
        const entry: RemoteEntry = {
          relPath: relPathFrom(rootPath, child.path),
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

// Compute a path relative to `rootPath`. Both inputs are absolute pCloud paths
// (e.g. '/Audiobooks/The Hobbit/book.m4b' relative to '/Audiobooks').
function relPathFrom(rootPath: string, absPath: string): string {
  const root = rootPath.replace(/\/+$/, '');
  if (!absPath.startsWith(root)) return absPath;
  return absPath.slice(root.length).replace(/^\/+/, '');
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
