// Pure-JS MP4/m4b prober. Reads the `moov` atom via HTTP Range requests and
// extracts the bits ABS clients need: duration, iTunes metadata tags, embedded
// cover art, chapter list. No FFmpeg, no Node stdlib — DataView only.
//
// MP4 layout primer:
//   File = sequence of top-level "boxes" (a.k.a. atoms).
//   Each box: [size:u32][type:4 bytes][...payload]. Size 1 means "size is u64
//   in next 8 bytes"; size 0 means "extends to EOF" (only valid for mdat).
//   The two boxes we care about are `moov` (metadata, small) and `mdat` (audio
//   bytes, huge). `moov` may sit before `mdat` (fast-start) or after it.
//
// Strategy:
//   1. Range 0-65535. If we see `moov`, range-fetch the full moov.
//   2. If we see `ftyp`/`free`/etc., walk forward.
//   3. If we hit `mdat` with size ≤ remaining file, jump past it (chain of
//      range requests if needed).
//   4. If `mdat` size is 0 or extends to EOF, `moov` must be before it (handled
//      in steps 1-3) — otherwise the file is malformed and we error.

const PREFIX_BYTES = 64 * 1024;          // first range request size
const MOOV_MAX_BYTES = 16 * 1024 * 1024; // hard cap; real moov atoms are <2MB

const td = new TextDecoder('latin1');
function fourCC(view: DataView, offset: number): string {
  return td.decode(new Uint8Array(view.buffer, view.byteOffset + offset, 4));
}

export type Box = {
  type: string;
  start: number;        // absolute byte offset of the box header
  headerSize: number;   // 8 or 16
  size: number;         // total box size including header (0 = to-EOF)
  payloadOffset: number;
  payloadSize: number;
};

// Parse a single box header from `view` at `offset` in absolute file coords
// (`view` covers `viewStart..viewStart+view.byteLength`).
function readBox(view: DataView, viewStart: number, offset: number): Box | null {
  const local = offset - viewStart;
  if (local + 8 > view.byteLength) return null;
  let size = view.getUint32(local);
  const type = fourCC(view, local + 4);
  let headerSize = 8;
  if (size === 1) {
    if (local + 16 > view.byteLength) return null;
    // 64-bit size — read upper and lower halves.
    const hi = view.getUint32(local + 8);
    const lo = view.getUint32(local + 12);
    size = hi * 0x1_0000_0000 + lo;
    headerSize = 16;
  }
  return {
    type,
    start: offset,
    headerSize,
    size,                     // 0 means to-EOF for mdat
    payloadOffset: offset + headerSize,
    payloadSize: size === 0 ? -1 : size - headerSize,
  };
}

// Issue a single Range request, return the bytes plus the response (so callers
// can read Content-Length, etc.) — important: Cloudflare's fetch from inside
// a Worker honours `Range` and CDNs return 206 normally.
async function rangeFetch(url: string, start: number, endInclusive: number): Promise<{ bytes: Uint8Array; totalSize: number | null }> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`Range fetch failed: ${res.status} ${res.statusText}`);
  }
  let buf: Uint8Array;
  if (res.status === 200) {
    // Upstream ignored Range and is sending the whole file — arrayBuffer()
    // on a multi-hundred-MB audiobook would OOM the Worker (128 MB). Read
    // only the requested window, then cancel the rest of the body.
    const wanted = endInclusive - start + 1;
    const reader = res.body!.getReader();
    const out = new Uint8Array(wanted);
    let pos = 0;      // absolute byte position in the 200 stream
    let written = 0;  // bytes captured into the window
    while (written < wanted) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunkStart = pos;
      pos += value.length;
      const from = Math.max(chunkStart, start);
      const to = Math.min(pos, endInclusive + 1);
      if (to > from) {
        out.set(value.subarray(from - chunkStart, to - chunkStart), from - start);
        written += to - from;
      }
    }
    reader.cancel().catch(() => {});
    buf = written === wanted ? out : out.subarray(0, written);
  } else {
    buf = new Uint8Array(await res.arrayBuffer());
  }
  // Parse Content-Range to learn total file size if we got a 206.
  let totalSize: number | null = null;
  const cr = res.headers.get('Content-Range');
  if (cr) {
    const m = cr.match(/\/(\d+)$/);
    if (m) totalSize = Number(m[1]);
  } else {
    const cl = res.headers.get('Content-Length');
    if (cl) totalSize = Number(cl);
  }
  return { bytes: buf, totalSize };
}

