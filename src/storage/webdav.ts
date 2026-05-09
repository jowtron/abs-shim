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

export class WebDAVAdapter implements StorageAdapter {
  readonly provider = 'webdav';

  constructor(
    private env: Env,
    private folderId: string,
    private origin: string,
    private config: WebDAVConfig,
  ) {}

  async resolveUrl(relPath: string): Promise<ResolvedUrl> {
    return signProxyUrl({
      env: this.env,
      origin: this.origin,
      folderId: this.folderId,
      relPath,
      kind: 'stream',
    });
  }

  resolveProbeUrl(relPath: string): Promise<ResolvedUrl> {
    return signProxyUrl({
      env: this.env,
      origin: this.origin,
      folderId: this.folderId,
      relPath,
      kind: 'probe',
    });
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

  // PROPFIND with Depth: infinity to discover the whole subtree in one call.
  // Some servers (Synology) cap depth at 1; if we get a 403/501 we should
  // fall back to recursive depth-1 calls — TODO once we hit that in practice.
  async listFolder(relPath: string): Promise<RemoteEntry[]> {
    const url = this.absoluteUrl(relPath);
    const xml = await this.propfind(url, '1');
    return parsePropfindXml(xml, url);
  }

  async *walkAudiobookFiles(relPath: string): AsyncIterable<RemoteEntry> {
    const url = this.absoluteUrl(relPath);
    const xml = await this.propfind(url, 'infinity');
    for (const e of parsePropfindXml(xml, url)) {
      if (!e.isDir && isAudiobookFile(e.relPath)) yield e;
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
      throw new Error(`WebDAV PROPFIND HTTP ${res.status}: ${await res.text().catch(() => '')}`);
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
