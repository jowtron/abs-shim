// ABS wire shapes for podcast items and episodes, following ABS's
// Podcast.toOldJSON{,Minified,Expanded} and PodcastEpisode.toOldJSON{,Expanded}
// (server/models/Podcast.js, PodcastEpisode.js). The library-item wrapper is
// the same one books use (see abs-shapes.ts).

import type { LibraryFolderRow, LibraryItemRow } from '../db/library';
import type { EpisodeCounts, EpisodeRow, PodcastRow } from '../db/podcasts';
import type { FollowInfo } from '../db/podcast-follows';
import { derivedId } from './ids';
import { stripAllTags } from './rss';
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

// A show's intro/outro skipping (migration 0020), applied by the player.
// Each end is skipped by whole chapters or by seconds, never both; chapters
// win when both are sent. Anything else is dropped, and nothing left = null.
// `ads` (2026-10-13): which of an episode's analysed ad ranges the player
// skips by itself — 'inserted' (the default, so never stored: inserted ads
// found with confidence >= 0.8), 'all', or 'off'. Ads it doesn't skip get a
// "Skip ad" button while playing.
export type AdSkip = 'inserted' | 'all' | 'off';
export type PodcastSkip = { startChapters?: number; startSeconds?: number; endChapters?: number; endSeconds?: number; ads?: AdSkip };
export function normalizeSkip(v: unknown): PodcastSkip | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const int = (k: string, max: number) => {
    const n = o[k];
    return typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= max ? Math.round(n) : undefined;
  };
  const out: PodcastSkip = {};
  const sc = int('startChapters', 10), ss = int('startSeconds', 1800);
  const ec = int('endChapters', 10), es = int('endSeconds', 1800);
  if (sc) out.startChapters = sc; else if (ss) out.startSeconds = ss;
  if (ec) out.endChapters = ec; else if (es) out.endSeconds = es;
  if (o['ads'] === 'all' || o['ads'] === 'off') out.ads = o['ads'];
  return Object.keys(out).length ? out : null;
}
function parseSkip(json: string | null): PodcastSkip | null {
  if (!json) return null;
  try { return normalizeSkip(JSON.parse(json)); } catch { return null; }
}

