// "Where does this book actually live" in a few words.
//
// A library can have several storage backends at once, and until 2026-09-05
// nothing in either UI said which one a given book came from — with the same
// title present on two backends (Flybot was, on pCloud and the NAS) there was
// no way to tell the two entries apart. Used by the scan report, /admin's
// folder rows, and the `storage` field on every audioFile in the ABS wire
// shape, which is what Pholia shows on the book page and the file-info panel.

export type StorageLabel = {
  provider: string;   // raw provider id, for icons or conditionals
  name: string;       // short: 'pCloud', a bucket, a hostname
  detail: string;     // path within it, '' when there isn't one
};

const hostOf = (url: string): string => {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
};

export function storageLabel(folder: { provider?: string | null; config_json?: string | null; filedn_base_url?: string | null }): StorageLabel {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(folder.config_json || '{}') as Record<string, unknown>; } catch { /* unparseable — treat as empty */ }
  const str = (k: string) => String(config[k] ?? '').replace(/^\/+|\/+$/g, '');
  const provider = folder.provider ?? 'public_url';

  switch (provider) {
    case 'pcloud_oauth': return { provider, name: 'pCloud', detail: str('rootPath') };
    case 's3': return { provider, name: str('bucket') || hostOf(String(config['endpoint'] ?? '')), detail: str('prefix') };
    case 'webdav': return { provider, name: hostOf(String(config['baseUrl'] ?? '')), detail: str('rootPath') };
    case 'public_url': {
      const base = String(config['baseUrl'] ?? '') || folder.filedn_base_url || '';
      return { provider, name: hostOf(base), detail: '' };
    }
    default: return { provider, name: provider, detail: '' };
  }
}

// One-line form for logs and plain-text reports.
export const storageLabelText = (folder: Parameters<typeof storageLabel>[0]): string => {
  const l = storageLabel(folder);
  return l.detail ? `${l.name} /${l.detail}` : l.name;
};
