import { ListingNotSupportedError, type RemoteEntry, type ResolvedUrl, type StorageAdapter } from './adapter';

// Adapter for storage backends that expose stable, range-supporting public
// URLs: pCloud filedn public folders, R2 with public domain, B2 public
// buckets, S3 website-mode, GCS public buckets, etc.
//
// Configuration is just a base URL. We have no listing API (filedn returns an
// HTML page, not a directory listing) so listFolder throws — the scanner falls
// back to manifest-driven mode.
//
// Back-compat: when a library_folders row was created in the original schema,
// `filedn_base_url` was the only configured field. The factory passes it as
// `baseUrl` so this adapter Just Works for the existing seed.

export type PublicUrlConfig = {
  baseUrl: string;        // e.g. 'https://filedn.com/<token>/audiobooks/'
};

export class PublicUrlAdapter implements StorageAdapter {
  readonly provider = 'public_url';
  private base: string;

  constructor(config: PublicUrlConfig) {
    // Normalise: ensure trailing slash so URL resolution works as expected.
    this.base = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
  }

  resolveUrl(relPath: string): Promise<ResolvedUrl> {
    // No expiry — URLs are stable. The Worker can long-cache the 302.
    return Promise.resolve({ url: this.join(relPath) });
  }

  resolveProbeUrl(relPath: string): Promise<ResolvedUrl> {
    return this.resolveUrl(relPath);
  }

  listFolder(_relPath: string): Promise<RemoteEntry[]> {
    return Promise.reject(new ListingNotSupportedError(this.provider));
  }

  private join(rel: string): string {
    // Strip any leading slash so URL resolution treats `rel` as relative to
    // the base. We URL-encode each segment but preserve the path separators.
    const trimmed = rel.replace(/^\/+/, '');
    const encoded = trimmed.split('/').map(encodeURIComponent).join('/');
    return new URL(encoded, this.base).toString();
  }
}