// Not ABS fields: Pholia and /admin show and change them. Strict clients
// ignore unknown keys.
function shimFields(p: PodcastRow, folder?: LibraryFolderRow) {
  return {
    archive: p.archive === 1,
    // Seconds left at which an episode counts as played; null = the
    // library's markAsFinishedTimeRemaining (migration 0019).
    markAsFinishedTimeRemaining: p.finish_remaining_seconds ?? null,
    // Intro/outro skipping, done by the player (migration 0020).
    skip: parseSkip(p.skip_json),
    // Episode analysis on wharf (migration 0025): null = auto, 'on', 'off'.
    analyse: p.analyse ?? null,
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

// Show notes in a LIST of episodes are a short plain-text snippet. A show's
// item carried every on-show episode's full notes: 101 episodes of Linux &
// Open Source News were 1.1 MB, 668 KB of it notes, fetched on every show
// page and playlist. Notes up to NOTES_WHOLE characters still go out whole,
// markup and links included; longer ones become a snippet (HTML-escaped,
// since the bundled web UI renders `description` as HTML) with the shim
// extra `descriptionTrimmed: true`. The full notes come from GET
// /api/podcasts/:id/episode/:episodeId, which Pholia's episode page asks
// for when it opens. The key and its type never change, for strict clients.
const NOTES_WHOLE = 400;
const NOTES_SNIPPET = 280;

export function notesForList(html: string): { description: string; trimmed: boolean } {
  if (html.length <= NOTES_WHOLE) return { description: html, trimmed: false };
  const chars = [...stripAllTags(html).replace(/\s+/g, ' ').trim()];   // code points: never half an emoji
  let text = chars.join('');
  if (chars.length > NOTES_SNIPPET) {
    text = chars.slice(0, NOTES_SNIPPET).join('');
    const space = text.lastIndexOf(' ');
    if (space > NOTES_SNIPPET * 0.6) text = text.slice(0, space);
    text = text.replace(/[\s,;:.!?-]+$/, '') + '…';
  }
  return { description: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), trimmed: true };
}

// `fullNotes`: the episode on its own (GET /api/podcasts/:id/episode/:id, a
// play session's item), which carries the whole notes.
export async function buildEpisode(e: EpisodeRow, item: LibraryItemRow, opts: { fullNotes?: boolean } = {}) {
  const podcastId = await derivedId(item.id, 'media');
  const enclosure = {
    url: e.enclosure_url,
    type: e.enclosure_type,
    length: e.enclosure_length != null ? String(e.enclosure_length) : null,
  };
  const notes = opts.fullNotes ? { description: e.description ?? '', trimmed: false } : notesForList(e.description ?? '');
  const analysis = currentAnalysis(e);
  const served = servedChapters(e, analysis);
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
    description: notes.description,
    // Not ABS: `description` is a snippet; the episode's own route has it all.
    descriptionTrimmed: notes.trimmed,
    enclosure,
    guid: e.guid,
    pubDate: e.pub_date ?? '',
    // In the served file's time when the episode has been analysed (the
    // publisher's shifted through its offsets, or generated ones).
    chapters: served.chapters as unknown[],
    audioFile: null as unknown,
    publishedAt: e.published_at,
    addedAt: e.created_at,
    updatedAt: e.updated_at,
    // Not ABS: archive progress (queued / fetching / done / error), so a
    // client can follow one episode with GET /api/podcasts/:id/episode/:id.
    archiveState: e.archive_state,
    archiveError: e.archive_error,
    // Not ABS: the feed's <podcast:transcript> links. A client reads the
    // parsed text from GET /api/podcasts/:id/episode/:id/transcript.
    transcripts: (JSON.parse(e.transcripts || '[]') as Array<{ url: string; type: string | null; language: string | null }>)
      .map((t) => ({ url: t.url, type: t.type, language: t.language })),
    // Not ABS: the audio host stitches ads into the file at download time,
    // so the feed's chapter and transcript times (made from the master)
    // run early by the ads played before them, differently per listener.
    dynamicAds: hasDynamicAds(e.enclosure_url),
    // Not ABS: the analysis of the file served now (size, ad ranges, where
    // the chapters and transcript come from), or null when there's none
    // for this size (src/lib/episode-analysis.ts).
    analysis: analysisField(e, analysis, served.source),
  };
}

// Hosts that insert ads per download (verified 2026-10-12: art19 served
// this Worker and a home connection two different LINUX Unplugged files,
// 41 s apart after the mid-roll; Audioboom's No Such Thing As A Fish
// differed by two minutes). Tracking prefixes (podtrac, chartable, op3,
// podscribe, mgln) only redirect and aren't listed.
const DYNAMIC_AD_HOSTS = ['art19.com', 'audioboom.com', 'megaphone.fm', 'simplecastaudio.com', 'simplecast.com',
  'acast.com', 'omny.fm', 'omnycontent.com', 'anchor.fm', 'spotify.com', 'adswizz.com', 'spreaker.com'];
// One identity for every request that touches an episode's audio (the
// stream proxy and the chapter/length probe): art19 served this Worker's
// home-network twin three different stitches of one episode under three
// User-Agents (4350 s, 4429 s, 4441 s). The length recorded must be the
// file that is then streamed.
export const EPISODE_AUDIO_UA = 'audiobookshelf (+https://audiobookshelf.org; like iTMS)';

export function hasDynamicAds(url: string | null | undefined): boolean {
  const u = (url || '').toLowerCase();
  return DYNAMIC_AD_HOSTS.some((h) => u.includes(h));
}

// ─── Episode analysis (migration 0025, src/lib/episode-analysis.ts) ─────────
//
// The node transcribes the file this shim serves and aligns the publisher's
// transcript (made from the master) against it. Its answer is a piecewise
// map from master time to served time: `offsets` (each master range has its
// own shift, served = master + shift) and `cuts` (master audio the served
// file doesn't have: art19 replaces the master's own sponsor read). Every
// client gets corrected times from here, so chapter lists, the transcript
// follow and chapter-based intro skips need nothing new.

