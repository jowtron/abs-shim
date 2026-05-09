import type { Env } from '../types';
import { getAdapter, type FolderRow } from '../storage/factory';
import { ListingNotSupportedError, type RemoteEntry } from '../storage/adapter';
import { probeM4b } from '../prober/m4b';

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

export async function runScan(env: Env, libraryId: string): Promise<ScanReport> {
  const started = Date.now();
  const folders = await env.DB.prepare(
    `SELECT * FROM library_folders WHERE library_id = ? ORDER BY added_at ASC`,
  ).bind(libraryId).all<FolderRow>();

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

    for (const file of entries) {
      // Group rule: a single audiobook lives at a directory containing one
      // audio file (current MVP). Use the parent dir as the item rel_path; if
      // the file is at the folder root, use the file path itself.
      const slash = file.relPath.lastIndexOf('/');
      const itemRel = slash > 0 ? file.relPath.slice(0, slash) : file.relPath;
      if (known.has(itemRel)) {
        report.skipped++;
        continue;
      }

      try {
        const probe = await probeBook({
          env, adapter, folder, file, itemRel,
        });
        if (probe === 'skipped') {
          report.skipped++;
        } else {
          report.added++;
          known.add(itemRel);
        }
      } catch (e) {
        report.errors.push({ relPath: file.relPath, reason: (e as Error).message });
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
      else if (/\.(m4b|m4a|aac)$/i.test(e.relPath)) out.push(e);
    }
  }
  return out;
}

// Probe one audio file and insert all the metadata rows. Returns 'skipped'
// when we deliberately decline (e.g. unsupported multi-file layout — those
// land in errors instead at the call site, but reserve the name).
async function probeBook(args: {
  env: Env;
  adapter: Awaited<ReturnType<typeof getAdapter>>;
  folder: FolderRow;
  file: RemoteEntry;
  itemRel: string;
}): Promise<'added' | 'skipped'> {
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
  const year = probe.tags['©day'] ? Number(probe.tags['©day']!.slice(0, 4)) : null;

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

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO library_items
         (id, library_id, folder_id, ino, rel_path, is_file, media_type, is_missing, is_invalid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'book', 0, 0, ?, ?)`,
    ).bind(itemId, folder.library_id, folder.id, ino, itemRel, isFile, now, now),

    env.DB.prepare(
      `INSERT INTO book_metadata
         (library_item_id, title, title_ignore_prefix, subtitle, author_name, narrator_name,
          series_name, series_sequence, description, isbn, asin, language, publish_year,
          publisher, genres, tags, explicit, abridged, cover_url)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', 0, 0, NULL)`,
    ).bind(itemId, title, sortKey(title), author, narrator, year, album),

    env.DB.prepare(
      `INSERT INTO audio_files
         (id, library_item_id, index_no, filedn_url, ino, duration_seconds, size_bytes,
          mime_type, format, codec, bitrate, sample_rate, channels, added_at,
          rel_path, provider_file_id)
       VALUES (?, ?, 1, ?, ?, ?, ?, 'audio/mp4', 'mp4', 'aac', NULL, NULL, NULL, ?, ?, ?)`,
    ).bind(
      audioId, itemId, stableUrl, audioIno,
      probe.durationSeconds ?? 0,
      file.sizeBytes ?? 0,
      now,
      file.relPath,
      file.providerId ?? null,
    ),
  ]);

  return 'added';
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
): Promise<{ added: boolean; itemId?: string; reason?: string }> {
  const folderRow = await env.DB.prepare(
    `SELECT * FROM library_folders WHERE library_id = ? ORDER BY added_at ASC LIMIT 1`,
  ).bind(libraryId).first<FolderRow>();
  if (!folderRow) return { added: false, reason: 'No folder configured for library' };

  // Idempotency: skip if a row already covers this path (item dir or file).
  const slash = relPath.lastIndexOf('/');
  const itemRel = slash > 0 ? relPath.slice(0, slash) : relPath;
  const dup = await env.DB.prepare(
    `SELECT id FROM library_items WHERE folder_id = ? AND rel_path IN (?, ?)`,
  ).bind(folderRow.id, itemRel, relPath).first<{ id: string }>();
  if (dup) return { added: false, itemId: dup.id, reason: 'Already in library' };

  const adapter = await getAdapter(env, folderRow);
  const file = { relPath, isDir: false } as RemoteEntry;
  await probeBook({ env, adapter, folder: folderRow, file, itemRel });
  // probeBook generates an id internally; re-query to surface it.
  const fresh = await env.DB.prepare(
    `SELECT id FROM library_items WHERE folder_id = ? AND rel_path = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(folderRow.id, itemRel).first<{ id: string }>();
  const out: { added: boolean; itemId?: string; reason?: string } = { added: true };
  if (fresh?.id) out.itemId = fresh.id;
  return out;
}
