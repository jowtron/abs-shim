// AWS Signature v4 helpers, just enough for S3-compat operations the shim
// needs: presigned GET URLs (for streaming) and signed ListObjectsV2 calls
// (for scanning). Pure JS using SubtleCrypto — works in Cloudflare Workers
// without any dependency.
//
// Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html

const SERVICE = 's3';
const ALGO = 'AWS4-HMAC-SHA256';

export type S3Creds = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;        // e.g. 'auto' (R2), 'us-east-1' (AWS), 'us-west-002' (B2)
};

const enc = new TextEncoder();

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(hash));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    'raw',
    key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function deriveSigningKey(creds: S3Creds, dateStamp: string): Promise<ArrayBuffer> {
  const kSecret = enc.encode('AWS4' + creds.secretAccessKey);
  const kDate = await hmac(kSecret, dateStamp);
  const kRegion = await hmac(kDate, creds.region);
  const kService = await hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

// AWS-style URI encoding: encode every reserved character EXCEPT slashes,
// which stay as path separators. encodeURIComponent doesn't encode "*" or "!"
// so we fix those up explicitly.
function uriEncode(str: string, encodeSlash = true): string {
  let out = encodeURIComponent(str)
    .replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (!encodeSlash) out = out.replace(/%2F/g, '/');
  return out;
}

// Build a presigned GET URL valid for `expiresIn` seconds. Used for streaming
// audio bytes — Worker hands the URL to the audio client, the client fetches
// directly from S3/R2/B2/etc. Bytes never traverse the Worker.
export async function presignGet(opts: {
  endpoint: string;        // e.g. 'https://<account>.r2.cloudflarestorage.com'
  bucket: string;
  key: string;             // object key, no leading slash
  creds: S3Creds;
  expiresIn: number;       // seconds; max 604800 per SigV4
  // Optional response-header overrides (e.g. force inline disposition).
  responseContentType?: string;
}): Promise<string> {
  const url = new URL(opts.endpoint);
  // Path style or virtual-hosted? R2 + most S3-compat use path-style with the
  // bucket as the first path segment, which is what we generate here.
  url.pathname = `/${opts.bucket}/${uriEncode(opts.key, false)}`;

  const now = new Date();
  const amzDate = isoBasic(now);              // 20260507T120000Z
  const dateStamp = amzDate.slice(0, 8);       // 20260507
  const credentialScope = `${dateStamp}/${opts.creds.region}/${SERVICE}/aws4_request`;

  // Required SigV4 query params, sorted by key for canonical form.
  const params = new URLSearchParams();
  params.set('X-Amz-Algorithm', ALGO);
  params.set('X-Amz-Credential', `${opts.creds.accessKeyId}/${credentialScope}`);
  params.set('X-Amz-Date', amzDate);
  params.set('X-Amz-Expires', String(opts.expiresIn));
  params.set('X-Amz-SignedHeaders', 'host');
  if (opts.responseContentType) {
    params.set('response-content-type', opts.responseContentType);
  }

  // Canonical request — note we sort the *encoded* keys lexicographically,
  // which URLSearchParams doesn't do for us. Build manually.
  const canonicalQuery = sortedQuery(params);
  const canonicalRequest = [
    'GET',
    url.pathname,                              // already URI-encoded
    canonicalQuery,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    ALGO,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await deriveSigningKey(opts.creds, dateStamp);
  const sigBytes = await hmac(signingKey, stringToSign);
  const signature = toHex(new Uint8Array(sigBytes));

  params.set('X-Amz-Signature', signature);
  url.search = sortedQuery(params);  // re-sort with the new param
  return url.toString();
}

// Sign an arbitrary GET request (used by ListObjectsV2). Returns the headers
// to attach. Body is empty for the operations we use.
export async function signRequestHeaders(opts: {
  method: 'GET' | 'HEAD';
  url: URL;
  creds: S3Creds;
}): Promise<Record<string, string>> {
  const now = new Date();
  const amzDate = isoBasic(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${opts.creds.region}/${SERVICE}/aws4_request`;
  const payloadHash = await sha256Hex('');

  const headers: Record<string, string> = {
    host: opts.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  const signedHeadersArr = Object.keys(headers).sort();
  const canonicalHeaders = signedHeadersArr.map((h) => `${h}:${headers[h]}\n`).join('');
  const signedHeaders = signedHeadersArr.join(';');

  // URL search params in canonical sorted form.
  const queryParams = new URLSearchParams(opts.url.search);
  const canonicalQuery = sortedQuery(queryParams);

  const canonicalRequest = [
    opts.method,
    opts.url.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    ALGO,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await deriveSigningKey(opts.creds, dateStamp);
  const sigBytes = await hmac(signingKey, stringToSign);
  const signature = toHex(new Uint8Array(sigBytes));

  return {
    ...headers,
    Authorization: `${ALGO} Credential=${opts.creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function sortedQuery(p: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of p.entries()) pairs.push([uriEncode(k), uriEncode(v)]);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function isoBasic(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}
