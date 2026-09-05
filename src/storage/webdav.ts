import type { Env } from '../types';
import { isAudiobookFile, type RemoteEntry, type ResolvedUrl, type StorageAdapter } from './adapter';
import { signProxyUrl } from './proxy-url';

// WebDAV adapter. Talks to any RFC 4918 server: Synology DSM, TrueNAS, QNAP,
// Nextcloud, ownCloud, Apache mod_dav, nginx-dav, etc.
//
// WebDAV has no presigned URL concept — every request requires the auth
// header. So streaming has to go through the Worker:
//   audio client → /public/proxy/<folder>/<path> → Worker (auth header) → NAS
// The Worker mints an HMAC-signed URL with a short expiry; the proxy route
// validates the signature, fetches from the NAS with credentials from D1, and
// streams the response.
//
// Range requests are passed through verbatim — both the prober and audio
// players need them and WebDAV servers honour them.

export type WebDAVConfig = {
  baseUrl: string;          // e.g. 'https://nas.example.com/dav/audiobooks/'
  username: string;
  password: string;
  // Optional sub-path inside the WebDAV mount, joined with relPath.
  rootPath: string;
};

// A base URL typed without a scheme ("dav.example.com/") makes every
// `new URL(path, base)` throw "Invalid URL string", which surfaced as a
// scan error with no hint about the cause (2026-09-05). Normalising here
// rather than only at attach time also repairs folders already stored that
// way. Anything that still won't parse fails loudly, naming the value.
export function normalizeWebdavBaseUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('WebDAV folder has no server URL');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed.replace(/^\/+/, '');
  const withSlash = withScheme.endsWith('/') ? withScheme : withScheme + '/';
  try { new URL(withSlash); } catch {
    throw new Error(`WebDAV server URL is not a URL: ${trimmed}`);
  }
  return withSlash;
}

export class WebDAVAdapter implements StorageAdapter {
  readonly provider = 'webdav';
  private config: WebDAVConfig;

  constructor(
    private env: Env,
    private folderId: string,
    private origin: string,
    config: WebDAVConfig,
  ) {
    this.config = {
      ...config,
      baseUrl: normalizeWebdavBaseUrl(config.baseUrl),
      rootPath: config.rootPath ?? '',
    };
  }

  async resolveUrl(relPath: string): Promise<ResolvedUrl> {
    return signProxyUrl({
      env: this.env,
      origin: this.origin,
      folderId: this.folderId,
      relPath,
      kind: 'stream',
    });
  }

  // Probing goes straight at the NAS with the credentials, NOT through the
  // signed proxy. The proxy URL points at this Worker's own hostname, and a
  // Worker fetching itself goes back out through the edge, which answers
  // 522: every WebDAV scan died with "Range fetch failed: 522" while the
  // same Range request from a laptop returned 206 in 380 ms (2026-09-05).
  // Client streaming still has to use the proxy — see resolveUrl.
  async resolveProbeUrl(relPath: string): Promise<ResolvedUrl> {
    return {
      url: this.absoluteUrl(relPath),
      headers: { Authorization: 'Basic ' + btoa(`${this.config.username}:${this.config.password}`) },
    };
  }

  // Used by the proxy route to actually fetch bytes from the NAS. Range
  // header from the inbound client request is passed through unchanged so
  // the audio player gets a real 206 response.
  async fetchFromBackend(relPath: string, inbound: Request): Promise<Response> {
    const url = this.absoluteUrl(relPath);
    const headers: Record<string, string> = {
      Authorization: 'Basic ' + btoa(`${this.config.username}:${this.config.password}`),
    };
    const range = inbound.headers.get('Range');
    if (range) headers['Range'] = range;
    return fetch(url, { method: inbound.method, headers });
  }

  async listFolder(relPath: string): Promise<RemoteEntry[]> {
    const url = this.absoluteUrl(relPath);
    const xml = await this.propfind(url, '1');
    return parsePropfindXml(xml, url);
  }

  // One Depth: infinity PROPFIND gets the whole subtree in a single call, and
  // most servers support it — but plenty don't. RFC 4918 explicitly allows a
  // server to refuse it (403 with <propfind-finite-depth/>), and Joseph's NAS
  // answers 400 "Invalid depth: only 0 and 1 are allowed" (2026-09-05), which
  // failed the whole scan. So: try it once, and on any refusal walk the tree
  // with Depth: 1 requests instead. Don't remove the infinity attempt — it is
  // one request instead of one per folder.
  async *walkAudiobookFiles(relPath: string): AsyncIterable<RemoteEntry> {
    const url = this.absoluteUrl(relPath);
    try {
      const xml = await this.propfind(url, 'infinity');
      for (const e of parsePropfindXml(xml, url)) {
        if (!e.isDir && isAudiobookFile(e.relPath)) yield e;
      }
      return;
    } catch (e) {
      if (!(e instanceof PropfindError) || !e.depthRefused) throw e;
    }
    yield* this.walkDepth1(relPath);
  }

