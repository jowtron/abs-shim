// Held copies of an episode (2026-11-08, migration 0038): "Play without ads,
// I'll wait".
//
// An ad-inserting host (art19, Audioboom, Megaphone…) serves a different
// stitch per download, so an analysis of a STREAMED copy is right only until
// the next restitch, which is why the pump otherwise waits for the pCloud
// archive (episode-analysis.ts, waitsForArchive). A listen run instead keeps
// the exact bytes the analysis job downloads: the job's audioUrl carries a
// signed `hold=` marker, and for that one request the stream route fetches
// the publisher's whole file and writes it both to the node and into R2
// (`held/<episodeId>/<size>` in the COVERS bucket). Only when R2 holds every
// byte is the hold recorded, and from then on every client's stream of that
// episode is served from the held copy, so the bytes analysed == the bytes
// held == the bytes played, and `size_bytes` (what an analysis is matched
// on) is the held size.
//
// Why the stream is pumped by hand rather than tee()'d: a tee buffers
// whatever the slower branch hasn't read, and the faster branch (R2) would
// pull the whole publisher body while the Mac is still reading, up to the
// whole file in a 128 MB isolate. Here each chunk is written to both and
// both writes are awaited, so the pace is the slower of the two and only a
// chunk or two is ever in memory. The R2 side is one streamed put through a
// FixedLengthStream, so a hold needs the publisher's Content-Length (every
// host seen sends one for a plain GET); without it the file streams to the
// node as before and nothing is held.
//
// Kept HOLD_KEEP_MS (3 days) past the last play, bumped at most hourly by
// the stream route; the 2-minute cron deletes expired ones (pruneHolds), and
// a safety-net lifecycle rule on `held/` (30 days) catches an object whose
// row never got written. An archived episode plays from pCloud, so its hold
// is dropped once the archive lands.

import type { Env } from '../types';
import type { EpisodeRow } from '../db/podcasts';
import type { AudioFileRow } from '../db/library';
import { EPISODE_AUDIO_UA } from './podcast-shapes';
import { fetchWithHeaderTimeout } from '../storage/resolve';
import { noteAudioHost } from './audio-host';

export const HOLD_MAX_BYTES = 500 * 1024 * 1024;
export const HOLD_KEEP_MS = 3 * 24 * 3600_000;
const HOLD_BUMP_MS = 3600_000;
// The marker outlives the job's 20-minute token a little: the node fetches
// the audio within a minute of the submit.
const HOLD_URL_MS = 30 * 60_000;
const PRUNE_PER_TICK = 5;

export type HoldRow = {
  episode_id: string;
  library_item_id: string;
  ino: string;
  size_bytes: number;
  r2_key: string;
  created_at: number;
  held_until: number;
};

export const holdKey = (episodeId: string, size: number) => `held/${episodeId}/${size}`;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function holdSig(env: Env, episodeId: string, exp: number): Promise<string> {
  const secret = env.JWT_SECRET ?? '';
  if (!secret) throw new Error('JWT_SECRET not configured');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // Prefixed, so it can never verify as another of the shim's signatures.
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`episode-hold\n${episodeId}\n${exp}`)));
}

// The `hold` query value for one episode's analysis download.
export async function holdParam(env: Env, episodeId: string): Promise<string> {
  const exp = Date.now() + HOLD_URL_MS;
  return `${exp}.${await holdSig(env, episodeId, exp)}`;
}

export async function verifyHoldParam(env: Env, episodeId: string, v: string): Promise<boolean> {
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(v);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > Date.now())) return false;
  try { return sameString(await holdSig(env, episodeId, exp), m[2]!); } catch { return false; }
}

// Whether an episode's file can be held at all: not one that plays from
// pCloud, not a video (a 3 GB mp4 is no audio stream to keep), and not one
// already known to be over the cap.
export function holdEligible(e: Pick<EpisodeRow, 'archive_state' | 'archive_rel_path' | 'file_type' | 'size_bytes'>): boolean {
  if (e.archive_state === 'done' && e.archive_rel_path) return false;
  if ((e.file_type ?? '').toLowerCase().startsWith('video/')) return false;
  return !(e.size_bytes > HOLD_MAX_BYTES);
}

export async function getHold(env: Env, episodeId: string): Promise<HoldRow | null> {
  return env.DB.prepare('SELECT * FROM episode_holds WHERE episode_id = ?').bind(episodeId).first<HoldRow>();
}

// The stream route's lookup, run beside the episode lookup (by ino, or by
// id as getEpisodeForFile also accepts); the caller checks it is the same
// episode. The table holds a handful of rows.
export async function findHoldForFile(env: Env, itemId: string, fileId: string): Promise<HoldRow | null> {
  return env.DB.prepare('SELECT * FROM episode_holds WHERE library_item_id = ? AND (ino = ? OR episode_id = ?) LIMIT 1')
    .bind(itemId, fileId, fileId).first<HoldRow>();
}

