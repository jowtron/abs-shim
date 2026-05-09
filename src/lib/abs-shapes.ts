// Builders that turn D1 rows into ABS-compatible JSON shapes. Targets are the
// captured fixtures under .local/fixtures/ — keep these functions in lockstep
// with whatever real ABS emits.

import type {
  AudioFileRow, BookMetadataRow, ChapterRow, LibraryFolderRow,
  LibraryItemRow, LibraryRow,
} from '../db/library';
import { derivedId } from './ids';

// ─── Library detail ──────────────────────────────────────────────────────────

export function buildLibrary(row: LibraryRow, folders: LibraryFolderRow[]) {
  return {
    id: row.id,
    name: row.name,
    folders: folders.map((f) => ({
      id: f.id,
      // ABS expects a `fullPath` per folder. We synthesise it from the filedn
      // base URL — clients display this for diagnostic purposes only.
      fullPath: f.filedn_base_url,
      libraryId: f.library_id,
      addedAt: f.added_at,
    })),
    displayOrder: row.display_order,
    icon: row.icon,
    mediaType: row.media_type,
    provider: row.provider,
    settings: defaultLibrarySettings(JSON.parse(row.settings || '{}') as Record<string, unknown>),
    lastScan: row.updated_at,
    lastScanVersion: '2.34.0',
    createdAt: row.created_at,
    lastUpdate: row.updated_at,
  };
}

function defaultLibrarySettings(overrides: Record<string, unknown>) {
  return {
    coverAspectRatio: 1,
    disableWatcher: false,
    autoScanCronExpression: null,
    skipMatchingMediaWithAsin: false,
    skipMatchingMediaWithIsbn: false,
    audiobooksOnly: false,
    epubsAllowScriptedContent: false,
    hideSingleBookSeries: false,
    onlyShowLaterBooksInContinueSeries: false,
    metadataPrecedence: ['folderStructure', 'audioMetatags', 'nfoFile', 'txtFiles', 'opfFile', 'absMetadata'],
    markAsFinishedPercentComplete: null,
    markAsFinishedTimeRemaining: 10,
    ...overrides,
  };
}

// ─── Library item (full detail) ──────────────────────────────────────────────

type ItemBundle = {
  item: LibraryItemRow;
  folder: LibraryFolderRow;
  metadata: BookMetadataRow | null;
  audioFiles: AudioFileRow[];
  chapters: ChapterRow[];
};

export async function buildItemDetail(b: ItemBundle, opts?: { userMediaProgress?: unknown | null }) {
  const mediaId = await derivedId(b.item.id, 'media');
  const path = synthPath(b.folder, b.item);

  return {
    id: b.item.id,
    ino: b.item.ino,
    oldLibraryItemId: null,
    libraryId: b.item.library_id,
    folderId: b.item.folder_id,
    path,
    relPath: b.item.rel_path,
    isFile: b.item.is_file === 1,
    mtimeMs: b.item.updated_at,
    ctimeMs: b.item.updated_at,
    birthtimeMs: 0,
    addedAt: b.item.created_at,
    updatedAt: b.item.updated_at,
    lastScan: b.item.updated_at,
    scanVersion: '2.34.0',
    isMissing: b.item.is_missing === 1,
    isInvalid: b.item.is_invalid === 1,
    mediaType: b.item.media_type,
    // Stock ABS embeds the caller's progress here when /api/items/:id is
    // queried with ?include=progress. Plappa (and other ABS clients) rely on
    // this for "resume from last position" — without it, opening a book that
    // already has a media_progress row shows it as unplayed.
    ...(opts?.userMediaProgress != null ? { userMediaProgress: opts.userMediaProgress } : {}),
    media: {
      id: mediaId,
      libraryItemId: b.item.id,
      metadata: await buildBookMetadataDetail(b.item.id, b.metadata),
      coverPath: b.metadata?.cover_url ?? defaultCoverPath(b.item.id),
      tags: b.metadata ? JSON.parse(b.metadata.tags || '[]') : [],
      audioFiles: await Promise.all(b.audioFiles.map((a) => buildAudioFile(a, b.folder, b.item))),
      // ABS exposes both `audioFiles` (the source files) and `tracks` (what
      // gets played, identical to audioFiles for direct play). ShelfPlayer's
      // playableItem() reads `tracks` exclusively — without it, every book
      // click throws notFound and ShelfPlayer goes offline. Don't drop this.
      tracks: buildTracks(b),
      chapters: b.chapters.map((c, i) => ({
        id: i,
        title: c.title,
        start: c.start_seconds,
        end: c.end_seconds,
      })),
      ebookFile: null,
    },
    libraryFiles: b.audioFiles.map((a) => buildLibraryFile(a, b.folder, b.item)),
  };
}

