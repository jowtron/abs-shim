import { presignGet, signRequestHeaders, objectUrl, sha256HexOf, type S3Creds } from './sigv4';
import { isAudiobookFile, StorageWriteError, sendStream, QUICK_MS, type RemoteEntry, type ResolvedUrl, type StorageAdapter, type StoredFile } from './adapter';

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

  // One level of the bucket, folders included — what a human browsing for
  // "the folder my audiobooks are in" needs. listFolder above is the
  // scanner's view: prefix-recursive and files only, which shows a bucket
  // root as a flat list of every object and no folders at all.
  async listDirectory(relPath: string): Promise<RemoteEntry[]> {
    const prefix = this.absoluteKey(relPath);
    const withSlash = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;
    const url = new URL(`${this.config.endpoint}/${this.config.bucket}`);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('delimiter', '/');
    url.searchParams.set('max-keys', '1000');
    if (withSlash) url.searchParams.set('prefix', withSlash);

    const headers = await signRequestHeaders({ method: 'GET', url, creds: this.creds });
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) throw new Error(`S3 ListObjects HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const xml = await res.text();

    const out: RemoteEntry[] = [];
    // CommonPrefixes are the folders at this level.
    const prefixRe = /<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;
    let m: RegExpExecArray | null;
    while ((m = prefixRe.exec(xml)) !== null) {
      const full = unxml(m[1]).replace(/\/+$/, '');
      const name = full.slice(withSlash.length).replace(/^\/+/, '');
      if (name) out.push({ relPath: name, isDir: true });
    }
    for (const e of parseListObjectsXml(xml, withSlash).entries) {
      if (e.relPath.includes('/')) continue;   // deeper keys belong to a folder
      out.push(e);
    }
    return out;
  }

  // ─── Writes, for Audible delivery (src/lib/audible-delivery.ts) ───────────
  // A multipart upload, one part per call, so a book can be sent a few parts
  // per cron tick and resumed from the parts already sent. The object only
  // appears at its key when the upload completes, so nothing ever sees half
  // a book. Every part but the last is the same size (R2 requires that).

  private objectUrl(relPath: string, query: Record<string, string> = {}): URL {
    const url = objectUrl(this.config.endpoint, this.config.bucket, this.absoluteKey(relPath));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  private async send(method: 'HEAD' | 'POST' | 'DELETE', url: URL, init: {
    body?: string; payloadHash?: string; headers?: Record<string, string>; timeoutMs?: number;
  } = {}): Promise<Response> {
    const signed = await signRequestHeaders({
      method, url, creds: this.creds, ...(init.payloadHash ? { payloadHash: init.payloadHash } : {}),
    });
    return fetch(url.toString(), {
      method, headers: { ...signed, ...(init.headers ?? {}) }, body: init.body ?? null,
      signal: AbortSignal.timeout(init.timeoutMs ?? QUICK_MS),
    });
  }

  async stat(relPath: string): Promise<StoredFile | null> {
    const res = await this.send('HEAD', this.objectUrl(relPath));
    if (res.status === 404) return null;
    if (!res.ok) throw s3Error('HEAD', res.status, '');
    const modified = Date.parse(res.headers.get('Last-Modified') ?? '');
    return { size: Number(res.headers.get('Content-Length') ?? '0'), modifiedAt: Number.isFinite(modified) ? modified : null, isDir: false };
  }

  async createMultipart(relPath: string, contentType: string): Promise<string> {
    const res = await this.send('POST', this.objectUrl(relPath, { uploads: '' }), { headers: { 'Content-Type': contentType } });
    const xml = await res.text().catch(() => '');
    if (!res.ok) throw s3Error('CreateMultipartUpload', res.status, xml);
    const id = unxml(/<UploadId>([\s\S]*?)<\/UploadId>/.exec(xml)?.[1]);
    if (!id) throw new StorageWriteError(res.status, '', 'S3 CreateMultipartUpload answered without an UploadId');
    return id;
  }

  // `body` is streamed as it is (an R2 read). UNSIGNED-PAYLOAD, because
  // hashing it would mean reading it twice.
  async uploadPart(relPath: string, uploadId: string, partNumber: number, body: ReadableStream, length: number, timeoutMs: number): Promise<string> {
    const url = this.objectUrl(relPath, { partNumber: String(partNumber), uploadId });
    const signed = await signRequestHeaders({ method: 'PUT', url, creds: this.creds, payloadHash: 'UNSIGNED-PAYLOAD' });
    const res = await sendStream(url.toString(), { method: 'PUT', headers: signed }, body, length, timeoutMs);
    const text = await res.text().catch(() => '');
    if (!res.ok) throw s3Error(`UploadPart ${partNumber}`, res.status, text);
    const etag = res.headers.get('ETag');
    if (!etag) throw new StorageWriteError(res.status, '', `S3 UploadPart ${partNumber} answered without an ETag`);
    return etag;
  }

  async completeMultipart(relPath: string, uploadId: string, etags: string[]): Promise<void> {
    const body = '<CompleteMultipartUpload>' + etags.map((e, i) =>
      `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</ETag></Part>`,
    ).join('') + '</CompleteMultipartUpload>';
    // Assembling a big object can take a while on some servers.
    const res = await this.send('POST', this.objectUrl(relPath, { uploadId }), {
      body, payloadHash: await sha256HexOf(body), headers: { 'Content-Type': 'application/xml' }, timeoutMs: 5 * QUICK_MS,
    });
    const xml = await res.text().catch(() => '');
    // S3 can answer 200 and put the failure in the body.
    if (!res.ok || /<Error>/.test(xml)) throw s3Error('CompleteMultipartUpload', res.ok ? 500 : res.status, xml);
  }

  // Frees the parts already sent. Best effort: an unknown upload is fine.
  async abortMultipart(relPath: string, uploadId: string): Promise<void> {
    const res = await this.send('DELETE', this.objectUrl(relPath, { uploadId }));
    if (!res.ok && res.status !== 404) throw s3Error('AbortMultipartUpload', res.status, await res.text().catch(() => ''));
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

function s3Error(op: string, status: number, xml: string): StorageWriteError {
  const code = unxml(/<Code>([\s\S]*?)<\/Code>/.exec(xml)?.[1]);
  const msg = unxml(/<Message>([\s\S]*?)<\/Message>/.exec(xml)?.[1]);
  return new StorageWriteError(status, code, `S3 ${op} HTTP ${status}${code ? ' ' + code : ''}${msg ? ': ' + msg : ''}`);
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
