// ABS wire shapes for podcast items and episodes, following ABS's
// Podcast.toOldJSON{,Minified,Expanded} and PodcastEpisode.toOldJSON{,Expanded}
// (server/models/Podcast.js, PodcastEpisode.js). The library-item wrapper is
// the same one books use (see abs-shapes.ts).

import type { LibraryFolderRow, LibraryItemRow } from '../db/library';
import type { EpisodeCounts, EpisodeRow, PodcastRow } from '../db/podcasts';
import { derivedId } from './ids';
import { storageLabel } from './storage-label';

export function podcastMetadata(p: PodcastRow) {
  return {
    title: p.title,
    author: p.author,
    description: p.description,
    releaseDate: p.release_date,
    genres: JSON.parse(p.genres || '[]') as string[],
    feedUrl: p.feed_url,
    imageUrl: p.image_url,
    itunesPageUrl: p.itunes_page_url,
    itunesId: p.itunes_id,
    itunesArtistId: p.itunes_artist_id,
    explicit: p.explicit === 1,
    language: p.language,
    type: p.podcast_type,
  };
}

function metadataExpanded(p: PodcastRow) {
  return { ...podcastMetadata(p), titleIgnorePrefix: titleIgnorePrefix(p.title) };
}

// ABS moves a leading article to the end: "The Daily" → "Daily, The".
function titleIgnorePrefix(title: string | null): string | null {
  if (!title) return title;
  const m = /^(the|a|an)\s+(.+)$/i.exec(title);
  return m ? `${m[2]}, ${m[1]}` : title;
}

// Not ABS fields: Pholia and /admin show and change them. Strict clients
// ignore unknown keys.
function shimFields(p: PodcastRow, folder?: LibraryFolderRow) {
  return {
    archive: p.archive === 1,
    // Whether archiving can work at all: only a pCloud library can take
    // copies (src/lib/podcasts.ts). Known only where the folder is loaded.
    ...(folder ? { canArchive: folder.provider === 'pcloud_oauth' } : {}),
    lastCheckError: p.last_error,
    nextEpisodeCheck: p.next_check_at,
  };
}

const coverPathFor = (itemId: string) => `/metadata/items/${itemId}/cover.jpg`;

export function episodeExt(e: EpisodeRow): string {
  const fromPath = /\.([a-z0-9]{2,4})$/i.exec((e.archive_rel_path ?? e.enclosure_url.split('?')[0]) || '')?.[1]?.toLowerCase();
  if (fromPath && ['mp3', 'm4a', 'mp4', 'aac', 'ogg', 'opus', 'oga', 'wav', 'flac', 'm4b'].includes(fromPath)) return fromPath;
  const t = (e.enclosure_type ?? '').toLowerCase();
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'm4a';
  if (t.includes('ogg') || t.includes('opus')) return 'ogg';
  return 'mp3';
}

export function episodeMime(e: EpisodeRow): string {
  const t = (e.enclosure_type ?? '').toLowerCase();
  if (t.startsWith('audio/') && t !== 'audio/x-m4a') return t;
  const ext = episodeExt(e);
  return ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' || ext === 'opus' || ext === 'oga' ? 'audio/ogg' : ext === 'wav' ? 'audio/wav' : ext === 'flac' ? 'audio/flac' : 'audio/mp4';
}

// What a client sees as the file name: the archived file's own name, or the
// episode title (enclosure URLs mostly end in "default.mp3" or a uuid).
export function episodeFilename(e: EpisodeRow): string {
  if (e.archive_state === 'done' && e.archive_rel_path) return e.archive_rel_path.split('/').pop()!;
  const base = (e.title ?? 'episode').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'episode';
  return `${base}.${episodeExt(e)}`;
}

export function episodeSize(e: EpisodeRow): number {
  return e.size_bytes || e.enclosure_length || 0;
}

