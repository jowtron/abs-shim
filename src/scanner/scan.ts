import type { Env } from '../types';
import { getAdapter, type FolderRow } from '../storage/factory';
import { ListingNotSupportedError, type RemoteEntry } from '../storage/adapter';
import { probeM4b } from '../prober/m4b';
import { probeOgg } from '../prober/ogg';
import { probeMp3, type Mp3Probe } from '../prober/mp3';
import { deriveSeries } from '../lib/series';
import { invalidateIdMap } from '../lib/ids';

// Scanner: walk a library's folder via its storage adapter, probe each new
// audiobook file, and upsert library_items + book_metadata + audio_files +
// chapters into D1.
//
// MVP scope:
//   - Single audio file per book (single-file m4b). Multi-track folder books
//     are detected (by directory structure with multiple audio files) but
//     skipped with an "unsupported_layout" error, to keep this honest.
//   - "New books only" — re-running a scan over an existing book is a no-op.
//     Editing metadata happens through a future admin endpoint, not by
//     re-probing on every scan.
//   - Synchronous: runs inside the request that triggers it. Personal-library
//     sizes (≤ ~200 books) finish in the Worker's CPU budget because the slow
//     part (range fetches) is wall-clock, not CPU.
//
// Future:
//   - Queue / Durable Object for long scans.
//   - Detect deletions: items present in D1 but missing remotely → mark
//     is_missing = 1 instead of dropping rows (don't lose user progress).

export type ScanReport = {
  libraryId: string;
  added: number;
  skipped: number;
  errors: Array<{ relPath: string; reason: string }>;
  durationMs: number;
};

export async function runScan(env: Env, libraryId: string, tenantId: string): Promise<ScanReport> {
  const started = Date.now();
  const folders = await env.DB.prepare(
    `SELECT * FROM library_folders WHERE library_id = ? AND tenant_id = ? ORDER BY added_at ASC`,
  ).bind(libraryId, tenantId).all<FolderRow>();

  const report: ScanReport = {
    libraryId,
    added: 0,
    skipped: 0,
    errors: [],
    durationMs: 0,
  };

  for (const folder of folders.results) {
    let adapter;
    try {
      adapter = await getAdapter(env, folder);
    } catch (e) {
      report.errors.push({ relPath: '', reason: `adapter: ${(e as Error).message}` });
      continue;
    }

    let entries: RemoteEntry[];
    try {
      entries = await collectAudioFiles(adapter, '');
    } catch (e) {
      if (e instanceof ListingNotSupportedError) {
        report.errors.push({
          relPath: '',
          reason: `listing not supported for provider ${folder.provider} — manifest scan not yet implemented`,
        });
        continue;
      }
      report.errors.push({ relPath: '', reason: `walk: ${(e as Error).message}` });
      continue;
    }

    // Existing items: keep us idempotent. We key by (folder_id, rel_path of
    // the item directory or single file).
    const existing = await env.DB.prepare(
      `SELECT rel_path FROM library_items WHERE folder_id = ?`,
    ).bind(folder.id).all<{ rel_path: string }>();
    const known = new Set(existing.results.map((r) => r.rel_path));

    // Group entries by parent directory. A single-file book at the folder
    // root maps to a group keyed by the file path. A folder of mp3 chapter
    // files maps every chapter to one group.
    const groups = new Map<string, RemoteEntry[]>();
    for (const file of entries) {
      const slash = file.relPath.lastIndexOf('/');
      const itemRel = slash > 0 ? file.relPath.slice(0, slash) : file.relPath;
      const arr = groups.get(itemRel);
      if (arr) arr.push(file);
      else groups.set(itemRel, [file]);
    }

    for (const [itemRel, files] of groups) {
      if (known.has(itemRel)) {
        report.skipped += files.length;
        continue;
      }
      // Lex sort — "01 - chapter.mp3" naming is the de facto standard for
      // multi-file audiobooks, and locale sort handles zero-padded numerics.
      files.sort((a, b) => a.relPath.localeCompare(b.relPath));

      try {
        const allMp3 = files.every((f) => /\.mp3$/i.test(f.relPath));
        if (allMp3) {
          await probeMp3Book({ env, adapter, folder, itemRel, files });
          report.added++;
          known.add(itemRel);
        } else if (files.length === 1) {
          const f = files[0]!;
          const out = await probeBook({ env, adapter, folder, file: f, itemRel });
          if (out === 'added') { report.added++; known.add(itemRel); }
          else report.skipped++;
        } else {
          // Multi-file non-mp3 layouts (e.g. m4b split into chapter files)
          // aren't yet supported by the prober. Flag and continue.
          report.errors.push({
            relPath: itemRel,
            reason: `multi-file non-mp3 folder layout not supported (${files.length} files)`,
          });
        }
      } catch (e) {
        if (isUniqueViolation(e)) { report.skipped += files.length; known.add(itemRel); continue; }
        report.errors.push({ relPath: itemRel, reason: (e as Error).message });
      }
    }
  }

  report.durationMs = Date.now() - started;
  return report;
}

