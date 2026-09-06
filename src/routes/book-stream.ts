// One continuous resource for a multi-file book.
//
// Why this exists: iOS will not start a NEW media load while the app is
// backgrounded. At a track boundary the element takes the metadata, reports
// itself as playing, lets the lock screen tick — and produces no sound until
// the app is opened (Pholia crash logs, 2026-09-06). It happens whether the
// bytes come from the service worker or straight from the network, because
// the block is on starting the load, not on who serves it. A book split into
// 15 mp3 parts therefore stops roughly every hour unless the user unlocks
// their phone.
//
// The fix is to not have boundaries: serve the whole book as one file. mp3
// frames are self-contained, so a byte-wise concatenation decodes straight
// through, and a player that loaded it once keeps playing to the end of the
// book without ever starting another load.
//
// Byte ranges map onto the parts by their known sizes, so seeking works the
// way it does for any single file. Duration comes out right when the parts
// share an encode, which is what a split audiobook is.

import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import { getItem, getFolderById, getAudioFiles, type AudioFileRow, type LibraryFolderRow } from '../db/library';
import { resolveStreamUrl, fetchWithHeaderTimeout, audioContentType } from '../storage/resolve';

export const bookStreamRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();
bookStreamRoutes.use('*', requireAuth);

type Part = { audio: AudioFileRow; start: number; end: number };   // end exclusive

// Only files whose size D1 knows can be laid end to end; one unknown size
// makes every offset after it a guess.
function layout(files: AudioFileRow[]): { parts: Part[]; total: number } | null {
  const parts: Part[] = [];
  let total = 0;
  for (const audio of files) {
    if (!audio.size_bytes) return null;
    parts.push({ audio, start: total, end: total + audio.size_bytes });
    total += audio.size_bytes;
  }
  return parts.length ? { parts, total } : null;
}

function parseRange(header: string | null, total: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  // A suffix range ("bytes=-N") asks for the last N bytes.
  if (rawStart === '') {
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { start: Math.max(0, total - n), end: total - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= total) return null;
  const end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

// Pull one part's bytes, honouring the sub-range this request needs from it.
async function fetchPart(env: Env, folder: LibraryFolderRow, audio: AudioFileRow, from: number, to: number): Promise<Response> {
  const stream = await resolveStreamUrl(env, folder, audio);
  const headers = new Headers({ Range: `bytes=${from}-${to}` });
  if (stream.headers) for (const [k, v] of Object.entries(stream.headers)) headers.set(k, v);
  // Same retry as the single-file path: a pCloud hang otherwise reaches the
  // client as a dead wait, which iOS turns into a fatal error.
  try {
    const res = await fetchWithHeaderTimeout(stream.url, headers);
    if (res.status < 500) return res;
  } catch { /* fall through to one retry */ }
  return fetchWithHeaderTimeout(stream.url, headers);
}

bookStreamRoutes.get('/:id/stream', async (c) => {
  const tenantId = c.get('tenantId');
  const item = await getItem(c.env, c.req.param('id'), tenantId);
  if (!item) return c.json({ error: 'Item not found' }, 404);
  const folder = await getFolderById(c.env, item.folder_id, tenantId);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);
  const files = await getAudioFiles(c.env, item.id, tenantId);
  const laid = layout(files);
  if (!laid) return c.json({ error: 'This book has no files, or a file with an unknown size' }, 409);
  const { parts, total } = laid;

  const contentType = audioContentType(parts[0]!.audio);
  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    // Parts never change once scanned; the id changes if the book is re-added.
    'Cache-Control': 'private, max-age=86400',
  };

  if (c.req.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(total) } });
  }

  const range = parseRange(c.req.header('Range') ?? null, total);
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const wanted = parts.filter((p) => p.start <= end && p.end > start);

  // Sequential: open each part only when the previous one is drained, so a
  // long range doesn't hold several upstream connections at once and the
  // Worker's subrequest budget goes on bytes the client is actually reading.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = wanted.shift();
      if (!part) { controller.close(); return; }
      const from = Math.max(0, start - part.start);
      const to = Math.min(part.audio.size_bytes - 1, end - part.start);
      let res: Response;
      try {
        res = await fetchPart(c.env, folder, part.audio, from, to);
      } catch (e) {
        controller.error(new Error(`part ${part.audio.index_no}: ${(e as Error).message}`));
        return;
      }
      if (!res.ok || !res.body) {
        controller.error(new Error(`part ${part.audio.index_no}: upstream ${res.status}`));
        return;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) controller.enqueue(value);
      }
    },
    cancel() { wanted.length = 0; },
  });

  if (!range) {
    return new Response(body, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(total) } });
  }
  return new Response(body, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
    },
  });
});
