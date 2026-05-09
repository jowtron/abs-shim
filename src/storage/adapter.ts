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
// same MP4 prober. mp3/opus arrive in phase 2.
export const AUDIOBOOK_EXTENSIONS = ['m4b', 'm4a', 'aac'] as const;

export function isAudiobookFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return (AUDIOBOOK_EXTENSIONS as readonly string[]).includes(ext);
}