async function collectAudioFiles(adapter: Awaited<ReturnType<typeof getAdapter>>, root: string): Promise<RemoteEntry[]> {
  const out: RemoteEntry[] = [];
  if (adapter.walkAudiobookFiles) {
    for await (const entry of adapter.walkAudiobookFiles(root)) {
      out.push(entry);
    }
    return out;
  }
  // Fallback: BFS via listFolder. PublicUrlAdapter throws here, which the
  // caller catches as ListingNotSupportedError.
  const queue: string[] = [root];
  while (queue.length) {
    const cur = queue.shift()!;
    const entries = await adapter.listFolder(cur);
    for (const e of entries) {
      if (e.isDir) queue.push(e.relPath);
      else if (/\.(m4b|m4a|aac|mp3|opus|ogg)$/i.test(e.relPath)) out.push(e);
    }
  }
  return out;
}

type SingleFileArgs = {
  env: Env;
  adapter: Awaited<ReturnType<typeof getAdapter>>;
  folder: FolderRow;
  file: RemoteEntry;
  itemRel: string;
};

// Single-file dispatcher. addBookByPath uses this; runScan dispatches by
// extension itself so it can handle multi-file mp3 folders without round-
// tripping through here.
async function probeBook(args: SingleFileArgs): Promise<'added' | 'skipped'> {
  if (/\.mp3$/i.test(args.file.relPath)) {
    return probeMp3Book({
      env: args.env, adapter: args.adapter, folder: args.folder,
      itemRel: args.itemRel, files: [args.file],
    });
  }
  if (isOgg(args.file.relPath)) return probeOggBook(args);
  return probeM4bBook(args);
}

export const isOgg = (path: string): boolean => /\.(opus|ogg)$/i.test(path);