// ─── Serving the held copy ───────────────────────────────────────────────────

// GET/HEAD from R2 with Range. null when the object has gone (deleted out of
// band): the row goes too and the caller streams from the publisher.
export async function serveHeld(env: Env, ctx: ExecutionContext, hold: HoldRow, contentType: string, req: Request): Promise<Response | null> {
  const size = hold.size_bytes;
  const now = Date.now();
  // "A few days after it's been played": pushed on by playback, written at
  // most once an hour per episode.
  if (hold.held_until < now + HOLD_KEEP_MS - HOLD_BUMP_MS) {
    ctx.waitUntil(env.DB.prepare('UPDATE episode_holds SET held_until = ? WHERE episode_id = ? AND r2_key = ?')
      .bind(now + HOLD_KEEP_MS, hold.episode_id, hold.r2_key).run().then(() => undefined, () => undefined));
  }
  const headers = new Headers({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
  if (req.method === 'HEAD') {
    headers.set('Content-Length', String(size));
    return new Response(null, { status: 200, headers });
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get('Range') ?? '').trim());
  let range: { offset: number; length: number } | null = null;
  if (m && (m[1] || m[2])) {
    let start: number, end: number;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Content-Type': contentType } });
    }
    range = { offset: start, length: end - start + 1 };
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  const obj = await env.COVERS.get(hold.r2_key, range ? { range } : {});
  if (!obj || !('body' in obj)) {
    await env.DB.prepare('DELETE FROM episode_holds WHERE episode_id = ? AND r2_key = ?').bind(hold.episode_id, hold.r2_key).run().catch(() => undefined);
    return null;
  }
  headers.set('Content-Length', String(range ? range.length : size));
  return new Response(obj.body, { status: range ? 206 : 200, headers });
}

// ─── Making one ──────────────────────────────────────────────────────────────

// What the stream route passes through from a publisher's response.
function passThrough(upstream: Response, contentType: string): Response {
  const h = new Headers({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
  for (const k of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  if (upstream.headers.get('content-encoding')) h.delete('content-length');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: h });
}

// The analysis job's download (a plain full GET carrying a valid `hold`):
// the publisher's whole file, to the node and into R2 at once.
export async function holdingStream(env: Env, ctx: ExecutionContext, e: EpisodeRow, audio: AudioFileRow, contentType: string): Promise<Response> {
  const fwd = { 'User-Agent': EPISODE_AUDIO_UA };
  let upstream: Response;
  try {
    upstream = await fetchWithHeaderTimeout(audio.filedn_url, fwd);
    if (upstream.status >= 500) throw new Error(`publisher ${upstream.status}`);
  } catch {
    upstream = await fetchWithHeaderTimeout(audio.filedn_url, fwd);
  }
  if (upstream.ok) ctx.waitUntil(noteAudioHost(env, e, upstream.url || audio.filedn_url));
  const total = Number(upstream.headers.get('content-length') ?? '');
  const holdable = upstream.status === 200 && !!upstream.body && !upstream.headers.get('content-encoding')
    && Number.isSafeInteger(total) && total > 0 && total <= HOLD_MAX_BYTES;
  if (!holdable) {
    console.log(`[hold] ${e.id}: not held (status ${upstream.status}, length ${upstream.headers.get('content-length') ?? 'none'})`);
    return passThrough(upstream, contentType);
  }

  const startedAt = Date.now();
  const key = holdKey(e.id, total);
  const toR2 = new FixedLengthStream(total);
  let putError: unknown = null;
  const put = env.COVERS.put(key, toR2.readable, { httpMetadata: { contentType } })
    .then((o) => o, (err) => { putError = err; return null; });
  // Fixed-length on the node's side too: the runtime then sends the length
  // and a body cut short breaks the connection, where an identity stream
  // goes out chunked and a cut reads as a clean (short) end of file.
  const toClient = new FixedLengthStream(total);
  const cw = toClient.writable.getWriter();
  const hw = toR2.writable.getWriter();
  const reader = upstream.body!.getReader();

  const pump = (async () => {
    let n = 0;
    let holding = true;
    const stopHolding = (why: unknown) => {
      if (!holding) return;
      holding = false;
      hw.abort(why).catch(() => undefined);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > total) stopHolding(new Error('more bytes than the publisher said'));
        // A copy for R2: one buffer handed to two streams may be detached by
        // whichever consumes it first.
        const writes: Promise<unknown>[] = [cw.write(value)];
        if (holding) writes.push(hw.write(value.slice()).catch((err) => stopHolding(err)));
        await Promise.all(writes);
      }
      await cw.close();
    } catch (err) {
      // The node went away, or the publisher's body broke: no hold.
      stopHolding(err);
      cw.abort(err).catch(() => undefined);
      reader.cancel(err).catch(() => undefined);
      console.log(`[hold] ${e.id}: download cut at ${n} of ${total} bytes; nothing held`);
      await put;
      return;
    }
    if (holding && n === total) await hw.close().catch((err) => { putError = err; });
    else stopHolding(new Error(`short body: ${n} of ${total} bytes`));
    const obj = await put;
    if (!holding || putError || !obj || obj.size !== total) {
      console.log(`[hold] ${e.id}: not held (${n} of ${total} bytes${putError ? `, R2: ${(putError as Error).message ?? putError}` : ''})`);
      if (obj) await env.COVERS.delete(key).catch(() => undefined);
      return;
    }
    await recordHold(env, e, total, key, startedAt);
  })().catch((err) => console.log(`[hold] ${e.id}: ${(err as Error).message}`));
  ctx.waitUntil(pump);

  const h = new Headers({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Content-Length': String(total) });
  for (const k of ['etag', 'last-modified']) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  return new Response(toClient.readable, { status: 200, headers: h });
}

// R2 has every byte: the hold becomes the episode's file. A newer hold
// recorded while this one downloaded wins; an archive that landed meanwhile
// wins too (archived episodes play from pCloud).
async function recordHold(env: Env, e: EpisodeRow, size: number, key: string, startedAt: number): Promise<void> {
  const [prev, cur] = await Promise.all([
    getHold(env, e.id),
    env.DB.prepare('SELECT archive_state, archive_rel_path FROM podcast_episodes WHERE id = ?').bind(e.id)
      .first<{ archive_state: string | null; archive_rel_path: string | null }>(),
  ]);
  if (!cur || (cur.archive_state === 'done' && cur.archive_rel_path) || (prev && prev.created_at > startedAt)) {
    if (!prev || prev.r2_key !== key) await env.COVERS.delete(key).catch(() => undefined);
    console.log(`[hold] ${e.id}: superseded before it was recorded`);
    return;
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO episode_holds (episode_id, library_item_id, ino, size_bytes, r2_key, created_at, held_until)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (episode_id) DO UPDATE SET ino = excluded.ino, size_bytes = excluded.size_bytes, r2_key = excluded.r2_key,
         created_at = excluded.created_at, held_until = excluded.held_until`,
    ).bind(e.id, e.library_item_id, e.ino, size, key, now, now + HOLD_KEEP_MS),
    // The held size is the file served from now on, which is what an
    // analysis is matched on. chapters_checked_at is left alone: the chapter
    // probe reads the publisher's stitch, not this one.
    env.DB.prepare('UPDATE podcast_episodes SET size_bytes = ? WHERE id = ?').bind(size, e.id),
  ]);
  if (prev && prev.r2_key !== key) await env.COVERS.delete(prev.r2_key).catch(() => undefined);
  console.log(`[hold] ${e.id}: held ${size} bytes`);
  // An analysis of these exact bytes may already be stored (the node's
  // result can land first); it is the episode's from now on.
  const { adoptAnalysisForSize } = await import('./episode-analysis');
  await adoptAnalysisForSize(env, e.id, size).catch(() => undefined);
}

// ─── Letting go ──────────────────────────────────────────────────────────────

// Cron: holds past held_until, of episodes since archived, or of episodes
// gone. The stream route then goes back to the publisher, and the restitch
// rule there (a new size → its analysis, if any) applies.
export async function pruneHolds(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT h.episode_id, h.r2_key FROM episode_holds h LEFT JOIN podcast_episodes e ON e.id = h.episode_id
      WHERE h.held_until < ? OR e.id IS NULL OR (e.archive_state = 'done' AND e.archive_rel_path IS NOT NULL)
      LIMIT ?`,
  ).bind(Date.now(), PRUNE_PER_TICK).all<{ episode_id: string; r2_key: string }>();
  const log: string[] = [];
  for (const r of rows.results) {
    await env.COVERS.delete(r.r2_key).catch(() => undefined);
    await env.DB.prepare('DELETE FROM episode_holds WHERE episode_id = ? AND r2_key = ?').bind(r.episode_id, r.r2_key).run();
    log.push(`hold released: ${r.episode_id}`);
  }
  return log;
}

// A show being deleted: its held objects (the rows go in
// itemDeleteStatements' batch).
export async function deleteItemHeldObjects(env: Env, itemId: string): Promise<void> {
  const rows = await env.DB.prepare('SELECT r2_key FROM episode_holds WHERE library_item_id = ?').bind(itemId).all<{ r2_key: string }>();
  const keys = rows.results.map((r) => r.r2_key);
  if (keys.length) await env.COVERS.delete(keys).catch(() => undefined);
}