async function buildBookMetadataDetail(itemId: string, m: BookMetadataRow | null) {
  if (!m) {
    return {
      title: null, subtitle: null, authors: [], narrators: [], series: [], genres: [],
      publishedYear: null, publishedDate: null, publisher: null, description: null,
      isbn: null, asin: null, language: null, explicit: false, abridged: false,
    };
  }
  const authors = await Promise.all(splitNames(m.author_name).map(async (name) => ({
    id: await derivedId(itemId, 'author', name),
    name,
  })));
  const series = m.series_name
    ? [{
        id: await derivedId(itemId, 'series', m.series_name),
        name: m.series_name,
        sequence: m.series_sequence,
      }]
    : [];
  return {
    title: m.title,
    subtitle: m.subtitle,
    authors,
    narrators: splitNames(m.narrator_name),
    series,
    genres: JSON.parse(m.genres || '[]'),
    // ABS emits publishedYear as a STRING (e.g. "2018"), not a number.
    // ShelfPlayer's strict Codable parser will fail the entire ItemPayload
    // decode if this is a JSON number — and an array-decode failure wipes
    // the whole shelf, not just the offending item. Don't change this.
    publishedYear: m.publish_year != null ? String(m.publish_year) : null,
    publishedDate: null,
    publisher: m.publisher,
    description: m.description,
    isbn: m.isbn,
    asin: m.asin,
    language: m.language,
    explicit: m.explicit === 1,
    abridged: m.abridged === 1,
  };
}

function splitNames(s: string | null): string[] {
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function synthPath(folder: LibraryFolderRow, item: LibraryItemRow): string {
  // We don't have a real filesystem; surface a plausible-looking value that
  // mirrors ABS's `<folder.fullPath>/<item.relPath>` convention.
  return joinUrlOrPath(folder.filedn_base_url, item.rel_path);
}

function joinUrlOrPath(base: string, rel: string): string {
  if (base.endsWith('/')) return base + rel;
  return base + '/' + rel;
}

function buildAudioFile(a: AudioFileRow, folder: LibraryFolderRow, item: LibraryItemRow) {
  const filename = filenameFromUrl(a.filedn_url);
  const ext = extOfFilename(filename);
  const fullPath = joinUrlOrPath(synthPath(folder, item), filename);
  return {
    index: a.index_no,
    ino: a.ino,
    metadata: {
      filename,
      ext,
      path: fullPath,
      relPath: filename,
      size: a.size_bytes,
      mtimeMs: a.added_at,
      ctimeMs: a.added_at,
      birthtimeMs: 0,
    },
    addedAt: a.added_at,
    updatedAt: a.added_at,
    trackNumFromMeta: null,
    discNumFromMeta: null,
    trackNumFromFilename: null,
    discNumFromFilename: null,
    manuallyVerified: false,
    exclude: false,
    error: null,
    format: a.format ?? 'mp4',
    duration: a.duration_seconds,
    bitRate: a.bitrate,
    language: 'und',
    codec: a.codec,
    timeBase: a.sample_rate ? `1/${a.sample_rate}` : '1/1000',
    channels: a.channels,
    channelLayout: a.channels === 2 ? 'stereo' : a.channels === 1 ? 'mono' : null,
    chapters: [],
    embeddedCoverArt: null,
    metaTags: {},
    mimeType: a.mime_type ?? 'audio/mp4',
  };
}

// Build the `media.tracks` array. One entry per audio file with cumulative
// startOffset so multi-file books play continuously. ShelfPlayer requires
// startOffset, duration, contentUrl, mimeType, and metadata.ext as non-null;
// codec is optional but populated when known.
function buildTracks(b: ItemBundle) {
  let cumulative = 0;
  return b.audioFiles.map((a) => {
    const filename = filenameFromUrl(a.filedn_url || a.rel_path || '');
    const ext = extOfFilename(filename) || '.m4b';
    const track = {
      index: a.index_no,
      ino: a.ino,
      startOffset: cumulative,
      duration: a.duration_seconds,
      // contentUrl is the path the ABS client GETs to stream this track. We
      // 302-redirect it through the storage adapter at request time.
      contentUrl: `/api/items/${b.item.id}/file/${a.ino ?? a.index_no}`,
      mimeType: a.mime_type ?? 'audio/mp4',
      codec: a.codec,
      metadata: {
        filename,
        ext,
        path: filename,
        relPath: filename,
        size: a.size_bytes,
        mtimeMs: a.added_at,
        ctimeMs: a.added_at,
        birthtimeMs: 0,
      },
    };
    cumulative += a.duration_seconds;
    return track;
  });
}

function buildLibraryFile(a: AudioFileRow, folder: LibraryFolderRow, item: LibraryItemRow) {
  const filename = filenameFromUrl(a.filedn_url);
  const ext = extOfFilename(filename);
  const fullPath = joinUrlOrPath(synthPath(folder, item), filename);
  return {
    ino: a.ino,
    metadata: {
      filename, ext, path: fullPath, relPath: filename,
      size: a.size_bytes, mtimeMs: a.added_at, ctimeMs: a.added_at, birthtimeMs: 0,
    },
    isSupplementary: null,
    addedAt: a.added_at,
    updatedAt: a.added_at,
    fileType: 'audio',
  };
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() ?? '';
    return decodeURIComponent(last);
  } catch {
    return url;
  }
}