// Single-file Opus/Vorbis book (the 2026-09-02 Percy Jackson grab was five
// of these and none showed up: the scanner only knew m4b/m4a/aac/mp3).
// Same rows as probeM4bBook minus the moov cache — Ogg has no moov, and
// iOS streams it fine with plain Range requests.
async function probeOggBook(args: SingleFileArgs): Promise<'added' | 'skipped'> {
  const { env, adapter, folder, file, itemRel } = args;
  const probeUrl = await adapter.resolveProbeUrl(file.relPath, file.providerId ?? null);
  const probe = await probeOgg(probeUrl.url);

  const filename = file.relPath.split('/').pop() ?? file.relPath;
  const title = probe.tags['TITLE'] ?? probe.tags['ALBUM'] ?? filename.replace(/\.(opus|ogg)$/i, '');
  const author = probe.tags['ARTIST'] ?? probe.tags['ALBUMARTIST'] ?? probe.tags['AUTHOR'] ?? null;
  const album = probe.tags['ALBUM'] ?? null;
  // ffmpeg maps an m4b's ©wrt (narrator) to COMPOSER when it converts.
  const narrator = probe.tags['NARRATOR'] ?? probe.tags['PERFORMER'] ?? probe.tags['COMPOSER'] ?? null;
  const yearNum = probe.tags['DATE'] ? Number(probe.tags['DATE']!.slice(0, 4)) : NaN;
  const year = Number.isFinite(yearNum) ? yearNum : null;
  const series = deriveSeries({
    tags: probe.tags, title, author, album,
    folderName: itemRel === file.relPath ? null : (itemRel.split('/').pop() ?? itemRel),
  });

  const itemId = `it-${crypto.randomUUID().slice(0, 12)}`;
  const audioId = `af-${crypto.randomUUID().slice(0, 12)}`;
  const now = Date.now();
  const isFile = file.relPath === itemRel ? 1 : 0;
  const ino = (Math.floor(Math.random() * 0xffffffff)).toString();
  const audioIno = (Math.floor(Math.random() * 0xffffffff)).toString();
  const stableUrl = adapter.provider === 'public_url' ? (await adapter.resolveUrl(file.relPath)).url : '';
  const totalDuration = probe.durationSeconds ?? 0;
  const chapterInserts = probe.chapters.map((ch, i) => {
    const next = probe.chapters[i + 1];
    return env.DB.prepare(
      `INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES (?, ?, ?, ?, ?)`,
    ).bind(itemId, i, ch.title, ch.start, next ? next.start : totalDuration);
  });
  const mime = probe.codec === 'opus' ? 'audio/ogg; codecs=opus' : 'audio/ogg';

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO library_items
         (id, library_id, folder_id, tenant_id, ino, rel_path, is_file, media_type, is_missing, is_invalid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'book', 0, 0, ?, ?)`,
    ).bind(itemId, folder.library_id, folder.id, folder.tenant_id, ino, itemRel, isFile, now, now),
    env.DB.prepare(
      `INSERT INTO book_metadata
         (library_item_id, tenant_id, title, title_ignore_prefix, subtitle, author_name, narrator_name,
          series_name, series_sequence, description, isbn, asin, language, publish_year,
          publisher, genres, tags, explicit, abridged, cover_url)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', 0, 0, NULL)`,
    ).bind(itemId, folder.tenant_id, title, sortKey(title), author, narrator, series?.name ?? null, series?.sequence ?? null, year, album),
    env.DB.prepare(
      `INSERT INTO audio_files
         (id, library_item_id, tenant_id, index_no, filedn_url, ino, duration_seconds, size_bytes,
          mime_type, format, codec, bitrate, sample_rate, channels, added_at,
          rel_path, provider_file_id, moov_offset, moov_size)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'ogg', ?, NULL, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).bind(
      audioId, itemId, folder.tenant_id, stableUrl, audioIno, totalDuration,
      file.sizeBytes ?? probe.sizeBytes ?? 0, mime, probe.codec, probe.sampleRate, probe.channels, now,
      file.relPath, file.providerId ?? null,
    ),
    ...chapterInserts,
  ]);

  if (probe.cover) {
    try {
      await env.COVERS.put(`covers/${itemId}`, probe.cover.bytes, { httpMetadata: { contentType: probe.cover.mimeType } });
    } catch { /* non-fatal: the cover route re-probes on first request */ }
  }
  invalidateIdMap();
  return 'added';
}

// Probe one m4b/m4a/aac file and insert all the metadata rows. Returns
// 'skipped' when we deliberately decline — currently never, but reserve the
// name so callers can branch.
async function probeM4bBook(args: SingleFileArgs): Promise<'added' | 'skipped'> {
  const { env, adapter, folder, file, itemRel } = args;

  // Get a probe URL — for OAuth providers this is short-lived, but the prober
  // makes its requests immediately so it's fine.
  const probeUrl = await adapter.resolveProbeUrl(file.relPath, file.providerId ?? null);
  const probe = await probeM4b(probeUrl.url);

  // Title: prefer the iTunes ©nam tag, fall back to filename without extension.
  const filename = file.relPath.split('/').pop() ?? file.relPath;
  const titleFromName = filename.replace(/\.(m4b|m4a|aac)$/i, '');
  const title = probe.tags['©nam'] ?? titleFromName;
  const author = probe.tags['©ART'] ?? null;
  const album = probe.tags['©alb'] ?? null;
  const narrator = probe.tags['©wrt'] ?? null;
  // Guard non-numeric ©day (e.g. "Unknown"): NaN fails D1 bind and aborts
  // the whole insert batch for the book.
  const yearNum = probe.tags['©day'] ? Number(probe.tags['©day']!.slice(0, 4)) : NaN;
  const year = Number.isFinite(yearNum) ? yearNum : null;
  const series = deriveSeries({
    tags: probe.tags, title, author, album,
    folderName: itemRel === file.relPath ? null : (itemRel.split('/').pop() ?? itemRel),
  });

  const itemId = `it-${crypto.randomUUID().slice(0, 12)}`;
  const audioId = `af-${crypto.randomUUID().slice(0, 12)}`;
  const now = Date.now();
  const isFile = file.relPath === itemRel ? 1 : 0;
  const ino = (Math.floor(Math.random() * 0xffffffff)).toString();
  const audioIno = (Math.floor(Math.random() * 0xffffffff)).toString();

  // We could store filedn_url for back-compat but for OAuth providers the URL
  // is short-lived — leave it empty and let the runtime adapter resolve at
  // request time. PublicUrl-adapter writes the same url for both.
  const stableUrl = adapter.provider === 'public_url'
    ? (await adapter.resolveUrl(file.relPath)).url
    : '';

  // Build chapter inserts. chpl chapters have start times only; derive each
  // chapter's end from the next chapter's start (or the total duration for
  // the last one). Empty array when the m4b has no chpl atom.
  const totalDuration = probe.durationSeconds ?? 0;
  const chapterInserts = probe.chapters.map((ch, i) => {
    const next = probe.chapters[i + 1];
    const end = next ? next.start : totalDuration;
    return env.DB.prepare(
      `INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(itemId, i, ch.title, ch.start, end);
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO library_items
         (id, library_id, folder_id, tenant_id, ino, rel_path, is_file, media_type, is_missing, is_invalid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'book', 0, 0, ?, ?)`,
    ).bind(itemId, folder.library_id, folder.id, folder.tenant_id, ino, itemRel, isFile, now, now),

    env.DB.prepare(
      `INSERT INTO book_metadata
         (library_item_id, tenant_id, title, title_ignore_prefix, subtitle, author_name, narrator_name,
          series_name, series_sequence, description, isbn, asin, language, publish_year,
          publisher, genres, tags, explicit, abridged, cover_url)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', 0, 0, NULL)`,
    ).bind(itemId, folder.tenant_id, title, sortKey(title), author, narrator, series?.name ?? null, series?.sequence ?? null, year, album),

    env.DB.prepare(
      `INSERT INTO audio_files
         (id, library_item_id, tenant_id, index_no, filedn_url, ino, duration_seconds, size_bytes,
          mime_type, format, codec, bitrate, sample_rate, channels, added_at,
          rel_path, provider_file_id, moov_offset, moov_size)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'audio/mp4', 'mp4', 'aac', NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
    ).bind(
      audioId, itemId, folder.tenant_id, stableUrl, audioIno,
      totalDuration,
      file.sizeBytes ?? 0,
      now,
      file.relPath,
      file.providerId ?? null,
      probe.moovOffset,
      probe.moovSize,
    ),

    ...chapterInserts,
  ]);

  // Pre-warm the R2 cover cache. We already probed the m4b, so the cover
  // bytes are in memory — writing them now means the first /cover request
  // is a cheap R2 hit instead of a 50–500ms re-probe of upstream storage.
  if (probe.cover) {
    try {
      await env.COVERS.put(`covers/${itemId}`, probe.cover.bytes, {
        httpMetadata: { contentType: probe.cover.mimeType },
      });
    } catch {
      // Non-fatal: the on-demand handler will probe again on first request.
    }
  }

  // Pre-warm the R2 moov cache. One extra Range fetch (~1-2s, scan-time, no
  // user waiting) trades for a guaranteed R2 hit on the first /play of this
  // book — which is what lets iOS Safari survive its seek-to-moov on
  // non-fast-start files without the cancel-retry stall loop.
  try {
    const last = probe.moovOffset + probe.moovSize - 1;
    const moovRes = await fetch(probeUrl.url, {
      headers: { Range: `bytes=${probe.moovOffset}-${last}` },
    });
    if (moovRes.status === 206 || moovRes.status === 200) {
      const moovBytes = new Uint8Array(await moovRes.arrayBuffer());
      if (moovBytes.byteLength === probe.moovSize) {
        await env.COVERS.put(`moov/${folder.tenant_id}/${audioId}`, moovBytes, {
          httpMetadata: { contentType: 'application/octet-stream' },
        });
      }
    }
  } catch {
    // Non-fatal: warmMoovCache will lazy-populate on first /play.
  }

  invalidateIdMap();
  return 'added';
}

// Probe a multi-file mp3 audiobook (1..N chapter files in a directory). Each
// file becomes one audio_files row + one chapters row, with cumulative start
// offsets across the file list. Book-level metadata (title/author/cover) is
// pulled from the FIRST file's ID3v2 tag, with the folder name as the title
// fallback when TALB is missing.
async function probeMp3Book(args: {
  env: Env;
  adapter: Awaited<ReturnType<typeof getAdapter>>;
  folder: FolderRow;
  itemRel: string;
  files: RemoteEntry[];
}): Promise<'added' | 'skipped'> {
  const { env, adapter, folder, itemRel, files } = args;
  if (!files.length) return 'skipped';

  // Probe every file. We need duration per file (for cumulative offsets) and
  // TIT2 per file (for chapter titles). Sequential to keep upstream-request
  // load reasonable on free-tier hosts.
  const probes: Mp3Probe[] = [];
  for (const f of files) {
    const probeUrl = await adapter.resolveProbeUrl(f.relPath, f.providerId ?? null);
    probes.push(await probeMp3(probeUrl.url, f.sizeBytes));
  }
  const first = probes[0]!;

  // Title: prefer first file's TALB (album = book title in audiobook tagging),
  // then directory basename, then first file's TIT2 as a last resort.
  const folderBase = itemRel.split('/').pop() ?? itemRel;
  const title = first.tags['TALB'] ?? folderBase ?? first.tags['TIT2'] ?? 'Unknown';
  const author = first.tags['TPE1'] ?? null;
  // ABS treats the album field separately from the title; for an mp3 book the
  // album IS the title, so leave book_metadata.series_name etc alone and write
  // album = TALB only when it differs from the resolved title.
  const album = first.tags['TALB'] && first.tags['TALB'] !== title
    ? first.tags['TALB']
    : null;
  // Narrator: TCOM ("composer") is the common audiobook convention, with
  // TXXX:NARRATOR a stricter alternative when present.
  const narrator = first.tags['TXXX:NARRATOR'] ?? first.tags['TCOM'] ?? null;
  const yearRaw = first.tags['TDRC'] ?? first.tags['TYER'] ?? null;
  const year = yearRaw ? Number(yearRaw.slice(0, 4)) || null : null;
  const mp3Series = deriveSeries({
    tags: {
      ...(first.tags['TIT1'] ? { '©grp': first.tags['TIT1']! } : {}),
      ...(first.tags['TXXX:SERIES'] ? { '----:com.apple.iTunes:SERIES': first.tags['TXXX:SERIES']! } : {}),
      ...(first.tags['TXXX:SERIES-PART'] ? { '----:com.apple.iTunes:SERIES-PART': first.tags['TXXX:SERIES-PART']! } : {}),
    },
    title, author, album: first.tags['TALB'] ?? null, folderName: folderBase,
  });

  const itemId = `it-${crypto.randomUUID().slice(0, 12)}`;
  const now = Date.now();
  // is_file = 1 only when the "book" is literally a single file at the folder
  // root (rare for mp3, but possible). Otherwise it's a directory.
  const isFile = files.length === 1 && files[0]!.relPath === itemRel ? 1 : 0;
  const ino = (Math.floor(Math.random() * 0xffffffff)).toString();

  // Cumulative offset table for chapter start/end times.
  let cum = 0;
  const offsets: number[] = [];
  for (const p of probes) {
    offsets.push(cum);
    cum += p.durationSeconds ?? 0;
  }
  const totalDuration = cum;

  // PublicUrl provider URLs are stable, so resolve them once and cache;
  // OAuth providers mint short-lived URLs per request, so leave filedn_url
  // empty and let resolveStreamUrl rebuild at request time.
  const stableUrls = adapter.provider === 'public_url'
    ? await Promise.all(files.map((f) => adapter.resolveUrl(f.relPath).then((r) => r.url)))
    : files.map(() => '');

  const audioStmts = files.map((f, i) => {
    const p = probes[i]!;
    const audioId = `af-${crypto.randomUUID().slice(0, 12)}`;
    const audioIno = (Math.floor(Math.random() * 0xffffffff)).toString();
    return env.DB.prepare(
      `INSERT INTO audio_files
         (id, library_item_id, tenant_id, index_no, filedn_url, ino, duration_seconds, size_bytes,
          mime_type, format, codec, bitrate, sample_rate, channels, added_at,
          rel_path, provider_file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'audio/mpeg', 'mp3', 'mp3', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      audioId, itemId, folder.tenant_id, i + 1, stableUrls[i] ?? '', audioIno,
      p.durationSeconds ?? 0,
      f.sizeBytes ?? 0,
      p.bitrate ?? null, p.sampleRate ?? null, p.channels ?? null,
      now, f.relPath, f.providerId ?? null,
    );
  });

  const chapterStmts = mp3ChapterStmts(env, itemId, files.map((f) => f.relPath), probes);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO library_items
         (id, library_id, folder_id, tenant_id, ino, rel_path, is_file, media_type, is_missing, is_invalid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'book', 0, 0, ?, ?)`,
    ).bind(itemId, folder.library_id, folder.id, folder.tenant_id, ino, itemRel, isFile, now, now),

    env.DB.prepare(
      `INSERT INTO book_metadata
         (library_item_id, tenant_id, title, title_ignore_prefix, subtitle, author_name, narrator_name,
          series_name, series_sequence, description, isbn, asin, language, publish_year,
          publisher, genres, tags, explicit, abridged, cover_url)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', 0, 0, NULL)`,
    ).bind(itemId, folder.tenant_id, title, sortKey(title), author, narrator, mp3Series?.name ?? null, mp3Series?.sequence ?? null, year, album),

    ...audioStmts,
    ...chapterStmts,
  ]);

  // Pre-warm the R2 cover cache from the first file's APIC frame, same as
  // m4b. The on-demand cover handler will re-probe if this is missing.
  if (first.cover) {
    try {
      await env.COVERS.put(`covers/${itemId}`, first.cover.bytes, {
        httpMetadata: { contentType: first.cover.mimeType },
      });
    } catch {
      // Non-fatal.
    }
  }

  invalidateIdMap();
  return 'added';
}

