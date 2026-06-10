import type { Env } from '../types';
import type { AudioFileRow, LibraryFolderRow } from '../db/library';
import { resolveStreamUrl, audioContentType } from './resolve';
import { parseRange } from './moov-cache';

// Opportunistic R2 cache of arbitrary audio byte ranges. Complements
// moov-cache.ts: that one targets the small `moov` atom (fixes iOS's
// seek-to-moov pathology for non-fast-start MP4s); this one fills in
// progressively for any audio data a client repeatedly fetches.
//
// Why this exists: most well-encoded audiobooks are fast-start MP4s where
// moov sits at the front of the file, so the SW already caches it and iOS
// never asks the network for moov bytes. The actual cancel-retry failures
// happen on audio-data Range requests for chunks the SW *doesn't* have
// cached — typically iOS reading ahead from the playhead, or seeking to
// chapter boundaries. pCloud's ~800ms TTFB on those Ranges is what kills
// playback. If we cache those audio bytes in R2 (~50ms reads), Pholia's
// 3-retry error recovery can land successfully on a hit even if the first
// attempt missed.
//
// Layout: 4 MiB chunks keyed by `audio/<audio.id>/<chunk_index>`. 4 MiB
// chosen as a tradeoff:
//   - small enough that one chunk fetches + PUTs from pCloud → R2 in
//     roughly ~1-1.5s, fitting inside Pholia's 250/500/1000 ms retry
//     backoff budget so the *third* retry has a meaningful chance of
//     hitting a freshly-populated chunk
//   - large enough that one chunk covers a typical iOS read-ahead burst
//   - storage cost is reasonable: at 4 MiB × 167 chunks per ~668 MB book
//     × ~5 books = ~3.3 GB, well under the Workers Free 10 GB R2 quota

const CHUNK_SIZE = 4 * 1024 * 1024;

function chunkKey(audioId: string, chunkIndex: number): string {
  return `audio/${audioId}/${chunkIndex}`;
}

// Convert a (start byte) → (chunk index, chunk-start byte, chunk-end byte).
function chunkBoundsFor(byteOffset: number, totalSize: number): { idx: number; start: number; end: number } {
  const idx = Math.floor(byteOffset / CHUNK_SIZE);
  const start = idx * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
  return { idx, start, end };
}

// Serve a Range request by stitching cached R2 chunks together with a pCloud
// fallback for any uncached suffix, returned as a single 206 stream whose
// Content-Range exactly matches what the client asked for.
//
// Why stitch rather than truncate-at-chunk-boundary: iOS Safari rejects 206
// responses whose Content-Range end byte is shorter than the requested end
// — verified by observing iOS repeatedly re-issue the same start byte after
// a truncated response, instead of advancing to (chunk_end + 1) as a
// well-behaved client would. The shim has to satisfy the full Range or
// give up, not return partial.
//
// Two-phase stream:
//   1. Walk forward from range.start through consecutively-cached R2 chunks,
//      enqueueing slices. Stop at the first cache miss.
//   2. If there are bytes left to serve, fetch the remainder from pCloud in
//      a single Range request and pipe its body through.
//
// Returns null only if the *starting* chunk isn't cached — in that case the
// caller falls back to the existing pCloud streaming path (and kicks off a
// background warm for the missing chunk, so a retry can hit cache).
export async function tryServeByteRange(
  env: Env,
  folder: LibraryFolderRow,
  audio: AudioFileRow,
  rangeHeader: string | null,
): Promise<Response | null> {
  if (!audio.size_bytes) return null;
  const range = parseRange(rangeHeader, audio.size_bytes);
  if (!range) return null;

  const startChunk = chunkBoundsFor(range.start, audio.size_bytes);
  const startHead = await env.COVERS.head(chunkKey(audio.id, startChunk.idx));
  if (!startHead) return null;

  const responseLength = range.end - range.start + 1;

  // Pull-based so the client's consumption rate gates how fast we read from
  // R2/pCloud. An eager start()-loop pump buffered the entire remaining range
  // in isolate memory whenever the client (slow cellular) consumed slower
  // than upstream delivered — a `bytes=0-` on a multi-hundred-MB book could
  // exhaust the Worker's 128 MB. Each pull() enqueues at most one read.
  let cursor = range.start;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let upstreamDrained = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (reader) {
            const { value, done } = await reader.read();
            if (!done) {
              controller.enqueue(value);
              return;
            }
            reader = null;
            if (upstreamDrained) {
              controller.close();
              return;
            }
          }

          if (cursor > range.end) {
            controller.close();
            return;
          }

          // Phase 1: next consecutively-cached chunk slice.
          const chunk = chunkBoundsFor(cursor, audio.size_bytes);
          const offsetInChunk = cursor - chunk.start;
          const sliceLen = Math.min(range.end, chunk.end) - cursor + 1;
          const r2 = await env.COVERS.get(chunkKey(audio.id, chunk.idx), {
            range: { offset: offsetInChunk, length: sliceLen },
          });
          if (r2) {
            reader = r2.body.getReader();
            cursor += sliceLen;
            continue;
          }

          // Phase 2: fall back to pCloud for all remaining bytes. One Range
          // request, piped through. Adds ~500ms of TTFB at the seam, but by
          // then iOS has already buffered the cached prefix and is happily
          // decoding ahead of its own playhead.
          const streamUrl = await resolveStreamUrl(env, folder, audio);
          const upstream = await fetch(streamUrl.url, {
            headers: { Range: `bytes=${cursor}-${range.end}` },
          });
          // Anything other than 206 means the body doesn't match our declared
          // Content-Range (a 200 restarts at byte 0; an expired-filelink 403
          // is an HTML error page) — erroring lets the client retry cleanly
          // instead of decoding garbage mid-stream.
          if (upstream.status !== 206 || !upstream.body) {
            throw new Error(`upstream range fetch returned ${upstream.status} at byte ${cursor}`);
          }
          reader = upstream.body.getReader();
          upstreamDrained = true;
          cursor = range.end + 1;
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      reader?.cancel().catch(() => {});
      reader = null;
    },
  });

  return new Response(stream, {
    status: 206,
    headers: {
      'Content-Type': audioContentType(audio),
      'Content-Range': `bytes ${range.start}-${range.end}/${audio.size_bytes}`,
      'Content-Length': String(responseLength),
      'Accept-Ranges': 'bytes',
    },
  });
}