function extOfFilename(name: string): string {
  const m = name.match(/(\.[^.]+)$/);
  return m ? m[1]! : '';
}

// ─── Library item (minified — list shape) ────────────────────────────────────

export async function buildItemMinified(b: ItemBundle) {
  const totalSize = b.audioFiles.reduce((s, a) => s + a.size_bytes, 0);
  const totalDuration = b.audioFiles.reduce((s, a) => s + a.duration_seconds, 0);
  const mediaId = await derivedId(b.item.id, 'media');
  const path = synthPath(b.folder, b.item);
  const m = b.metadata;
  return {
    id: b.item.id,
    ino: b.item.ino,
    oldLibraryItemId: null,
    libraryId: b.item.library_id,
    folderId: b.item.folder_id,
    path,
    relPath: b.item.rel_path,
    isFile: b.item.is_file === 1,
    mtimeMs: b.item.updated_at,
    ctimeMs: b.item.updated_at,
    birthtimeMs: 0,
    addedAt: b.item.created_at,
    updatedAt: b.item.updated_at,
    isMissing: b.item.is_missing === 1,
    isInvalid: b.item.is_invalid === 1,
    mediaType: b.item.media_type,
    media: {
      id: mediaId,
      metadata: {
        title: m?.title ?? null,
        titleIgnorePrefix: m?.title_ignore_prefix ?? m?.title ?? null,
        subtitle: m?.subtitle ?? null,
        authorName: m?.author_name ?? '',
        authorNameLF: nameLF(m?.author_name ?? null),
        narratorName: m?.narrator_name ?? '',
        seriesName: m?.series_name ?? '',
        genres: m ? JSON.parse(m.genres || '[]') : [],
        // String, not number — ShelfPlayer rejects numeric publishedYear
        // and discards the entire shelf. See buildBookMetadataDetail above.
        publishedYear: m?.publish_year != null ? String(m.publish_year) : null,
        publishedDate: null,
        publisher: m?.publisher ?? null,
        description: m?.description ?? null,
        isbn: m?.isbn ?? null,
        asin: m?.asin ?? null,
        language: m?.language ?? null,
        explicit: m ? m.explicit === 1 : false,
        abridged: m ? m.abridged === 1 : false,
      },
      coverPath: m?.cover_url ?? defaultCoverPath(b.item.id),
      tags: m ? JSON.parse(m.tags || '[]') : [],
      numTracks: b.audioFiles.length,
      numAudioFiles: b.audioFiles.length,
      numChapters: b.chapters.length,
      duration: totalDuration,
      size: totalSize,
    },
    numFiles: b.audioFiles.length,
    size: totalSize,
  };
}

// ABS clients build cover requests from `coverPath`. We point them at
// `/metadata/items/<id>/cover.jpg` so /api/items/:id/cover (the real handler)
// can be reached either way.
function defaultCoverPath(itemId: string): string {
  return `/metadata/items/${itemId}/cover.jpg`;
}

function nameLF(name: string | null): string {
  if (!name) return '';
  // "First Middle Last" → "Last, First Middle". For multi-author strings we
  // only flip the first; ABS does the same.
  const first = name.split(',')[0]!.trim();
  const parts = first.split(/\s+/);
  if (parts.length < 2) return first;
  const last = parts.pop()!;
  return `${last}, ${parts.join(' ')}`;
}

// ─── Filter data (?include=filterdata) ───────────────────────────────────────