// Re-probe an existing book: run probeM4b against its audio file, replace
// the chapters table for it, and refresh the R2 cover from the new probe.
// Other metadata (title/author/etc) is deliberately NOT overwritten — those
// rows can be edited (or will be once a metadata-edit UI exists) and we
// don't want a re-probe to clobber human edits.
export async function reprobeItem(env: Env, itemId: string, tenantId: string): Promise<{
  itemId: string;
  chapters: number;
  durationSeconds: number | null;
  coverRefreshed: boolean;
  series?: string;
}> {
  const item = await env.DB.prepare(
    'SELECT * FROM library_items WHERE id = ? AND tenant_id = ?',
  ).bind(itemId, tenantId).first<{ id: string; folder_id: string; rel_path: string }>();
  if (!item) throw new Error('Item not found');
  const folder = await env.DB.prepare(
    'SELECT * FROM library_folders WHERE id = ? AND tenant_id = ?',
  ).bind(item.folder_id, tenantId).first<FolderRow>();
  if (!folder) throw new Error('Folder not found');
  const audio = await env.DB.prepare(
    'SELECT * FROM audio_files WHERE library_item_id = ? ORDER BY index_no ASC LIMIT 1',
  ).bind(itemId).first<{ id: string; rel_path: string | null; provider_file_id: string | null; filedn_url: string; duration_seconds: number; format: string | null }>();
  if (!audio) throw new Error('No audio file for item');

  const adapter = await getAdapter(env, folder);
  if (audio.format === 'mp3' || /\.mp3$/i.test(audio.rel_path ?? '')) {
    return reprobeMp3Item(env, adapter, itemId, item.rel_path);
  }
  if (audio.format === 'ogg' || isOgg(audio.rel_path ?? '')) {
    return reprobeOggItem(env, adapter, itemId, item.rel_path, audio);
  }
  const probeUrl = audio.rel_path
    ? await adapter.resolveProbeUrl(audio.rel_path, audio.provider_file_id)
    : { url: audio.filedn_url };
  const probe = await probeM4b(probeUrl.url);

  const totalDuration = probe.durationSeconds ?? audio.duration_seconds ?? 0;
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM chapters WHERE library_item_id = ?').bind(itemId),
  ];
  // Series: items added before series derivation existed (pre 2026-08-23)
  // have NULLs here. Only fill, never clobber — a value already present may
  // be a deliberate edit.
  const meta = await env.DB.prepare(
    'SELECT title, author_name, publisher, series_name FROM book_metadata WHERE library_item_id = ?',
  ).bind(itemId).first<{ title: string; author_name: string | null; publisher: string | null; series_name: string | null }>();
  let seriesSet: string | null = null;
  if (meta && !meta.series_name) {
    const series = deriveSeries({
      tags: probe.tags, title: meta.title, author: meta.author_name, album: meta.publisher,
      folderName: item.rel_path === audio.rel_path ? null : (item.rel_path.split('/').pop() ?? item.rel_path),
    });
    if (series) {
      seriesSet = series.sequence ? `${series.name} #${series.sequence}` : series.name;
      stmts.push(env.DB.prepare(
        'UPDATE book_metadata SET series_name = ?, series_sequence = ? WHERE library_item_id = ?',
      ).bind(series.name, series.sequence, itemId));
    }
  }
  for (let i = 0; i < probe.chapters.length; i++) {
    const ch = probe.chapters[i]!;
    const next = probe.chapters[i + 1];
    const end = next ? next.start : totalDuration;
    stmts.push(env.DB.prepare(
      `INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(itemId, i, ch.title, ch.start, end));
  }
  // Update duration if probe found one different.
  if (probe.durationSeconds && Math.abs(probe.durationSeconds - audio.duration_seconds) > 0.5) {
    stmts.push(env.DB.prepare(
      'UPDATE audio_files SET duration_seconds = ? WHERE id = ?',
    ).bind(probe.durationSeconds, audio.id));
  }
  // Always refresh moov_offset/moov_size — they may have been NULL pre-0003,
  // and the file may have been re-muxed since the original scan.
  stmts.push(env.DB.prepare(
    'UPDATE audio_files SET moov_offset = ?, moov_size = ? WHERE id = ?',
  ).bind(probe.moovOffset, probe.moovSize, audio.id));
  await env.DB.batch(stmts);

  let coverRefreshed = false;
  if (probe.cover) {
    try {
      await env.COVERS.put(`covers/${itemId}`, probe.cover.bytes, {
        httpMetadata: { contentType: probe.cover.mimeType },
      });
      coverRefreshed = true;
    } catch { /* non-fatal */ }
  }

  // Refresh the R2 moov cache — same rationale as in probeM4bBook, plus the
  // file may have been re-muxed (different moov offset/size).
  try {
    const last = probe.moovOffset + probe.moovSize - 1;
    const moovRes = await fetch(probeUrl.url, {
      headers: { Range: `bytes=${probe.moovOffset}-${last}` },
    });
    if (moovRes.status === 206 || moovRes.status === 200) {
      const moovBytes = new Uint8Array(await moovRes.arrayBuffer());
      if (moovBytes.byteLength === probe.moovSize) {
        await env.COVERS.put(`moov/${tenantId}/${audio.id}`, moovBytes, {
          httpMetadata: { contentType: 'application/octet-stream' },
        });
      }
    }
  } catch { /* non-fatal */ }

  return {
    itemId,
    chapters: probe.chapters.length,
    durationSeconds: probe.durationSeconds,
    coverRefreshed,
    ...(seriesSet ? { series: seriesSet } : {}),
  };
}

// Chapter rows for an mp3 book. A file with ID3v2 CHAP frames contributes
// those (shifted by the file's cumulative start); a file without them is one
// chapter titled from its TIT2 / sanitized filename. Shared by the scanner and
// reprobe so both agree.
export function mp3Chapters(
  relPaths: string[], probes: Mp3Probe[],
): Array<{ title: string; start: number; end: number }> {
  const out: Array<{ title: string; start: number; end: number }> = [];
  let cum = 0;
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i]!;
    const fileDur = p.durationSeconds ?? 0;
    const fileStart = cum;
    const fileEnd = cum + fileDur;
    if (p.chapters.length) {
      for (const ch of p.chapters) {
        const end = fileDur ? Math.min(ch.end, fileDur) : ch.end;
        if (ch.start >= end) continue;
        out.push({ title: ch.title, start: fileStart + ch.start, end: fileStart + end });
      }
    } else {
      const filename = relPaths[i]!.split('/').pop() ?? relPaths[i]!;
      const titleFromName = filename.replace(/\.mp3$/i, '').replace(/^\d+\s*[-_.]?\s*/, '');
      out.push({ title: p.tags['TIT2'] ?? titleFromName, start: fileStart, end: fileEnd });
    }
    cum = fileEnd;
  }
  return out;
}

function mp3ChapterStmts(env: Env, itemId: string, relPaths: string[], probes: Mp3Probe[]): D1PreparedStatement[] {
  return mp3Chapters(relPaths, probes).map((ch, i) => env.DB.prepare(
    `INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(itemId, i, ch.title, ch.start, ch.end));
}

function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test((e as Error)?.message ?? '');
}

