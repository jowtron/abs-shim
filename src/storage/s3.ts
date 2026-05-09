import { presignGet, signRequestHeaders, type S3Creds } from './sigv4';
import { isAudiobookFile, type RemoteEntry, type ResolvedUrl, type StorageAdapter } from './adapter';

// S3-compat adapter. Works against:
//   - AWS S3                — endpoint: https://s3.<region>.amazonaws.com
//   - Cloudflare R2         — endpoint: https://<accountid>.r2.cloudflarestorage.com
//                             region:   auto
//   - Backblaze B2          — endpoint: https://s3.<region>.backblazeb2.com
//                             region:   us-west-002 (etc.)
//   - Wasabi                — endpoint: https://s3.<region>.wasabisys.com
//   - DigitalOcean Spaces   — endpoint: https://<region>.digitaloceanspaces.com
//   - MinIO (self-hosted)   — endpoint: https://your-minio.example.com
//
// Streaming uses presigned GET URLs, which means audio bytes flow client →
// storage directly. No proxy through the Worker, no signing per byte. The
// presigned URL has a configurable expiry; we default to 6h, long enough that
// a continuous listening session won't have its URL expire mid-book.

export type S3Config = {
  endpoint: string;       // base URL of the S3-compat host
  bucket: string;
  region: string;
  prefix: string;         // optional folder inside the bucket, e.g. 'audiobooks/'
};

const STREAM_EXPIRES_SECONDS = 6 * 60 * 60;       // 6h
const PROBE_EXPIRES_SECONDS = 60 * 60;            // 1h — prober finishes in seconds

export class S3Adapter implements StorageAdapter {
  readonly provider = 's3';

  constructor(private config: S3Config, private creds: S3Creds) {}

  async resolveUrl(relPath: string): Promise<ResolvedUrl> {
    const url = await presignGet({
      endpoint: this.config.endpoint,
      bucket: this.config.bucket,
      key: this.absoluteKey(relPath),
      creds: this.creds,
      expiresIn: STREAM_EXPIRES_SECONDS,
    });
    return { url, expiresAt: Date.now() + STREAM_EXPIRES_SECONDS * 1000 };
  }

  async resolveProbeUrl(relPath: string): Promise<ResolvedUrl> {
    const url = await presignGet({
      endpoint: this.config.endpoint,
      bucket: this.config.bucket,
      key: this.absoluteKey(relPath),
      creds: this.creds,
      expiresIn: PROBE_EXPIRES_SECONDS,
    });
    return { url, expiresAt: Date.now() + PROBE_EXPIRES_SECONDS * 1000 };
  }

  // ListObjectsV2 with a prefix that maps to (bucket prefix + folder relPath).
  // S3 doesn't have a "folder" abstraction — folders are emulated by key
  // prefixes ending in '/'. We list only audiobook-extension keys.
  async listFolder(relPath: string): Promise<RemoteEntry[]> {
    const out = await this.listObjects(relPath);
    return out.filter((e) => isAudiobookFile(e.relPath));
  }

  // Recursive walk uses the same flat list — S3's prefix listing is already
  // recursive. We just filter to audiobook files.
  async *walkAudiobookFiles(relPath: string): AsyncIterable<RemoteEntry> {
    for (const e of await this.listObjects(relPath)) {
      if (!e.isDir && isAudiobookFile(e.relPath)) yield e;
    }
  }

  private async listObjects(relPath: string): Promise<RemoteEntry[]> {
    const prefix = this.absoluteKey(relPath);
    const out: RemoteEntry[] = [];
    let continuationToken: string | undefined;

    do {
      const url = new URL(`${this.config.endpoint}/${this.config.bucket}`);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      if (continuationToken) url.searchParams.set('continuation-token', continuationToken);

      const headers = await signRequestHeaders({ method: 'GET', url, creds: this.creds });
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) {
        throw new Error(`S3 ListObjects HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }
      const xml = await res.text();
      const { entries, next } = parseListObjectsXml(xml, prefix);
      out.push(...entries);
      continuationToken = next;
    } while (continuationToken);

    return out;
  }

  // Combine bucket-level prefix from config with the per-call rel path.
  private absoluteKey(relPath: string): string {
    const cfgPrefix = this.config.prefix.replace(/^\/+|\/+$/g, '');
    const rel = relPath.replace(/^\/+/, '');
    if (!cfgPrefix) return rel;
    return rel ? `${cfgPrefix}/${rel}` : cfgPrefix;
  }
}

// Minimal XML parser specific to ListObjectsV2 — no dependencies. The response
// shape is regular and small enough that regex extraction is reliable. If we
// ever hit XML edge cases (CDATA, unusual escaping), swap for fast-xml-parser.
function parseListObjectsXml(xml: string, prefix: string): { entries: RemoteEntry[]; next: string | undefined } {
  const entries: RemoteEntry[] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = contentsRe.exec(xml)) !== null) {
    const block = m[1]!;
    const key = unxml(/<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1]);
    if (!key) continue;
    const size = Number(unxml(/<Size>([\s\S]*?)<\/Size>/.exec(block)?.[1]) || '0');
    const modified = unxml(/<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1]);

    // Strip the configured prefix so adapter callers see paths relative to
    // their library folder, not absolute bucket paths.
    let rel = key;
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) continue;            // skip folder markers

    const entry: RemoteEntry = { relPath: rel, isDir: false };
    if (size) entry.sizeBytes = size;
    if (modified) entry.modifiedAt = Date.parse(modified);
    entry.providerId = key;                              // store the absolute key for later
    entries.push(entry);
  }

  let next: string | undefined;
  const isTruncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
  if (isTruncated) {
    const tok = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
    if (tok) next = unxml(tok);
  }
  return { entries, next };
}

function unxml(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