// Background-fetch one chunk-aligned region from pCloud and store in R2.
// Idempotent against the same chunk via a HEAD check. Best-effort — all
// errors swallowed; the streaming path falls back to pCloud as today.
//
// Called from /play (to pre-warm the playhead) and from /file/:fileId on
// cache miss (to warm what was just requested so the next retry hits).
export async function warmByteChunk(
  env: Env,
  folder: LibraryFolderRow,
  audio: AudioFileRow,
  byteOffset: number,
): Promise<void> {
  if (!audio.size_bytes) return;
  if (byteOffset < 0 || byteOffset >= audio.size_bytes) return;

  const chunk = chunkBoundsFor(byteOffset, audio.size_bytes);
  const key = chunkKey(audio.id, chunk.idx);

  try {
    const existing = await env.COVERS.head(key);
    if (existing) return;

    const streamUrl = await resolveStreamUrl(env, folder, audio);
    const upstream = await fetch(streamUrl.url, {
      headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
    });
    if (upstream.status !== 206 && upstream.status !== 200) return;

    const bytes = new Uint8Array(await upstream.arrayBuffer());
    const expected = chunk.end - chunk.start + 1;
    if (bytes.byteLength !== expected) return;

    await env.COVERS.put(key, bytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
  } catch {
    // best-effort
  }
}

// Stream pCloud directly to the client (low TTFB) while teeing the bytes
// into R2 as chunk-aligned PUTs (no double pCloud fetch). Bytes that fall
// inside a chunk we don't have the full start of (mid-chunk request start)
// are streamed to the client but skipped on the cache side — the missing
// prefix would make the R2 chunk invalid. The caller is expected to fire
// an explicit warm for that boundary chunk via waitUntil if it cares.
//
// Why tee rather than awaiting a warm before serving: the prior
// await-warm path made first-byte latency ~5 s (pCloud chunk download
// time), which exceeded iOS's ~1 s Range stall budget and triggered
// cancel-retry storms. With tee, first byte lands within pCloud TTFB
// (~800 ms) and R2 fills as the bytes flow, so the *next* request hits
// the fast path naturally without paying the latency cost up front.
export async function streamAndCache(
  env: Env,
  folder: LibraryFolderRow,
  audio: AudioFileRow,
  req: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  const provider = folder.provider ?? 'public_url';
  // Non-pcloud providers redirect; nothing to tee.
  if (provider !== 'pcloud_oauth' || !audio.size_bytes) {
    const stream = await resolveStreamUrl(env, folder, audio);
    if (provider !== 'pcloud_oauth') return Response.redirect(stream.url, 302);
    // Fallback: no size means we can't compute chunk boundaries — just proxy.
    const fwd = new Headers();
    const range = req.headers.get('Range');
    if (range) fwd.set('Range', range);
    const upstream = await fetch(stream.url, { headers: fwd });
    const respHeaders = new Headers(upstream.headers);
    respHeaders.delete('access-control-allow-origin');
    respHeaders.set('content-type', audioContentType(audio));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  }

  const stream = await resolveStreamUrl(env, folder, audio);
  const fwd = new Headers();
  const range = req.headers.get('Range');
  if (range) fwd.set('Range', range);
  const upstream = await fetch(stream.url, { headers: fwd });

  if (!upstream.body || (upstream.status !== 200 && upstream.status !== 206)) {
    const respHeaders = new Headers(upstream.headers);
    respHeaders.delete('access-control-allow-origin');
    respHeaders.set('content-type', audioContentType(audio));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  }

  // Where does this response start in the file? Need this to align tee'd
  // bytes against the 4 MiB chunk grid.
  let respStart = 0;
  if (upstream.status === 206) {
    const cr = upstream.headers.get('Content-Range');
    const m = cr ? /bytes (\d+)-/.exec(cr) : null;
    if (m) respStart = Number(m[1]);
  }

  const [clientBranch, cacheBranch] = upstream.body.tee();
  ctx.waitUntil(accumulateChunks(env, audio, cacheBranch, respStart));

  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete('access-control-allow-origin');
  respHeaders.set('content-type', audioContentType(audio));
  return new Response(clientBranch, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

// Drain a stream of audio bytes and PUT each chunk-aligned 4 MiB region
// into R2 as it completes. Mid-chunk start regions are skipped (we don't
// have their prefix and a truncated chunk would corrupt tryServeByteRange).
// All errors swallowed — this is best-effort caching.
async function accumulateChunks(
  env: Env,
  audio: AudioFileRow,
  stream: ReadableStream<Uint8Array>,
  startByte: number,
): Promise<void> {
  const totalSize = audio.size_bytes;
  if (!totalSize) return;
  const reader = stream.getReader();
  let bytePos = startByte;
  let buf: Uint8Array | null = null;
  let bufOffset = 0;
  let bufChunkIdx = -1;
  let bufLen = 0;

  const flush = async () => {
    if (buf && bufOffset === bufLen) {
      const key = chunkKey(audio.id, bufChunkIdx);
      try {
        const existing = await env.COVERS.head(key);
        if (!existing) {
          await env.COVERS.put(key, buf, {
            httpMetadata: { contentType: 'application/octet-stream' },
          });
        }
      } catch {}
    }
    buf = null;
    bufOffset = 0;
    bufChunkIdx = -1;
    bufLen = 0;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      let remaining = value;
      while (remaining.byteLength > 0) {
        const chunkIdx = Math.floor(bytePos / CHUNK_SIZE);
        const chunkStart = chunkIdx * CHUNK_SIZE;
        const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, totalSize - 1);
        const chunkLen = chunkEnd - chunkStart + 1;

        if (bufChunkIdx !== chunkIdx) {
          if (buf) await flush();
          if (bytePos === chunkStart) {
            buf = new Uint8Array(chunkLen);
            bufOffset = 0;
            bufChunkIdx = chunkIdx;
            bufLen = chunkLen;
          } else {
            // Mid-chunk start — skip bytes through to the next chunk.
            const skipTo = chunkStart + CHUNK_SIZE;
            const skip = Math.min(skipTo - bytePos, remaining.byteLength);
            bytePos += skip;
            remaining = remaining.subarray(skip);
            continue;
          }
        }
        const want = bufLen - bufOffset;
        const copy = Math.min(want, remaining.byteLength);
        buf!.set(remaining.subarray(0, copy), bufOffset);
        bufOffset += copy;
        bytePos += copy;
        remaining = remaining.subarray(copy);
        if (bufOffset === bufLen) await flush();
      }
    }
  } catch {
    // best-effort
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// Estimate the byte offset for a given audio time. Uses a linear mapping
// from time → byte over the *audio data* region (i.e. excluding the moov
// atom at the front, since that doesn't contribute audio bytes). For a
// constant-bitrate file the estimate is exact; for VBR it's approximate
// but typically within 1-2 chunks, which is fine since we cache one chunk
// of slop on either side anyway.
//
// Returns null if we don't have enough info to estimate (no duration, no
// size, or pathological inputs).
export function estimateByteOffsetForTime(
  audio: AudioFileRow,
  durationSeconds: number,
  currentTimeSeconds: number,
): number | null {
  if (!audio.size_bytes || !durationSeconds || durationSeconds <= 0) return null;
  if (currentTimeSeconds < 0) return null;
  const moovEnd = (audio.moov_offset ?? 0) + (audio.moov_size ?? 0);
  const audioBytes = audio.size_bytes - moovEnd;
  if (audioBytes <= 0) return null;
  const t = Math.min(currentTimeSeconds, durationSeconds);
  return moovEnd + Math.floor((t / durationSeconds) * audioBytes);
}

export { CHUNK_SIZE };