export type AnalysisOffset = { from: number; to: number; shift: number };
export type AnalysisCut = { from: number; to: number };
export type AnalysisAd = { start: number; end: number; kind: string; confidence: number; source: string; label: string | null };
// podcast_episodes.analysis: the episode's newest finished analysis.
export type AnalysisSummary = {
  size: number;
  duration: number | null;
  offsets: AnalysisOffset[];
  cuts: AnalysisCut[];
  ads: AnalysisAd[];
  chapters: Array<{ start: number; title: string }> | null;   // generated (LLM) chapters only
  transcript: 'publisher' | 'whisper' | null;
  at: number;
};

// Ported from align.py's master_to_served: a time inside a cut lands where
// the cut ends (the served file goes on from there); a time exactly at an
// insertion point lands AFTER the ad; outside every range, the nearest
// end's shift applies.
export function masterToServed(m: number, offsets: AnalysisOffset[], cuts: AnalysisCut[]): number {
  for (const c of cuts) {
    if (c.from <= m && m < c.to) { m = c.to; break; }
  }
  for (const o of offsets) {
    if (o.from <= m && m < o.to) return m + o.shift;
  }
  if (offsets.length) {
    const o = m < offsets[0]!.from ? offsets[0]! : offsets[offsets.length - 1]!;
    return m + o.shift;
  }
  return m;
}

// align.py's shift_cues: a cue said only in the master (wholly inside a cut)
// is dropped; the rest move by the shift of where they start and end.
export function cuesToServed<T extends { start: number; end: number }>(cues: T[], offsets: AnalysisOffset[], cuts: AnalysisCut[]): T[] {
  const out: T[] = [];
  for (const c of cues) {
    if (cuts.some((k) => k.from <= c.start && c.end <= k.to)) continue;
    const s = masterToServed(c.start, offsets, cuts);
    const e = masterToServed(Math.max(c.start, c.end - 0.001), offsets, cuts);
    out.push({ ...c, start: Math.round(s * 1000) / 1000, end: Math.round(Math.max(s, e) * 1000) / 1000 });
  }
  return out;
}

// The summary when it describes the file being served now, else null: a
// restitched file (another size) has other ads in other places, and is
// served as before the analysis until the pump catches up.
export function currentAnalysis(e: EpisodeRow): AnalysisSummary | null {
  if (!e.analysis || !(e.size_bytes > 0)) return null;
  try {
    const a = JSON.parse(e.analysis) as AnalysisSummary;
    return a && a.size === e.size_bytes ? a : null;
  } catch { return null; }
}

type StoredChapter = { id?: number; start: number; end: number; title: string };

// Publisher chapters are in master time: shifted through the analysis when
// there is one. Without publisher chapters, the analysis's generated ones.
export function servedChapters(e: EpisodeRow, a: AnalysisSummary | null): { chapters: StoredChapter[]; source: 'publisher' | 'generated' | null } {
  const pub = JSON.parse(e.chapters || '[]') as StoredChapter[];
  const total = a?.duration || e.duration_seconds || 0;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  if (pub.length) {
    if (!a || !a.offsets.length) return { chapters: pub, source: 'publisher' };
    const starts = pub.map((c) => (c.start <= 0.5 ? 0 : masterToServed(c.start, a.offsets, a.cuts)));
    return {
      chapters: pub.map((c, i) => ({
        id: c.id ?? i,
        start: r3(starts[i]!),
        end: r3(i + 1 < starts.length ? Math.max(starts[i]!, starts[i + 1]!) : Math.max(starts[i]!, total)),
        title: c.title,
      })),
      source: 'publisher',
    };
  }
  if (a?.chapters?.length) {
    const gen = a.chapters;
    return {
      chapters: gen.map((c, i) => ({ id: i, start: r3(c.start), end: r3(i + 1 < gen.length ? gen[i + 1]!.start : Math.max(c.start, total)), title: c.title })),
      source: 'generated',
    };
  }
  return { chapters: pub, source: null };
}