export async function buildFilterData(args: {
  libraryRow: LibraryRow;
  folders: LibraryFolderRow[];
  metadata: BookMetadataRow[];
}) {
  const authorsMap = new Map<string, string>(); // name → id
  const seriesMap = new Map<string, string>();
  const narrators = new Set<string>();
  const languages = new Set<string>();
  const publishers = new Set<string>();
  const genres = new Set<string>();
  const decades = new Set<string>();

  for (const m of args.metadata) {
    for (const a of splitNames(m.author_name)) {
      if (!authorsMap.has(a)) {
        authorsMap.set(a, await derivedId(args.libraryRow.id, 'author', a));
      }
    }
    if (m.series_name && !seriesMap.has(m.series_name)) {
      seriesMap.set(m.series_name, await derivedId(args.libraryRow.id, 'series', m.series_name));
    }
    for (const n of splitNames(m.narrator_name)) narrators.add(n);
    if (m.language) languages.add(m.language);
    if (m.publisher) publishers.add(m.publisher);
    for (const g of JSON.parse(m.genres || '[]') as string[]) genres.add(g);
    if (m.publish_year) {
      decades.add(`${Math.floor(m.publish_year / 10) * 10}`);
    }
  }

  return {
    library: buildLibrary(args.libraryRow, args.folders),
    filterdata: {
      authors: Array.from(authorsMap, ([name, id]) => ({ id, name })),
      genres: Array.from(genres),
      tags: [] as string[],
      series: Array.from(seriesMap, ([name, id]) => ({ id, name })),
      narrators: Array.from(narrators),
      languages: Array.from(languages),
      publishers: Array.from(publishers),
      publishedDecades: Array.from(decades),
      bookCount: args.metadata.length,
      authorCount: authorsMap.size,
      seriesCount: seriesMap.size,
      podcastCount: 0,
      numIssues: 0,
      loadedAt: Date.now(),
    },
    issues: 0,
    numUserPlaylists: 0,
  };
}

// ─── Personalized shelves (home page) ────────────────────────────────────────

export async function buildPersonalizedShelves(args: {
  libraryId: string;
  bundles: ItemBundle[];
}) {
  const minified = await Promise.all(args.bundles.map((b) => buildItemMinified(b)));

  // Recently added: items sorted by addedAt desc.
  const recentlyAdded = [...minified].sort((a, b) => b.addedAt - a.addedAt);

  // Recent series: group by series_name, return one shelf entry per series with the books in it.
  const seriesGroups = new Map<string, { name: string; books: typeof minified }>();
  for (let i = 0; i < args.bundles.length; i++) {
    const m = args.bundles[i]!.metadata;
    const item = minified[i]!;
    if (!m?.series_name) continue;
    const key = m.series_name;
    const entry = seriesGroups.get(key) ?? { name: key, books: [] };
    entry.books.push(item);
    seriesGroups.set(key, entry);
  }
  const recentSeries = await Promise.all(Array.from(seriesGroups.entries()).map(async ([name, group]) => ({
    id: await derivedId(args.libraryId, 'series', name),
    name,
    nameIgnorePrefix: name,
    description: null,
    addedAt: Math.max(...group.books.map((b) => b.addedAt)),
    updatedAt: Math.max(...group.books.map((b) => b.updatedAt)),
    libraryId: args.libraryId,
    books: group.books,
  })));

  // Discover: simple — return all books in current order. (Real ABS picks
  // a random subset of unstarted books.)
  const discover = minified;

  // Newest authors: aggregate authors with book counts.
  const authorMap = new Map<string, number>();
  for (const b of args.bundles) {
    for (const a of splitNames(b.metadata?.author_name ?? null)) {
      authorMap.set(a, (authorMap.get(a) ?? 0) + 1);
    }
  }
  const newestAuthors = await Promise.all(Array.from(authorMap.entries()).map(async ([name, numBooks]) => ({
    id: await derivedId(args.libraryId, 'author', name),
    asin: null,
    name,
    description: null,
    imagePath: null,
    libraryId: args.libraryId,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    numBooks,
  })));

  return [
    { id: 'recently-added', label: 'Recently Added',  labelStringKey: 'LabelRecentlyAdded',  type: 'book',    entities: recentlyAdded, total: recentlyAdded.length },
    { id: 'recent-series',  label: 'Recent Series',   labelStringKey: 'LabelRecentSeries',   type: 'series',  entities: recentSeries,  total: recentSeries.length },
    { id: 'discover',       label: 'Discover',        labelStringKey: 'LabelDiscover',       type: 'book',    entities: discover,      total: discover.length },
    { id: 'newest-authors', label: 'Newest Authors',  labelStringKey: 'LabelNewestAuthors',  type: 'authors', entities: newestAuthors, total: newestAuthors.length },
  ];
}
