// Ogg prober for Opus (and Vorbis) audiobooks: duration, tags, chapters,
// cover — via two Range requests, no decoder. Companion to m4b.ts/mp3.ts.
//
// Layout: Ogg pages ("OggS" + 27-byte header + segment table) carry the
// packets of a logical stream. Packet 1 is the codec header (OpusHead /
// "\x01vorbis"), packet 2 the VorbisComment block (OpusTags / "\x03vorbis")
// with KEY=value strings — that's where title/author, the de-facto
// CHAPTERnnn / CHAPTERnnnNAME chapter convention, and the cover
// (METADATA_BLOCK_PICTURE, a base64 FLAC picture block) live.
//
// Duration gotchas (see memory/reference_opus_ogg_probing): the Opus
// granule position is ALWAYS in 48 kHz units regardless of the input rate
// stored in OpusHead, and pre-skip (OpusHead bytes 10–11) must be
// subtracted from the final granulepos. Vorbis granules are in the
// stream's own sample rate.

export type OggProbe = {
  codec: 'opus' | 'vorbis';
  durationSeconds: number | null;
  sampleRate: number | null;
  channels: number | null;
  tags: Record<string, string>;   // upper-cased keys, first value wins (except chapters, handled separately)
  chapters: Array<{ start: number; title: string }>;
  cover: { bytes: Uint8Array; mimeType: string } | null;
  sizeBytes: number | null;
};

const HEAD_BYTES = 256 * 1024;      // enough for OpusHead + OpusTags with a typical embedded cover
const HEAD_MAX_BYTES = 4 * 1024 * 1024; // give up growing the head read past this
const TAIL_BYTES = 64 * 1024;

const OGGS = 0x5367674f; // "OggS" little-endian u32

