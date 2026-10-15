// Storage adapter contract. The shim never touches audio bytes — adapters
// translate "(folder, relative path)" into a URL the client streams from
// directly via 302, plus the same translation for the moov-atom prober.
//
// Adapters are stateless wrt the request: instantiated once per call from the
// folder row + (optional) oauth_profile row stored in D1. Add new providers
// by implementing this interface and teaching `factory.ts` to recognise them.

export type ResolvedUrl = {
  url: string;
  // Wall-clock ms when the URL stops working. Undefined means "stable".
  // The Worker can use this to set Cache-Control on 302 responses.
  expiresAt?: number;
  // Headers OUR OWN fetches must send — WebDAV's Basic auth. Only ever set on
  // probe URLs: a URL handed to a client can't carry a credential, which is
  // exactly why client streaming goes through the signed proxy instead.
  headers?: Record<string, string>;
};

export type RemoteEntry = {
  // Path relative to the folder root, with forward slashes, no leading slash.
  // For directories, no trailing slash.
  relPath: string;
  isDir: boolean;
  sizeBytes?: number;
  // Provider-native id (pCloud `fileid`, Dropbox path, S3 ETag, etc.). Empty
  // for adapters where there's no separate id concept.
  providerId?: string;
  // Last-modified ms-epoch when the provider exposes it.
  modifiedAt?: number;
};

export interface StorageAdapter {
  readonly provider: string;

  // Stream URL for the client. The Worker 302s here; bytes never traverse us.
  resolveUrl(relPath: string, providerFileId?: string | null): Promise<ResolvedUrl>;

  // Probe URL — usually identical to resolveUrl. Some providers (Dropbox)
  // distinguish between "stream" and "metadata" links; for those, override.
  resolveProbeUrl(relPath: string, providerFileId?: string | null): Promise<ResolvedUrl>;

  // List a folder. Adapters that can't list (PublicUrlAdapter without a
  // manifest) throw a marked error so callers fall back gracefully.
  listFolder(relPath: string): Promise<RemoteEntry[]>;

  // Recursive walk, filtered to audiobook file extensions. Default impl in the
  // base class; provider-specific adapters can override for efficiency.
  walkAudiobookFiles?(relPath: string): AsyncIterable<RemoteEntry>;
}

// Marker error from listFolder when the underlying provider has no listing
// API. Scanner catches this and falls back to "manifest required".
export class ListingNotSupportedError extends Error {
  constructor(provider: string) {
    super(`Provider ${provider} does not support folder listing`);
    this.name = 'ListingNotSupportedError';
  }
}

// File extensions we treat as audiobook media. m4b/m4a/aac all parse via the
// MP4 prober; mp3 parses via the MP3 prober (folders-of-chapter-files);
// opus/ogg via src/prober/ogg.ts (2026-09-02 — this list is what the pCloud
// walk filters on, so a prober without an entry here is never reached: the
// first Opus books sat on pCloud invisible to Scan for exactly that reason).
// webm is Opus in a seekable container via src/prober/webm.ts (2026-09-07).
// flac arrives when a prober for it lands.
export const AUDIOBOOK_EXTENSIONS = ['m4b', 'm4a', 'aac', 'mp3', 'opus', 'ogg', 'webm'] as const;

export function isAudiobookFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return (AUDIOBOOK_EXTENSIONS as readonly string[]).includes(ext);
}

// A write the storage refused or failed, from the methods Audible delivery
// uses (S3Adapter / WebDAVAdapter writes). `code` is S3's error code when
// there is one ('AccessDenied', 'NoSuchUpload'); for WebDAV, the method
// ('PATCH', 'MOVE').
export class StorageWriteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'StorageWriteError';
  }
}

// What a delivery needs to know about a path before and after writing it.
export type StoredFile = { size: number; modifiedAt: number | null; isDir: boolean };

// PUT/PATCH a stream of known length (an R2 read), never buffered: a Worker
// has 128 MB. If the server answers before reading it all (a refusal) or the
// fetch throws, the pipe is abandoned rather than awaited: a server that
// neither reads nor closes would otherwise hold it until the invocation dies.
export async function sendStream(url: string, init: { method: string; headers: Record<string, string> },
  body: ReadableStream, length: number, timeoutMs: number): Promise<Response> {
  const stop = new AbortController();
  const { readable, writable } = new FixedLengthStream(length);
  const piped = body.pipeTo(writable, { signal: stop.signal }).then(() => null, (e: unknown) => e);
  let res: Response;
  try {
    res = await fetch(url, { ...init, body: readable, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    stop.abort();
    throw e;
  }
  if (!res.ok) stop.abort();
  else await piped;
  return res;
}

// Calls that move no body get a minute; a server that never answers mustn't
// hold a cron invocation (and its lease) for its whole 15 minutes.
export const QUICK_MS = 60_000;