// Locate the moov box by walking top-level boxes. Returns the moov payload
// (header stripped) along with the absolute byte offset and total size
// (including header) of the moov atom in the source file — callers cache
// `[moovOffset, moovOffset + moovSize)` to R2 so iOS's seek-to-moov request
// can be served without a pCloud round-trip.
export async function fetchMoov(
  url: string,
): Promise<{ moov: Uint8Array; headerType: string; moovOffset: number; moovSize: number }> {
  // Step 1: read prefix.
  const { bytes: prefix, totalSize } = await rangeFetch(url, 0, PREFIX_BYTES - 1);
  let view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  let viewStart = 0;
  let cursor = 0;

  // Walk boxes within the prefix until we find moov or run out.
  while (cursor + 8 <= prefix.length) {
    const box = readBox(view, viewStart, cursor);
    if (!box) break;
    if (box.type === 'moov') {
      return {
        moov: await readBoxFully(url, prefix, box),
        headerType: 'moov',
        moovOffset: box.start,
        moovSize: box.size,
      };
    }
    // Bail if mdat is too big to step over within the prefix; in that case the
    // moov is likely AFTER mdat — handle below.
    if (box.payloadSize < 0 || cursor + box.size > prefix.length) {
      // Step over by extending: try to jump past this box with another range
      // request. For a huge mdat that's the whole file, fall through to the
      // tail-scan branch below.
      if (box.size > 0 && totalSize !== null && box.start + box.size + 8 <= totalSize) {
        // Read just the next box header at box.start + box.size.
        const nextStart = box.start + box.size;
        const { bytes: hdr } = await rangeFetch(url, nextStart, nextStart + 31);
        const hview = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
        const next = readBox(hview, nextStart, nextStart);
        if (next?.type === 'moov') {
          return {
            moov: await readBoxFully(url, hdr, next, nextStart),
            headerType: 'moov',
            moovOffset: next.start,
            moovSize: next.size,
          };
        }
        // Otherwise abandon this approach and try tail scan.
      }
      break;
    }
    cursor += box.size;
  }

  // Step 2: tail scan — moov is somewhere near the end of the file.
  if (totalSize === null) throw new Error('moov not in prefix and unknown file size');
  const tailLen = Math.min(MOOV_MAX_BYTES, totalSize);
  const tailStart = totalSize - tailLen;
  const { bytes: tail } = await rangeFetch(url, tailStart, totalSize - 1);
  view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  viewStart = tailStart;

  // Walk the tail, looking for top-level moov. We may not start aligned to a
  // box boundary — search for the literal 'moov' fourCC at offset+4 with a
  // plausible size.
  for (let i = 0; i + 16 <= tail.length; i++) {
    if (
      tail[i + 4] === 0x6d && tail[i + 5] === 0x6f &&
      tail[i + 6] === 0x6f && tail[i + 7] === 0x76     // "moov"
    ) {
      const probe = readBox(view, viewStart, viewStart + i);
      if (probe?.type !== 'moov') continue;
      // Validate plausibility: size between 0x100 and 0x4000000.
      if (probe.size < 0x100 || probe.size > 0x4000000) continue;
      const moovOffset = viewStart + i;
      // If the moov fits within tail bytes, slice it; otherwise fetch.
      const localStart = i + probe.headerSize;
      const localEnd = i + probe.size;
      if (localEnd <= tail.length) {
        return {
          moov: tail.slice(localStart, localEnd),
          headerType: 'moov',
          moovOffset,
          moovSize: probe.size,
        };
      }
      return {
        moov: await readBoxFully(url, tail, probe, viewStart),
        headerType: 'moov',
        moovOffset,
        moovSize: probe.size,
      };
    }
  }
  throw new Error('moov atom not found');
}