async function rangeGet(url: string, start: number, end?: number): Promise<{ bytes: Uint8Array; total: number | null; status: number }> {
  const res = await fetch(url, { headers: { Range: end == null ? `bytes=${start}` : `bytes=${start}-${end}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`Range fetch failed: HTTP ${res.status}`);
  const cr = res.headers.get('Content-Range');
  const total = cr ? Number(/\/(\d+)$/.exec(cr)?.[1]) : Number(res.headers.get('Content-Length'));
  return { bytes: new Uint8Array(await res.arrayBuffer()), total: Number.isFinite(total) ? total : null, status: res.status };
}

type Page = { offset: number; headerLen: number; bodyLen: number; granule: bigint; serial: number; segments: number[]; continued: boolean };

function readPage(buf: Uint8Array, off: number): Page | null {
  if (off + 27 > buf.length) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(off, true) !== OGGS) return null;
  const headerType = buf[off + 5]!;
  const granule = dv.getBigInt64(off + 6, true);
  const serial = dv.getUint32(off + 14, true);
  const nseg = buf[off + 26]!;
  if (off + 27 + nseg > buf.length) return null;
  const segments: number[] = [];
  let bodyLen = 0;
  for (let i = 0; i < nseg; i++) { const s = buf[off + 27 + i]!; segments.push(s); bodyLen += s; }
  return { offset: off, headerLen: 27 + nseg, bodyLen, granule, serial, segments, continued: (headerType & 1) === 1 };
}

// First two packets of the first logical stream, reassembled across pages.
// Returns null when the buffer ends before packet 2 is complete.
function firstPackets(buf: Uint8Array): { packets: Uint8Array[]; serial: number } | null {
  let off = 0;
  let serial: number | null = null;
  const packets: Uint8Array[] = [];
  let cur: Uint8Array[] = [];
  while (packets.length < 2) {
    const page = readPage(buf, off);
    if (!page) return null;
    if (serial == null) serial = page.serial;
    if (page.serial === serial) {
      let p = off + page.headerLen;
      if (p + page.bodyLen > buf.length) return null;
      for (const seg of page.segments) {
        cur.push(buf.subarray(p, p + seg));
        p += seg;
        if (seg < 255) {
          const len = cur.reduce((n, c) => n + c.length, 0);
          const pk = new Uint8Array(len);
          let q = 0;
          for (const c of cur) { pk.set(c, q); q += c.length; }
          packets.push(pk);
          cur = [];
          if (packets.length === 2) break;
        }
      }
    }
    off += page.headerLen + page.bodyLen;
  }
  return serial == null ? null : { packets, serial };
}

const ascii = (b: Uint8Array, start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));
const utf8 = new TextDecoder();

// VorbisComment: vendor_len u32 LE, vendor, count u32 LE, count × (len u32 LE, "KEY=value").
function parseComments(b: Uint8Array, off: number): Array<[string, string]> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Array<[string, string]> = [];
  if (off + 4 > b.length) return out;
  const vendorLen = dv.getUint32(off, true);
  off += 4 + vendorLen;
  if (off + 4 > b.length) return out;
  const count = dv.getUint32(off, true);
  off += 4;
  for (let i = 0; i < count && off + 4 <= b.length; i++) {
    const len = dv.getUint32(off, true);
    off += 4;
    if (off + len > b.length) break;
    const s = utf8.decode(b.subarray(off, off + len));
    off += len;
    const eq = s.indexOf('=');
    if (eq > 0) out.push([s.slice(0, eq).toUpperCase(), s.slice(eq + 1)]);
  }
  return out;
}

// "hh:mm:ss.sss" (hours may exceed 2 digits) → seconds.
function parseChapterTime(s: string): number | null {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// FLAC picture block: type u32, mime_len u32, mime, desc_len u32, desc,
// width, height, depth, colors (u32 each), data_len u32, data. All big-endian.
function parsePictureBlock(b: Uint8Array): { bytes: Uint8Array; mimeType: string } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 4;
  if (b.length < 32) return null;
  const mimeLen = dv.getUint32(off); off += 4;
  const mime = ascii(b, off, mimeLen); off += mimeLen;
  const descLen = dv.getUint32(off); off += 4 + descLen;
  off += 16;
  if (off + 4 > b.length) return null;
  const dataLen = dv.getUint32(off); off += 4;
  if (off + dataLen > b.length) return null;
  return { bytes: b.slice(off, off + dataLen), mimeType: mime || 'image/jpeg' };
}

export async function probeOgg(url: string): Promise<OggProbe> {
  // Head: grow until the comment packet is complete (a big embedded cover
  // can push OpusTags well past the first 256 KB).
  let headLen = HEAD_BYTES;
  let head = await rangeGet(url, 0, headLen - 1);
  let first = firstPackets(head.bytes);
  while (!first && headLen < HEAD_MAX_BYTES && (head.total == null || headLen < head.total)) {
    headLen *= 4;
    head = await rangeGet(url, 0, headLen - 1);
    first = firstPackets(head.bytes);
  }
  if (!first) throw new Error('Not an Ogg stream (no codec header / comment packets found)');
  const [p1, p2] = first.packets as [Uint8Array, Uint8Array];
  const dv1 = new DataView(p1.buffer, p1.byteOffset, p1.byteLength);

  let codec: 'opus' | 'vorbis';
  let preSkip = 0;
  let sampleRate: number | null = null;
  let channels: number | null = null;
  let comments: Array<[string, string]>;
  if (p1.length >= 19 && ascii(p1, 0, 8) === 'OpusHead') {
    codec = 'opus';
    channels = p1[9]!;
    preSkip = dv1.getUint16(10, true);
    sampleRate = dv1.getUint32(12, true) || 48000;
    if (ascii(p2, 0, 8) !== 'OpusTags') throw new Error('Opus stream without OpusTags');
    comments = parseComments(p2, 8);
  } else if (p1.length >= 30 && p1[0] === 1 && ascii(p1, 1, 6) === 'vorbis') {
    codec = 'vorbis';
    channels = p1[11]!;
    sampleRate = dv1.getUint32(12, true);
    if (!(p2[0] === 3 && ascii(p2, 1, 6) === 'vorbis')) throw new Error('Vorbis stream without comment header');
    comments = parseComments(p2, 7);
  } else {
    throw new Error('Ogg stream is neither Opus nor Vorbis');
  }

  const tags: Record<string, string> = {};
  const chapterStarts = new Map<number, number>();
  const chapterNames = new Map<number, string>();
  let cover: OggProbe['cover'] = null;
  for (const [k, v] of comments) {
    const ch = /^CHAPTER(\d{1,3})(NAME)?$/.exec(k);
    if (ch) {
      const idx = Number(ch[1]);
      if (ch[2]) chapterNames.set(idx, v);
      else { const t = parseChapterTime(v); if (t != null) chapterStarts.set(idx, t); }
      continue;
    }
    if (k === 'METADATA_BLOCK_PICTURE') {
      if (!cover) { try { cover = parsePictureBlock(base64ToBytes(v)); } catch { /* malformed picture — ignore */ } }
      continue;
    }
    if (!(k in tags)) tags[k] = v;
  }
  const chapters = [...chapterStarts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, start]) => ({ start, title: chapterNames.get(idx) ?? `Chapter ${idx}` }));

  // Tail: last page's granule position → duration.
  let durationSeconds: number | null = null;
  const total = head.total;
  if (total && total > 0) {
    const start = Math.max(0, total - TAIL_BYTES);
    const tail = await rangeGet(url, start, total - 1);
    const tb = tail.bytes;
    const dv = new DataView(tb.buffer, tb.byteOffset, tb.byteLength);
    // Scan backward for the last page header of our stream with a real granule.
    for (let off = tb.length - 27; off >= 0; off--) {
      if (dv.getUint32(off, true) !== OGGS) continue;
      const page = readPage(tb, off);
      if (!page || page.serial !== first.serial) continue;
      if (page.granule < 0n) continue;
      const g = Number(page.granule);
      durationSeconds = codec === 'opus'
        ? Math.max(0, (g - preSkip) / 48000)
        : (sampleRate ? g / sampleRate : null);
      break;
    }
  }

  return { codec, durationSeconds, sampleRate, channels, tags, chapters, cover, sizeBytes: total };
}