// Opus/Vorbis re-probe: chapters rebuilt from CHAPTERnnn comments, duration
// refreshed, series filled if NULL, cover refreshed from METADATA_BLOCK_PICTURE.
async function reprobeOggItem(
  env: Env, adapter: Awaited<ReturnType<typeof getAdapter>>, itemId: string, itemRel: string,
  audio: { id: string; rel_path: string | null; provider_file_id: string | null; filedn_url: string; duration_seconds: number },
): Promise<{ itemId: string; chapters: number; durationSeconds: number | null; coverRefreshed: boolean; series?: string }> {
  const probeUrl = audio.rel_path
    ? await adapter.resolveProbeUrl(audio.rel_path, audio.provider_file_id)
    : { url: audio.filedn_url };
  const probe = await probeOgg(probeUrl.url);
  const totalDuration = probe.durationSeconds ?? audio.duration_seconds ?? 0;
  const stmts: D1PreparedStatement[] = [env.DB.prepare('DELETE FROM chapters WHERE library_item_id = ?').bind(itemId)];
  const meta = await env.DB.prepare(
    'SELECT title, author_name, publisher, series_name FROM book_metadata WHERE library_item_id = ?',
  ).bind(itemId).first<{ title: string; author_name: string | null; publisher: string | null; series_name: string | null }>();
  let seriesSet: string | null = null;
  if (meta && !meta.series_name) {
    const series = deriveSeries({
      tags: probe.tags, title: meta.title, author: meta.author_name, album: meta.publisher,
      folderName: itemRel === audio.rel_path ? null : (itemRel.split('/').pop() ?? itemRel),
    });
    if (series) {
      seriesSet = series.sequence ? `${series.name} #${series.sequence}` : series.name;
      stmts.push(env.DB.prepare('UPDATE book_metadata SET series_name = ?, series_sequence = ? WHERE library_item_id = ?')
        .bind(series.name, series.sequence, itemId));
    }
  }
  probe.chapters.forEach((ch, i) => {
    const next = probe.chapters[i + 1];
    stmts.push(env.DB.prepare(
      `INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES (?, ?, ?, ?, ?)`,
    ).bind(itemId, i, ch.title, ch.start, next ? next.start : totalDuration));
  });
  if (probe.durationSeconds && Math.abs(probe.durationSeconds - audio.duration_seconds) > 0.5) {
    stmts.push(env.DB.prepare('UPDATE audio_files SET duration_seconds = ? WHERE id = ?').bind(probe.durationSeconds, audio.id));
  }
  await env.DB.batch(stmts);
  let coverRefreshed = false;
  if (probe.cover) {
    try {
      await env.COVERS.put(`covers/${itemId}`, probe.cover.bytes, { httpMetadata: { contentType: probe.cover.mimeType } });
      coverRefreshed = true;
    } catch { /* non-fatal */ }
  }
  return { itemId, chapters: probe.chapters.length, durationSeconds: probe.durationSeconds, coverRefreshed, ...(seriesSet ? { series: seriesSet } : {}) };
}