function episodeAudioFile(e: EpisodeRow, folder: LibraryFolderRow, item: LibraryItemRow) {
  const filename = episodeFilename(e);
  const ext = '.' + episodeExt(e);
  const size = episodeSize(e);
  const archived = e.archive_state === 'done' && !!e.archive_rel_path;
  return {
    index: 1,
    ino: e.ino,
    metadata: {
      filename,
      ext,
      path: archived ? e.archive_rel_path! : `${item.rel_path}/${filename}`,
      relPath: filename,
      size,
      mtimeMs: e.updated_at,
      ctimeMs: e.created_at,
      birthtimeMs: 0,
    },
    addedAt: e.created_at,
    updatedAt: e.updated_at,
    trackNumFromMeta: null,
    discNumFromMeta: null,
    trackNumFromFilename: null,
    discNumFromFilename: null,
    manuallyVerified: false,
    exclude: false,
    error: null,
    // Not ABS: where the bytes come from — the library's storage once the
    // episode is archived, the publisher until then (see abs-shapes' note).
    storage: archived ? storageLabel(folder) : { provider: 'remote', name: hostOf(e.enclosure_url), detail: '' },
    format: ext.slice(1).toUpperCase(),
    duration: e.duration_seconds,
    bitRate: size && e.duration_seconds ? Math.round((size * 8) / e.duration_seconds) : null,
    language: null,
    codec: ext === '.mp3' ? 'mp3' : ext === '.ogg' || ext === '.opus' ? 'opus' : 'aac',
    timeBase: '1/1000',
    channels: 2,
    channelLayout: 'stereo',
    chapters: [],
    embeddedCoverArt: null,
    metaTags: {},
    mimeType: episodeMime(e),
  };
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

export async function buildEpisode(e: EpisodeRow, item: LibraryItemRow) {
  const podcastId = await derivedId(item.id, 'media');
  const enclosure = {
    url: e.enclosure_url,
    type: e.enclosure_type,
    length: e.enclosure_length != null ? String(e.enclosure_length) : null,
  };
  return {
    libraryItemId: item.id,
    podcastId,
    id: e.id,
    oldEpisodeId: null,
    index: e.idx,
    season: e.season ?? '',
    episode: e.episode ?? '',
    episodeType: e.episode_type ?? '',
    title: e.title ?? '',
    subtitle: e.subtitle ?? '',
    description: e.description ?? '',
    enclosure,
    guid: e.guid,
    pubDate: e.pub_date ?? '',
    chapters: JSON.parse(e.chapters || '[]') as unknown[],
    audioFile: null as unknown,
    publishedAt: e.published_at,
    addedAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

export async function buildEpisodeExpanded(e: EpisodeRow, item: LibraryItemRow, folder: LibraryFolderRow) {
  const json = await buildEpisode(e, item);
  const audioFile = episodeAudioFile(e, folder, item);
  return {
    ...json,
    audioFile,
    // Not ABS: whether the episode's bytes are in the library's storage yet,
    // and if not why. Pholia shows it per episode.
    archiveState: e.archive_state,
    archiveError: e.archive_error,
    audioTrack: {
      ...audioFile,
      startOffset: 0,
      title: audioFile.metadata.filename,
      index: 1,
      contentUrl: `/api/items/${item.id}/file/${e.ino}`,
    },
    size: episodeSize(e),
    duration: e.duration_seconds,
  };
}

function itemWrapper(item: LibraryItemRow, size: number, numFiles: number) {
  return {
    id: item.id,
    ino: item.ino,
    oldLibraryItemId: null,
    libraryId: item.library_id,
    folderId: item.folder_id,
    path: item.rel_path,
    relPath: item.rel_path,
    isFile: false,
    mtimeMs: item.updated_at,
    ctimeMs: item.updated_at,
    birthtimeMs: 0,
    addedAt: item.created_at,
    updatedAt: item.updated_at,
    isMissing: item.is_missing === 1,
    isInvalid: item.is_invalid === 1,
    mediaType: 'podcast',
    numFiles,
    size,
  };
}

function settings(p: PodcastRow) {
  return {
    autoDownloadEpisodes: p.auto_download === 1,
    autoDownloadSchedule: p.auto_download_schedule ?? '0 * * * *',
    lastEpisodeCheck: p.last_episode_check,
    maxEpisodesToKeep: p.max_episodes_to_keep,
    maxNewEpisodesToDownload: p.max_new_episodes_to_download,
  };
}

export async function buildPodcastItemMinified(item: LibraryItemRow, p: PodcastRow, counts: EpisodeCounts | undefined) {
  const size = counts?.size ?? 0;
  return {
    ...itemWrapper(item, size, counts?.numEpisodes ?? 0),
    media: {
      id: await derivedId(item.id, 'media'),
      metadata: metadataExpanded(p),
      coverPath: coverPathFor(item.id),
      tags: JSON.parse(p.tags || '[]') as string[],
      numEpisodes: counts?.numEpisodes ?? 0,
      ...settings(p),
      size,
      ...shimFields(p),
    },
  };
}

export async function buildPodcastItemExpanded(
  item: LibraryItemRow, folder: LibraryFolderRow, p: PodcastRow, episodes: EpisodeRow[],
  opts?: { userMediaProgress?: unknown | null },
) {
  const size = episodes.reduce((s, e) => s + episodeSize(e), 0);
  const eps = await Promise.all(episodes.map((e) => buildEpisodeExpanded(e, item, folder)));
  return {
    ...itemWrapper(item, size, episodes.length),
    lastScan: item.updated_at,
    scanVersion: '2.34.0',
    ...(opts?.userMediaProgress != null ? { userMediaProgress: opts.userMediaProgress } : {}),
    media: {
      id: await derivedId(item.id, 'media'),
      libraryItemId: item.id,
      metadata: metadataExpanded(p),
      coverPath: coverPathFor(item.id),
      tags: JSON.parse(p.tags || '[]') as string[],
      numEpisodes: episodes.length,
      ...settings(p),
      size,
      episodes: eps,
      ...shimFields(p, folder),
    },
    libraryFiles: eps.map((e) => ({
      ino: e.audioFile.ino,
      metadata: e.audioFile.metadata,
      isSupplementary: null,
      addedAt: e.addedAt,
      updatedAt: e.updatedAt,
      fileType: 'audio',
    })),
  };
}

// ABS's `podcast` object on a recent-episodes / shelf entry: toOldJSON with
// the episode list emptied.
export async function buildPodcastOld(item: LibraryItemRow, p: PodcastRow) {
  return {
    id: await derivedId(item.id, 'media'),
    libraryItemId: item.id,
    metadata: podcastMetadata(p),
    coverPath: coverPathFor(item.id),
    tags: JSON.parse(p.tags || '[]') as string[],
    episodes: [] as unknown[],
    ...settings(p),
  };
}