// Read the full payload bytes of `box`. `prefix` may already contain part of
// it; if so, splice with a tail fetch.
async function readBoxFully(url: string, prefix: Uint8Array, box: Box, prefixStart = 0): Promise<Uint8Array> {
  const payloadStart = box.payloadOffset;
  const payloadEnd = box.payloadOffset + (box.payloadSize >= 0 ? box.payloadSize : 0);
  const haveStart = prefixStart;
  const haveEnd = prefixStart + prefix.length;

  if (payloadStart >= haveStart && payloadEnd <= haveEnd) {
    return prefix.slice(payloadStart - haveStart, payloadEnd - haveStart);
  }
  // Otherwise, fetch the rest.
  const fetchStart = Math.max(payloadStart, haveEnd);
  const { bytes: rest } = await rangeFetch(url, fetchStart, payloadEnd - 1);
  if (payloadStart >= haveStart && payloadStart < haveEnd) {
    const front = prefix.slice(payloadStart - haveStart, prefix.length);
    const out = new Uint8Array(front.length + rest.length);
    out.set(front, 0);
    out.set(rest, front.length);
    return out;
  }
  return rest;
}

// ─── moov inner walk ──────────────────────────────────────────────────────────

// Walk children inside a parent payload (relative-byte view).
function* walkChildren(payload: Uint8Array): Generator<{ type: string; start: number; size: number; headerSize: number }> {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let cursor = 0;
  while (cursor + 8 <= payload.length) {
    let size = view.getUint32(cursor);
    const type = fourCC(view, cursor + 4);
    let headerSize = 8;
    if (size === 1) {
      if (cursor + 16 > payload.length) break;
      const hi = view.getUint32(cursor + 8);
      const lo = view.getUint32(cursor + 12);
      size = hi * 0x1_0000_0000 + lo;
      headerSize = 16;
    }
    if (size < headerSize || cursor + size > payload.length) break;
    yield { type, start: cursor, size, headerSize };
    cursor += size;
  }
}

function findChild(payload: Uint8Array, type: string): Uint8Array | null {
  for (const c of walkChildren(payload)) {
    if (c.type === type) return payload.slice(c.start + c.headerSize, c.start + c.size);
  }
  return null;
}

function findPath(payload: Uint8Array, ...path: string[]): Uint8Array | null {
  let cur: Uint8Array | null = payload;
  for (const t of path) {
    if (!cur) return null;
    cur = findChild(cur, t);
  }
  return cur;
}

// ─── Extracted shape ──────────────────────────────────────────────────────────

// Parse a Nero-style chpl atom (moov/udta/chpl). Layout:
//   1 byte  version
//   3 bytes flags
//   4 bytes reserved   (only present when version > 0)
//   1 byte  count
//   per chapter:
//     8 bytes start time in 100-nanosecond units (BE u64)
//     1 byte  name length
//     N bytes UTF-8 name
// QuickTime chapter tracks (referenced via tref `chap`) aren't parsed here —
// implementing that requires reading a whole sub-track's stbl, which doubles
// the prober's complexity. Most audiobook tooling writes chpl too, so we
// cover the common case.
function parseChpl(udta: Uint8Array): Array<{ start: number; title: string }> {
  const chpl = findChild(udta, 'chpl');
  if (!chpl || chpl.length < 9) return [];
  const v = new DataView(chpl.buffer, chpl.byteOffset, chpl.byteLength);
  let off = 0;
  const version = v.getUint8(off); off += 4; // version + 3 flag bytes
  if (version > 0) off += 4;                 // reserved
  if (off >= chpl.length) return [];
  const count = v.getUint8(off); off += 1;
  const out: Array<{ start: number; title: string }> = [];
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (off + 9 > chpl.length) break;
    const hi = v.getUint32(off); off += 4;
    const lo = v.getUint32(off); off += 4;
    const start = (hi * 0x1_0000_0000 + lo) / 10_000_000; // 100ns → seconds
    const nameLen = v.getUint8(off); off += 1;
    if (off + nameLen > chpl.length) break;
    const title = dec.decode(chpl.slice(off, off + nameLen));
    off += nameLen;
    out.push({ start, title });
  }
  return out;
}