// mp3 re-probe: every file again (CHAP frames, durations), chapters rebuilt
// with mp3Chapters, series filled if NULL, cover refreshed from APIC.
async function reprobeMp3Item(
  env: Env, adapter: Awaited<ReturnType<typeof getAdapter>>, itemId: string, itemRel: string,
): Promise<{ itemId: string; chapters: number; durationSeconds: number | null; coverRefreshed: boolean; series?: string }> {
  const files = await env.DB.prepare(
    'SELECT id, rel_path, provider_file_id, filedn_url, size_bytes FROM audio_files WHERE library_item_id = ? ORDER BY index_no ASC',
  ).bind(itemId).all<{ id: string; rel_path: string | null; provider_file_id: string | null; filedn_url: string; size_bytes: number }>();
  const probes: Mp3Probe[] = [];
  for (const f of files.results) {
    const probeUrl = f.rel_path
      ? await adapter.resolveProbeUrl(f.rel_path, f.provider_file_id)
      : { url: f.filedn_url };
    probes.push(await probeMp3(probeUrl.url, f.size_bytes || undefined));
  }
  const relPaths = files.results.map((f) => f.rel_path ?? f.filedn_url);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM chapters WHERE library_item_id = ?').bind(itemId),
    ...mp3ChapterStmts(env, itemId, relPaths, probes),
  ];
  let total = 0;
  files.results.forEach((f, i) => {
    const d = probes[i]!.durationSeconds;
    if (d) {
      total += d;
      stmts.push(env.DB.prepare('UPDATE audio_files SET duration_seconds = ? WHERE id = ?').bind(d, f.id));
    }
  });
  const meta = await env.DB.prepare(
    'SELECT title, author_name, publisher, series_name FROM book_metadata WHERE library_item_id = ?',
  ).bind(itemId).first<{ title: string; author_name: string | null; publisher: string | null; series_name: string | null }>();
  let seriesSet: string | null = null;
  const first = probes[0];
  if (meta && !meta.series_name && first) {
    const series = deriveSeries({
      tags: {
        ...(first.tags['TIT1'] ? { '©grp': first.tags['TIT1']! } : {}),
        ...(first.tags['TXXX:SERIES'] ? { '----:com.apple.iTunes:SERIES': first.tags['TXXX:SERIES']! } : {}),
        ...(first.tags['TXXX:SERIES-PART'] ? { '----:com.apple.iTunes:SERIES-PART': first.tags['TXXX:SERIES-PART']! } : {}),
      },
      title: meta.title, author: meta.author_name, album: meta.publisher,
      folderName: itemRel.split('/').pop() ?? itemRel,
    });
    if (series) {
      seriesSet = series.sequence ? `${series.name} #${series.sequence}` : series.name;
      stmts.push(env.DB.prepare(
        'UPDATE book_metadata SET series_name = ?, series_sequence = ? WHERE library_item_id = ?',
      ).bind(series.name, series.sequence, itemId));
    }
  }
  await env.DB.batch(stmts);
  let coverRefreshed = false;
  const cover = probes.find((p) => p.cover)?.cover;
  if (cover) {
    try {
      await env.COVERS.put(`covers/${itemId}`, cover.bytes, { httpMetadata: { contentType: cover.mimeType } });
      coverRefreshed = true;
    } catch { /* non-fatal */ }
  }
  const chapterCount = mp3Chapters(relPaths, probes).length;
  return { itemId, chapters: chapterCount, durationSeconds: total || null, coverRefreshed, ...(seriesSet ? { series: seriesSet } : {}) };
}

