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
  const buf = new Uint8Array(await res.arrayBuffer());
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

// Locate the moov box by walking top-level boxes. Returns the moov bytes
// (a Uint8Array containing only the moov atom payload, header stripped).
export async function fetchMoov(url: string): Promise<{ moov: Uint8Array; headerType: string }> {
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
      return { moov: await readBoxFully(url, prefix, box), headerType: 'moov' };
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
          return { moov: await readBoxFully(url, hdr, next, nextStart), headerType: 'moov' };
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
      // If the moov fits within tail bytes, slice it; otherwise fetch.
      const localStart = i + probe.headerSize;
      const localEnd = i + probe.size;
      if (localEnd <= tail.length) {
        return { moov: tail.slice(localStart, localEnd), headerType: 'moov' };
      }
      return { moov: await readBoxFully(url, tail, probe, viewStart), headerType: 'moov' };
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

export type ProbeResult = {
  durationSeconds: number | null;
  timeScale: number | null;
  tags: Record<string, string>;
  cover: { bytes: Uint8Array; mimeType: string } | null;
};

export async function probeM4b(url: string): Promise<ProbeResult> {
  const { moov } = await fetchMoov(url);

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
        tags[c.type] = new TextDecoder('utf-8').decode(value);
      } else if (dataType === 21 && value.length === 4) {
        // Big-endian signed int (e.g. genre id, gnre).
        const dv2 = new DataView(value.buffer, value.byteOffset, value.byteLength);
        tags[c.type] = String(dv2.getInt32(0));
      }
    }
    // ABS-style "----" custom tags live as "----/mean/name/data" trios. Skipped
    // here; we can revisit if a client needs them.
  }

  return { durationSeconds, timeScale, tags, cover };
}