// Parse a QuickTime chapter track. Layout:
//   moov/trak (audio) — has tref/chap pointing at chapter-trak track_ids
//   moov/trak (chapter) — has its own mdia/minf/stbl with text samples; each
//     sample is `[u16-be length][utf8 text]` (sometimes followed by `encd`).
// The sample bytes live in mdat — typically interleaved with audio chunks, so
// chapter samples can be spread across hundreds of MB. We compute each
// sample's offset+size from stbl, then batch nearby samples into a small
// number of Range requests rather than issuing one fetch per chapter.
async function parseQtChapters(moov: Uint8Array, url: string): Promise<Array<{ start: number; title: string }>> {
  type Trak = { trackId: number; handlerType: string; body: Uint8Array };
  const traks: Trak[] = [];
  for (const c of walkChildren(moov)) {
    if (c.type !== 'trak') continue;
    const body = moov.slice(c.start + c.headerSize, c.start + c.size);
    const tkhd = findChild(body, 'tkhd');
    if (!tkhd || tkhd.length < 24) continue;
    const tv = new DataView(tkhd.buffer, tkhd.byteOffset, tkhd.byteLength);
    const tkhdVersion = tv.getUint8(0);
    const trackId = tkhdVersion === 1 ? tv.getUint32(20) : tv.getUint32(12);
    const hdlr = findPath(body, 'mdia', 'hdlr');
    let handlerType = '';
    if (hdlr && hdlr.length >= 12) {
      handlerType = fourCC(new DataView(hdlr.buffer, hdlr.byteOffset, hdlr.byteLength), 8);
    }
    traks.push({ trackId, handlerType, body });
  }

  const audio = traks.find((t) => t.handlerType === 'soun');
  if (!audio) return [];
  const chap = findPath(audio.body, 'tref', 'chap');
  if (!chap || chap.length < 4) return [];
  const cv = new DataView(chap.buffer, chap.byteOffset, chap.byteLength);
  const chapterTrackIds: number[] = [];
  for (let i = 0; i + 4 <= chap.length; i += 4) chapterTrackIds.push(cv.getUint32(i));
  const chapter = traks.find((t) => chapterTrackIds.includes(t.trackId));
  if (!chapter) return [];

  const mdhd = findPath(chapter.body, 'mdia', 'mdhd');
  if (!mdhd || mdhd.length < 24) return [];
  const mv = new DataView(mdhd.buffer, mdhd.byteOffset, mdhd.byteLength);
  const mdhdVersion = mv.getUint8(0);
  const timescale = mdhdVersion === 1 ? mv.getUint32(20) : mv.getUint32(12);
  if (!timescale) return [];

  const stbl = findPath(chapter.body, 'mdia', 'minf', 'stbl');
  if (!stbl) return [];

  // stts → per-sample durations
  const stts = findChild(stbl, 'stts');
  if (!stts) return [];
  const sv = new DataView(stts.buffer, stts.byteOffset, stts.byteLength);
  const sttsEntries = sv.getUint32(4);
  const sampleDurations: number[] = [];
  for (let i = 0; i < sttsEntries; i++) {
    const cnt = sv.getUint32(8 + i * 8);
    const delta = sv.getUint32(12 + i * 8);
    for (let j = 0; j < cnt; j++) sampleDurations.push(delta);
  }

  // Chunk offsets (stco u32 or co64 u64)
  const stco = findChild(stbl, 'stco');
  const co64 = findChild(stbl, 'co64');
  const chunkOffsets: number[] = [];
  if (stco) {
    const v = new DataView(stco.buffer, stco.byteOffset, stco.byteLength);
    const cnt = v.getUint32(4);
    for (let i = 0; i < cnt; i++) chunkOffsets.push(v.getUint32(8 + i * 4));
  } else if (co64) {
    const v = new DataView(co64.buffer, co64.byteOffset, co64.byteLength);
    const cnt = v.getUint32(4);
    for (let i = 0; i < cnt; i++) {
      const hi = v.getUint32(8 + i * 8);
      const lo = v.getUint32(12 + i * 8);
      chunkOffsets.push(hi * 0x1_0000_0000 + lo);
    }
  } else return [];

  // stsc → sample-to-chunk mapping
  const stsc = findChild(stbl, 'stsc');
  if (!stsc) return [];
  const cv2 = new DataView(stsc.buffer, stsc.byteOffset, stsc.byteLength);
  const stscEntries: Array<{ firstChunk: number; samplesPerChunk: number }> = [];
  const stscCount = cv2.getUint32(4);
  for (let i = 0; i < stscCount; i++) {
    stscEntries.push({
      firstChunk: cv2.getUint32(8 + i * 12),
      samplesPerChunk: cv2.getUint32(12 + i * 12),
    });
  }

  // stsz → per-sample size (or default size if first field non-zero)
  const stsz = findChild(stbl, 'stsz');
  if (!stsz) return [];
  const zv = new DataView(stsz.buffer, stsz.byteOffset, stsz.byteLength);
  const defaultSize = zv.getUint32(4);
  const sampleCount = zv.getUint32(8);
  const sampleSizes: number[] = [];
  if (defaultSize === 0) {
    for (let i = 0; i < sampleCount; i++) sampleSizes.push(zv.getUint32(12 + i * 4));
  } else {
    for (let i = 0; i < sampleCount; i++) sampleSizes.push(defaultSize);
  }

  // Compute each sample's absolute file offset using stsc + chunk offsets.
  // stsc entries are 1-based; entry k applies to chunk N when k.firstChunk <= N+1.
  const sampleOffsets = new Array<number>(sampleCount).fill(0);
  let sIdx = 0;
  let entryIdx = 0;
  for (let chunkIdx = 0; chunkIdx < chunkOffsets.length && sIdx < sampleCount; chunkIdx++) {
    while (entryIdx + 1 < stscEntries.length && stscEntries[entryIdx + 1]!.firstChunk <= chunkIdx + 1) entryIdx++;
    const samplesInChunk = stscEntries[entryIdx]!.samplesPerChunk;
    let off = chunkOffsets[chunkIdx]!;
    for (let s = 0; s < samplesInChunk && sIdx < sampleCount; s++) {
      sampleOffsets[sIdx] = off;
      off += sampleSizes[sIdx]!;
      sIdx++;
    }
  }

  // Group samples whose byte ranges are within 64 KB into one batched fetch.
  // Chapter samples are tiny (~50–200 bytes) so this collapses 87 sequential
  // fetches into 5–10 even on heavily interleaved files.
  type Group = { start: number; end: number; samples: number[] };
  const order = sampleOffsets.map((_, i) => i).sort((a, b) => sampleOffsets[a]! - sampleOffsets[b]!);
  const groups: Group[] = [];
  const GAP = 64 * 1024;
  for (const i of order) {
    const oStart = sampleOffsets[i]!;
    const oEnd = oStart + sampleSizes[i]!;
    const last = groups[groups.length - 1];
    if (last && oStart - last.end <= GAP) {
      last.end = Math.max(last.end, oEnd);
      last.samples.push(i);
    } else {
      groups.push({ start: oStart, end: oEnd, samples: [i] });
    }
  }
  if (!groups.length) return [];
  // Soft cap on total transfer (chapter samples shouldn't exceed a few MB).
  const totalBytes = groups.reduce((s, g) => s + (g.end - g.start), 0);
  if (totalBytes > 4 * 1024 * 1024) return [];

  // Fetch each group concurrently.
  const sampleBytes = new Array<Uint8Array | null>(sampleCount).fill(null);
  await Promise.all(groups.map(async (g) => {
    const { bytes } = await rangeFetch(url, g.start, g.end - 1);
    for (const i of g.samples) {
      const local = sampleOffsets[i]! - g.start;
      sampleBytes[i] = bytes.slice(local, local + sampleSizes[i]!);
    }
  }));

  const dec = new TextDecoder('utf-8');
  const out: Array<{ start: number; title: string }> = [];
  let cum = 0;
  for (let i = 0; i < sampleCount; i++) {
    const start = cum / timescale;
    cum += sampleDurations[i] ?? 0;
    const buf = sampleBytes[i];
    if (!buf || buf.length < 2) continue;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const textLen = view.getUint16(0);
    if (textLen === 0 || textLen + 2 > buf.length) continue;
    const title = dec.decode(buf.slice(2, 2 + textLen));
    out.push({ start, title });
  }
  return out;
}