function sortKey(title: string): string {
  // ABS-style: strip leading "The "/"A "/"An " for sorting.
  return title.replace(/^(The|A|An)\s+/i, '');
}

// Add a single book by relative path. Used by the admin /books/add-by-path
// endpoint as a manual override when the scanner can't list a folder (filedn-
// public) or as a "add this one specific thing" shortcut.
export async function addBookByPath(
  env: Env,
  libraryId: string,
  relPath: string,
  tenantId: string,
  hints?: { sizeBytes?: number },
): Promise<{ added: boolean; itemId?: string; reason?: string }> {
  const folderRow = await env.DB.prepare(
    `SELECT * FROM library_folders WHERE library_id = ? AND tenant_id = ? ORDER BY added_at ASC LIMIT 1`,
  ).bind(libraryId, tenantId).first<FolderRow>();
  if (!folderRow) return { added: false, reason: 'No folder configured for library' };

  // Idempotency: skip if a row already covers this path (item dir or file).
  const slash = relPath.lastIndexOf('/');
  const itemRel = slash > 0 ? relPath.slice(0, slash) : relPath;
  const dup = await env.DB.prepare(
    `SELECT id FROM library_items WHERE folder_id = ? AND rel_path IN (?, ?)`,
  ).bind(folderRow.id, itemRel, relPath).first<{ id: string }>();
  if (dup) return { added: false, itemId: dup.id, reason: 'Already in library' };

  const adapter = await getAdapter(env, folderRow);
  // Caller can pass sizeBytes (e.g. from the pCloud upload_save response) so
  // the audio_files row gets a real size on first insert. Without this, the
  // scanner's listFolder path is the only thing that ever populates size and
  // single-file uploads via /save end up with size=0.
  const file: RemoteEntry = { relPath, isDir: false };
  if (hints?.sizeBytes != null) file.sizeBytes = hints.sizeBytes;
  try {
    await probeBook({ env, adapter, folder: folderRow, file, itemRel });
  } catch (e) {
    // Lost a race with a concurrent scan/registration of the same path
    // (idx_items_folder_relpath, migration 0006). Surface the winner.
    if (!isUniqueViolation(e)) throw e;
    const winner = await env.DB.prepare(
      `SELECT id FROM library_items WHERE folder_id = ? AND rel_path IN (?, ?)`,
    ).bind(folderRow.id, itemRel, relPath).first<{ id: string }>();
    return winner
      ? { added: false, itemId: winner.id, reason: 'Already in library' }
      : { added: false, reason: 'Already in library' };
  }
  // probeBook generates an id internally; re-query to surface it.
  const fresh = await env.DB.prepare(
    `SELECT id FROM library_items WHERE folder_id = ? AND rel_path = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(folderRow.id, itemRel).first<{ id: string }>();
  const out: { added: boolean; itemId?: string; reason?: string } = { added: true };
  if (fresh?.id) out.itemId = fresh.id;
  return out;
}