  // Breadth-first with Depth: 1. Bounded on both axes so a mount pointed at
  // the wrong place (a whole NAS share) can't spend the Worker's subrequest
  // budget walking someone's photo library.
  private async *walkDepth1(root: string): AsyncIterable<RemoteEntry> {
    const MAX_FOLDERS = 400;
    const MAX_DEPTH = 8;
    const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
    let listed = 0;
    while (queue.length) {
      const { rel, depth } = queue.shift()!;
      if (listed++ >= MAX_FOLDERS) {
        throw new Error(`WebDAV walk stopped after ${MAX_FOLDERS} folders — point the folder at the audiobooks directory rather than the whole share`);
      }
      const here = [root.replace(/\/+$/, ''), rel].filter(Boolean).join('/');
      const url = this.absoluteUrl(here);
      const entries = parsePropfindXml(await this.propfind(url, '1'), url);
      for (const e of entries) {
        // Paths come back relative to the folder we just listed.
        const childRel = rel ? rel + '/' + e.relPath : e.relPath;
        if (e.isDir) {
          if (depth < MAX_DEPTH) queue.push({ rel: childRel, depth: depth + 1 });
        } else if (isAudiobookFile(childRel)) {
          yield { ...e, relPath: childRel };
        }
      }
    }
  }

  private async propfind(url: string, depth: '0' | '1' | 'infinity'): Promise<string> {
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: 'Basic ' + btoa(`${this.config.username}:${this.config.password}`),
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8',
      },
      // Minimal body — request just the props we need.
      body: `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop>
  <displayname/><resourcetype/><getcontentlength/><getlastmodified/>
</prop></propfind>`,
    });
    if (res.status !== 207 && res.status !== 200) {
      throw new PropfindError(res.status, await res.text().catch(() => ''), depth);
    }
    return res.text();
  }

  private absoluteUrl(relPath: string): string {
    const base = this.config.baseUrl.endsWith('/') ? this.config.baseUrl : this.config.baseUrl + '/';
    const root = this.config.rootPath.replace(/^\/+|\/+$/g, '');
    const rel = relPath.replace(/^\/+/, '');
    const path = [root, rel].filter(Boolean).map((seg) => seg.split('/').map(encodeURIComponent).join('/')).join('/');
    return new URL(path, base).toString();
  }
}

// A PROPFIND that the server rejected. `depthRefused` marks the specific
// case the walk retries differently: "I won't do Depth: infinity" — either
// RFC 4918's 403 + <propfind-finite-depth/>, a 400 complaining about the
// depth header, or a flat 501 Not Implemented.
class PropfindError extends Error {
  constructor(readonly status: number, readonly body: string, readonly depth: string) {
    super(`WebDAV PROPFIND HTTP ${status}: ${body}`);
    this.name = 'PropfindError';
  }

  get depthRefused(): boolean {
    if (this.depth !== 'infinity') return false;
    if (this.status === 501) return true;
    if (this.status !== 400 && this.status !== 403) return false;
    return /depth|propfind-finite-depth/i.test(this.body) || this.status === 403;
  }
}

// Crude PROPFIND multistatus parser. Extracts <D:href>, <D:displayname>,
// <D:resourcetype>, <D:getcontentlength>, <D:getlastmodified>. Namespace
// prefixes vary by server (D:, d:, lp1: …) so we match the local part.
function parsePropfindXml(xml: string, baseUrl: string): RemoteEntry[] {
  const entries: RemoteEntry[] = [];
  const responseRe = /<\s*(?:\w+:)?response[^>]*>([\s\S]*?)<\s*\/\s*(?:\w+:)?response\s*>/g;
  let m: RegExpExecArray | null;
  const baseUrlObj = new URL(baseUrl);
  // Compute the path of baseUrl so we can subtract it to get rel paths.
  const basePath = decodeURIComponent(baseUrlObj.pathname).replace(/\/+$/, '');

  while ((m = responseRe.exec(xml)) !== null) {
    const block = m[1]!;
    const hrefRaw = /<\s*(?:\w+:)?href[^>]*>([\s\S]*?)<\s*\/\s*(?:\w+:)?href\s*>/i.exec(block)?.[1];
    if (!hrefRaw) continue;
    const href = decodeURIComponent(hrefRaw.trim());
    // href is path-relative or absolute; reduce to a path relative to base.
    let path = href;
    if (path.startsWith('http://') || path.startsWith('https://')) {
      path = new URL(path).pathname;
    }
    path = decodeURIComponent(path).replace(/\/+$/, '');
    if (!path.startsWith(basePath)) continue;
    let rel = path.slice(basePath.length).replace(/^\/+/, '');
    if (!rel) continue;                                  // the listed dir itself

    const isDir = /<\s*(?:\w+:)?resourcetype[^>]*>[\s\S]*?<\s*(?:\w+:)?collection\s*\/?>/i.test(block);
    const sizeStr = /<\s*(?:\w+:)?getcontentlength[^>]*>([\s\S]*?)<\s*\/\s*(?:\w+:)?getcontentlength\s*>/i.exec(block)?.[1];
    const modifiedStr = /<\s*(?:\w+:)?getlastmodified[^>]*>([\s\S]*?)<\s*\/\s*(?:\w+:)?getlastmodified\s*>/i.exec(block)?.[1];

    const entry: RemoteEntry = { relPath: rel, isDir };
    if (sizeStr) {
      const n = Number(sizeStr.trim());
      if (Number.isFinite(n)) entry.sizeBytes = n;
    }
    if (modifiedStr) {
      const t = Date.parse(modifiedStr.trim());
      if (Number.isFinite(t)) entry.modifiedAt = t;
    }
    entries.push(entry);
  }
  return entries;
}
