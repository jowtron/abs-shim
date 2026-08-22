// Real-Debrid REST client — just the torrent + unrestrict calls the ABB flow
// needs. Bearer token, form-encoded bodies, JSON errors {error, error_code}.
// selectFiles/delete answer 204 with no body.

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

export const AUDIO_EXT = new Set(['m4b', 'm4a', 'aac', 'mp3', 'flac', 'ogg', 'opus', 'wma', 'wav']);
export const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz']);
export const extOf = (name: string): string => (/\.([A-Za-z0-9]+)$/.exec(name ?? '')?.[1] ?? '').toLowerCase();

// States that never reach "downloaded".
export const RD_FAILED: Record<string, string> = {
  magnet_error: 'Real-Debrid could not parse the magnet link',
  error: 'Real-Debrid reported an error on this torrent',
  virus: 'Real-Debrid flagged this torrent as a virus',
  dead: 'Torrent is dead (no seeds)',
};

export type RdFile = { id: number; path: string; bytes: number; selected: number };
export type RdTorrentInfo = {
  id: string; filename: string; hash: string; bytes: number; status: string; progress: number;
  seeders?: number; speed?: number; files?: RdFile[]; links?: string[];
};
export type RdUnrestricted = { download: string; filename: string; filesize: number; mimeType?: string };

async function rd<T>(token: string, method: string, path: string, body?: Record<string, string>): Promise<T> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body) {
    init.headers = { ...(init.headers as Record<string, string>), 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = new URLSearchParams(body);
  }
  const resp = await fetch(RD_BASE + path, init);
  if (resp.status === 204) return {} as T;
  const data = await resp.json().catch(() => ({})) as { error?: string };
  if (!resp.ok) throw new Error(`Real-Debrid ${resp.status}: ${data.error ?? resp.statusText}`);
  return data as T;
}

export const rdUser = (token: string) => rd<{ username: string; premium: number; expiration: string; type: string }>(token, 'GET', '/user');
export const rdInfo = (token: string, id: string) => rd<RdTorrentInfo>(token, 'GET', `/torrents/info/${encodeURIComponent(id)}`);
export const rdList = (token: string) => rd<RdTorrentInfo[]>(token, 'GET', '/torrents?limit=100');
export const rdAddMagnet = (token: string, magnet: string) => rd<{ id: string }>(token, 'POST', '/torrents/addMagnet', { magnet });
export const rdSelectFiles = (token: string, id: string, files: string) => rd<void>(token, 'POST', `/torrents/selectFiles/${encodeURIComponent(id)}`, { files });
export const rdDelete = (token: string, id: string) => rd<void>(token, 'DELETE', `/torrents/delete/${encodeURIComponent(id)}`);
export const rdUnrestrict = (token: string, link: string) => rd<RdUnrestricted>(token, 'POST', '/unrestrict/link', { link });

// Right after addMagnet the torrent sits in magnet_conversion with files: []
// for a few seconds. Poll until the file list is populated (or the torrent
// fails). Bounded so a single Worker request can't burn its subrequest cap.
export async function rdWaitForFiles(token: string, id: string, maxPolls = 10): Promise<RdTorrentInfo> {
  let info = await rdInfo(token, id);
  for (let i = 0; i < maxPolls && !(info.files?.length) && !RD_FAILED[info.status]; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    info = await rdInfo(token, id);
  }
  return info;
}

// Audio files only — drops .pad/N padding entries and pdf/jpg/nfo/cue clutter.
export function audioFiles(info: RdTorrentInfo): RdFile[] {
  return (info.files ?? []).filter((f) => !/\/?\.pad\//.test(f.path) && AUDIO_EXT.has(extOf(f.path)));
}