export type ProbeResult = {
  durationSeconds: number | null;
  timeScale: number | null;
  tags: Record<string, string>;
  cover: { bytes: Uint8Array; mimeType: string } | null;
  // Chapter list parsed from the Nero `chpl` atom under moov/udta. Empty when
  // the file has no chpl (some m4b's use only a QT chapter track instead —
  // that's a future addition).
  chapters: Array<{ start: number; title: string }>;
  // Absolute byte offset + total size (header + payload) of the moov atom
  // in the source file. Used by the streaming route to cache moov bytes in
  // R2 for fast iOS seek-to-moov responses.
  moovOffset: number;
  moovSize: number;
};

export async function probeM4b(url: string): Promise<ProbeResult> {
  const { moov, moovOffset, moovSize } = await fetchMoov(url);

  // mvhd → duration / timescale
  const mvhd = findChild(moov, 'mvhd');
  let durationSeconds: number | null = null;
  let timeScale: number | null = null;
  if (mvhd && mvhd.length >= 32) {
    const v = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);
    const version = v.getUint8(0);
    if (version === 1 && mvhd.length >= 32) {
      // version 1: 4 (flags+ver) + 8 (created) + 8 (modified) + 4 (timescale) + 8 (duration)
      timeScale = v.getUint32(20);
      const dHi = v.getUint32(24);
      const dLo = v.getUint32(28);
      durationSeconds = (dHi * 0x1_0000_0000 + dLo) / timeScale;
    } else {
      // version 0: 4 + 4 (created) + 4 (modified) + 4 (timescale) + 4 (duration)
      timeScale = v.getUint32(12);
      const d = v.getUint32(16);
      durationSeconds = d / timeScale;
    }
  }

  // udta/meta/ilst → iTunes-style metadata bag.
  // The `meta` atom has a 4-byte version/flags prefix before its children.
  const udta = findChild(moov, 'udta');
  let ilst: Uint8Array | null = null;
  if (udta) {
    const meta = findChild(udta, 'meta');
    if (meta && meta.length > 4) ilst = findChild(meta.slice(4), 'ilst');
  }

  const tags: Record<string, string> = {};
  let cover: ProbeResult['cover'] = null;
  if (ilst) {
    for (const c of walkChildren(ilst)) {
      const tagPayload = ilst.slice(c.start + c.headerSize, c.start + c.size);
      const data = findChild(tagPayload, 'data');
      if (!data || data.length < 8) continue;
      // "----" custom tags are mean/name/data trios; key them as
      // "----:<mean>:<name>" (e.g. ----:com.apple.iTunes:SERIES), which is
      // how ABS and mp3tag store series info. mean/name carry a 4-byte
      // version/flags prefix before the string.
      let key = c.type;
      if (c.type === '----') {
        const mean = findChild(tagPayload, 'mean');
        const name = findChild(tagPayload, 'name');
        if (!mean || !name) continue;
        const td = new TextDecoder('utf-8');
        key = `----:${td.decode(mean.slice(4))}:${td.decode(name.slice(4))}`;
      }
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const dataType = dv.getUint32(0) & 0x00ffffff; // low 24 bits = wellKnownType
      const value = data.slice(8);                   // skip type + locale
      if (c.type === 'covr') {
        // covr dataType 13 = JPEG, 14 = PNG.
        const mime = dataType === 14 ? 'image/png' : 'image/jpeg';
        cover = { bytes: value, mimeType: mime };
        continue;
      }
      // Most tag types are UTF-8 text (dataType 1).
      if (dataType === 1) {
        tags[key] = new TextDecoder('utf-8').decode(value);
      } else if (dataType === 21 || dataType === 0) {
        // Big-endian signed int — 4 bytes (gnre, tves) or 2 bytes (©mvi,
        // tvsn as some taggers write them). dataType 0 ("implicit") is what
        // older taggers use for ints.
        const dv2 = new DataView(value.buffer, value.byteOffset, value.byteLength);
        if (value.length === 4) tags[key] = String(dv2.getInt32(0));
        else if (value.length === 2) tags[key] = String(dv2.getInt16(0));
        else if (value.length === 1) tags[key] = String(dv2.getInt8(0));
      }
    }
  }

  // Prefer chpl (single-atom, no extra fetches). Fall back to a QT chapter
  // track when the file ships only that — common for Audible/AAX-converted
  // m4bs that came in via certain rippers.
  let chapters = udta ? parseChpl(udta) : [];
  if (!chapters.length) {
    try {
      chapters = await parseQtChapters(moov, url);
    } catch {
      // Non-fatal: just leave chapters empty.
    }
  }

  return { durationSeconds, timeScale, tags, cover, chapters, moovOffset, moovSize };
}