// The shim extra `analysis` on an episode. `aligned`: every time this
// episode serves is the file's own — the publisher's were mapped, or there
// were none to map (generated chapters, a speech-recognition transcript).
export function analysisField(e: EpisodeRow, a: AnalysisSummary | null, chaptersSource: 'publisher' | 'generated' | null) {
  if (!a) return null;
  const mapped = a.offsets.length > 0;
  return {
    size: a.size,
    aligned: mapped || (chaptersSource !== 'publisher' && a.transcript !== 'publisher'),
    ads: a.ads,
    chaptersSource,
    transcriptSource: a.transcript,
  };
}

// `progress`: the caller's progress by episode id (progressForShows). When
// given, every episode carries the shim extra `mediaProgress` (its ABS
// progress object, or null), so a list says what is played without the
// client fetching /api/me, which no longer carries every row.
export type EpisodeListOpts = { fullNotes?: boolean; progress?: Map<string, unknown> };

export async function buildEpisodeExpanded(e: EpisodeRow, item: LibraryItemRow, folder: LibraryFolderRow, opts: EpisodeListOpts = {}) {
  const json = await buildEpisode(e, item, opts.fullNotes ? { fullNotes: true } : {});
  const audioFile = episodeAudioFile(e, folder, item);
  return {
    ...json,
    ...(opts.progress ? { mediaProgress: opts.progress.get(e.id) ?? null } : {}),
    audioFile,
    // Not ABS: whether this episode can be archived at all (its library is
    // on pCloud) — every list carries the episode, not always the show.
    canArchive: folder.provider === 'pcloud_oauth',
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

// Not ABS (migration 0028): whether the caller follows the show, and how
// many people do. On the item, where Pholia reads it, and in `media` beside
// the other shim extras; strict clients ignore both. Absent when the caller
// didn't look it up (a play session's item).
function followFields(follow: FollowInfo | undefined) {
  return follow ? { following: follow.following, followers: follow.followers } : {};
}

export async function buildPodcastItemMinified(item: LibraryItemRow, p: PodcastRow, counts: EpisodeCounts | undefined, follow?: FollowInfo) {
  const size = counts?.size ?? 0;
  return {
    ...itemWrapper(item, size, counts?.numEpisodes ?? 0),
    ...followFields(follow),
    media: {
      id: await derivedId(item.id, 'media'),
      metadata: metadataExpanded(p),
      coverPath: coverPathFor(item.id),
      tags: JSON.parse(p.tags || '[]') as string[],
      numEpisodes: counts?.numEpisodes ?? 0,
      ...settings(p),
      size,
      ...shimFields(p),
      ...followFields(follow),
    },
  };
}

export async function buildPodcastItemExpanded(
  item: LibraryItemRow, folder: LibraryFolderRow, p: PodcastRow, episodes: EpisodeRow[],
  opts?: { userMediaProgress?: unknown | null; follow?: FollowInfo } & EpisodeListOpts,
) {
  const size = episodes.reduce((s, e) => s + episodeSize(e), 0);
  const listOpts: EpisodeListOpts = {
    ...(opts?.fullNotes ? { fullNotes: true } : {}),
    ...(opts?.progress ? { progress: opts.progress } : {}),
  };
  const eps = await Promise.all(episodes.map((e) => buildEpisodeExpanded(e, item, folder, listOpts)));
  return {
    ...itemWrapper(item, size, episodes.length),
    ...followFields(opts?.follow),
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
      ...followFields(opts?.follow),
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
    // Shim extra: the show's intro/outro and ad skipping. Pholia's Latest
    // tab builds the show its rows play from this object; without it (until
    // 2026-10-21) an episode started from Latest skipped nothing, neither
    // the intro chapters nor, under "all ads", anything but inserted ones.
    skip: parseSkip(p.skip_json),
  };
}
