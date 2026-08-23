// Pure-JS MP3 prober. Reads enough bytes via HTTP Range to extract ID3v2 tags
// (TIT2/TPE1/TALB/TYER/TDRC/TXXX/APIC/TCOM), the first MPEG frame, and either
// the Xing/Info/VBRI VBR header (preferred — gives exact duration) or fall
// back to first-frame bitrate * (file_size - id3_size) / bitrate for CBR.
//
// No FFmpeg, no Node stdlib — DataView and TextDecoder only. Mirrors the style
// of src/prober/m4b.ts so the two probers feel consistent.
//
// MP3 file layout:
//   [ID3v2 tag, optional, variable size]
//   [MPEG frame 0] [MPEG frame 1] ...
//   [ID3v1 tag, optional, exactly 128 bytes at EOF]
//
// ID3v2 header (10 bytes):
//   "ID3" version[2] flags[1] size[4 synchsafe — top bit of each byte is 0]
//   `size` excludes the 10-byte header itself.
//
// ID3v2 frame v2.3/v2.4:
//   id[4 ASCII] size[4] flags[2] data[size]   (v2.3 size is plain u32 BE;
//                                              v2.4 size is synchsafe)
// ID3v2 frame v2.2:
//   id[3 ASCII] size[3 plain u24 BE] data[size]
//
// MPEG audio frame header (4 bytes):
//   0xFF, sync[3 bits]+ver[2]+layer[2]+CRC[1], bitrate[4]+sr[2]+pad[1]+priv[1],
//   chmode[2]+modeext[2]+copyright+original+emphasis[2]
//
// Xing/Info header sits in the first MPEG frame at offset 4 + side-info length:
//   MPEG1 stereo: 36   MPEG1 mono: 21
//   MPEG2/.5 stereo: 21   MPEG2/.5 mono: 13
// VBRI is at a fixed offset of 36 from frame start, regardless of channel mode.

const PREFIX_BYTES = 256 * 1024;
const MAX_ID3V2_BYTES = 4 * 1024 * 1024;

const TD_LATIN1 = new TextDecoder('latin1');
const TD_UTF8 = new TextDecoder('utf-8');
const TD_UTF16_LE = new TextDecoder('utf-16le');
const TD_UTF16_BE = new TextDecoder('utf-16be');

export type Mp3Probe = {
  durationSeconds: number | null;
  bitrate: number | null;     // bps; first-frame bitrate even for VBR (informational)
  sampleRate: number | null;
  channels: number | null;
  tags: Record<string, string>;
  cover: { bytes: Uint8Array; mimeType: string } | null;
  // ID3v2 CHAP frames (v2.3/v2.4), seconds relative to this file, sorted by
  // start. Empty when the file has none — single-file mp3 audiobooks from
  // Audible/Libro.fm/ABB rips almost always carry them; folder-of-files
  // books usually don't (each file is the chapter).
  chapters: Array<{ start: number; end: number; title: string }>;
};

export async function probeMp3(url: string, fileSize?: number): Promise<Mp3Probe> {
  let { bytes, totalSize } = await rangeFetch(url, 0, PREFIX_BYTES - 1);
  const realFileSize = fileSize ?? totalSize ?? bytes.length;

  // If the ID3v2 tag is bigger than our prefix, extend the fetch so the parser
  // sees the whole tag AND a few KB past it (the first MPEG frame + Xing).
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const id3End = 10 + synchsafe(bytes, 6);
    if (id3End > MAX_ID3V2_BYTES) throw new Error('ID3v2 tag implausibly large');
    const needed = id3End + 4096;
    if (needed > bytes.length && bytes.length < realFileSize) {
      const more = await rangeFetch(url, bytes.length, Math.min(needed, realFileSize) - 1);
      const merged = new Uint8Array(bytes.length + more.bytes.length);
      merged.set(bytes, 0);
      merged.set(more.bytes, bytes.length);
      bytes = merged;
    }
  }

  return parseMp3(bytes, realFileSize);
}

// Pure parser — `bytes` is the head of the file, covering the ID3v2 tag and
// the first MPEG frame. Exposed for unit testing.
export function parseMp3(bytes: Uint8Array, fileSize: number): Mp3Probe {
  const result: Mp3Probe = {
    durationSeconds: null,
    bitrate: null,
    sampleRate: null,
    channels: null,
    tags: {},
    cover: null,
    chapters: [],
  };

  let id3End = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const majorVer = bytes[3] ?? 0;
    const flags = bytes[5] ?? 0;
    const tagBodySize = synchsafe(bytes, 6);
    id3End = 10 + tagBodySize;
    let frameStart = 10;
    if (flags & 0x40) {
      // Extended header. v2.3: 4-byte plain u32 size, NOT counting itself.
      // v2.4: 4-byte synchsafe size, INCLUDING itself.
      if (frameStart + 4 <= bytes.length) {
        if (majorVer === 4) {
          frameStart += synchsafe(bytes, frameStart);
        } else {
          const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          frameStart += 4 + v.getUint32(frameStart);
        }
      }
    }
    parseId3v2Frames(bytes, frameStart, Math.min(id3End, bytes.length), majorVer, result);
  }

  const frameOff = findMpegFrame(bytes, id3End);
  if (frameOff < 0) return result;

  const hdr = parseMpegHeader(bytes, frameOff);
  if (!hdr) return result;

  result.bitrate = hdr.bitrate;
  result.sampleRate = hdr.sampleRate;
  result.channels = hdr.channels;

  const xingDuration = parseXing(bytes, frameOff, hdr);
  if (xingDuration !== null) {
    result.durationSeconds = xingDuration;
  } else {
    const vbri = parseVbri(bytes, frameOff, hdr);
    if (vbri !== null) {
      result.durationSeconds = vbri;
    } else if (hdr.bitrate > 0) {
      // CBR estimate. Subtract ID3v2 head; ID3v1 tail (128 bytes if present)
      // we can't detect without reading EOF — error ≤ 0.4s on any normal
      // audiobook, not worth a second range fetch.
      const audioBytes = Math.max(0, fileSize - id3End);
      result.durationSeconds = (audioBytes * 8) / hdr.bitrate;
    }
  }

  // CHAP frames may appear in any order; drop zero-length and duplicate
  // starts (some taggers emit a final 0-length marker chapter).
  result.chapters = result.chapters
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start)
    .filter((c, i, arr) => i === 0 || c.start > arr[i - 1]!.start);
  return result;
}

// ─── ID3v2 ────────────────────────────────────────────────────────────────────

export function synchsafe(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) & 0x7f) << 21
    | (((bytes[offset + 1] ?? 0) & 0x7f) << 14)
    | (((bytes[offset + 2] ?? 0) & 0x7f) << 7)
    | ((bytes[offset + 3] ?? 0) & 0x7f);
}

function parseId3v2Frames(
  bytes: Uint8Array, start: number, end: number, majorVer: number, out: Mp3Probe,
): void {
  const v22 = majorVer === 2;
  const idLen = v22 ? 3 : 4;
  const sizeLen = v22 ? 3 : 4;
  const flagsLen = v22 ? 0 : 2;
  const headerLen = idLen + sizeLen + flagsLen;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let cursor = start;
  while (cursor + headerLen <= end) {
    // Padding starts when the frame id begins with a zero byte.
    if (bytes[cursor] === 0) break;
    const id = TD_LATIN1.decode(bytes.subarray(cursor, cursor + idLen));
    let size: number;
    if (v22) {
      size = ((bytes[cursor + 3] ?? 0) << 16)
        | ((bytes[cursor + 4] ?? 0) << 8)
        | (bytes[cursor + 5] ?? 0);
    } else if (majorVer === 4) {
      size = synchsafe(bytes, cursor + 4);
    } else {
      size = view.getUint32(cursor + 4);
    }
    const dataStart = cursor + headerLen;
    const dataEnd = dataStart + size;
    if (size <= 0 || dataEnd > end) break;
    let data = bytes.subarray(dataStart, dataEnd);
    const canonical = v22 ? mapV22Id(id) : id;
    // Frame format flags (byte 2 of the flags). v2.3: compression 0x80 /
    // encryption 0x40 — can't decode, skip. v2.4: data-length-indicator
    // 0x01 prefixes 4 bytes; unsynchronisation 0x02 means FF 00 → FF.
    const fmtFlags = v22 ? 0 : (bytes[cursor + idLen + sizeLen + 1] ?? 0);
    if (majorVer === 3 && (fmtFlags & 0xC0)) { cursor = dataEnd; continue; }
    if (majorVer === 4) {
      if (fmtFlags & 0x01) data = data.subarray(4);
      if (fmtFlags & 0x02) data = deUnsync(data);
    }

    if (canonical === 'CHAP' && !v22) {
      const ch = decodeChapFrame(data, majorVer);
      if (ch) out.chapters.push(ch);
    } else if (canonical && canonical !== 'TXXX' && canonical.startsWith('T')) {
      const text = decodeTextFrame(data);
      if (text) out.tags[canonical] = text;
    } else if (canonical === 'TXXX') {
      const pair = decodeTxxxFrame(data);
      if (pair) out.tags[`TXXX:${pair.description.toUpperCase()}`] = pair.value;
    } else if (canonical === 'APIC' || canonical === 'PIC') {
      const cov = decodeApicFrame(data, canonical === 'PIC');
      if (cov) out.cover = cov;
    }

    cursor = dataEnd;
  }
}

function deUnsync(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    out[n++] = data[i]!;
    if (data[i] === 0xFF && data[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

// CHAP (ID3v2.3/2.4 chapter addendum):
//   element id (latin1, NUL-terminated) | start ms u32 | end ms u32 |
//   start byte u32 | end byte u32 | embedded sub-frames (TIT2 = title)
// Byte offsets are usually 0xFFFFFFFF ("not set") and ignored here.
function decodeChapFrame(
  data: Uint8Array, majorVer: number,
): { start: number; end: number; title: string } | null {
  const nul = data.indexOf(0);
  if (nul < 0 || nul + 17 > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const startMs = view.getUint32(nul + 1);
  const endMs = view.getUint32(nul + 5);
  const sub: Mp3Probe = { durationSeconds: null, bitrate: null, sampleRate: null, channels: null, tags: {}, cover: null, chapters: [] };
  parseId3v2Frames(data, nul + 17, data.length, majorVer, sub);
  const elementId = TD_LATIN1.decode(data.subarray(0, nul));
  return {
    start: startMs / 1000,
    end: endMs / 1000,
    title: sub.tags['TIT2'] ?? elementId,
  };
}

// Map the v2.2 3-char frame ids we care about to their v2.3+ canonical forms.
function mapV22Id(id: string): string | null {
  switch (id) {
    case 'TT2': return 'TIT2';
    case 'TP1': return 'TPE1';
    case 'TAL': return 'TALB';
    case 'TYE': return 'TYER';
    case 'TCM': return 'TCOM';
    case 'TXX': return 'TXXX';
    case 'PIC': return 'PIC';
    default:    return null;
  }
}

function decodeTextFrame(data: Uint8Array): string {
  if (data.length < 1) return '';
  const encoding = data[0] ?? 0;
  const text = decodeId3Text(data.subarray(1), encoding);
  // v2.4 allows multiple null-separated values per text frame; first wins.
  return text.split('\x00')[0] ?? '';
}

function decodeTxxxFrame(data: Uint8Array): { description: string; value: string } | null {
  if (data.length < 1) return null;
  const encoding = data[0] ?? 0;
  const body = data.subarray(1);
  const split = findTextNull(body, encoding);
  if (split < 0) return null;
  const description = decodeId3Text(body.subarray(0, split), encoding);
  const valueStart = split + (encoding === 1 || encoding === 2 ? 2 : 1);
  const value = decodeId3Text(body.subarray(valueStart), encoding).split('\x00')[0] ?? '';
  return { description, value };
}

function decodeApicFrame(data: Uint8Array, v22: boolean): { bytes: Uint8Array; mimeType: string } | null {
  if (data.length < 2) return null;
  const encoding = data[0] ?? 0;
  let mime: string;
  let cursor: number;
  if (v22) {
    // image format = 3 ASCII bytes ("JPG"/"PNG"/...)
    const fmt = TD_LATIN1.decode(data.subarray(1, 4)).toUpperCase();
    mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
    cursor = 4;
  } else {
    const end = data.indexOf(0, 1);
    if (end < 0) return null;
    mime = TD_LATIN1.decode(data.subarray(1, end));
    cursor = end + 1;
  }
  cursor += 1; // picture type byte
  if (cursor >= data.length) return null;
  const descSplit = findTextNull(data.subarray(cursor), encoding);
  if (descSplit < 0) return null;
  cursor += descSplit + (encoding === 1 || encoding === 2 ? 2 : 1);
  if (cursor >= data.length) return null;
  return { bytes: data.subarray(cursor).slice(), mimeType: mime || 'image/jpeg' };
}

function findTextNull(bytes: Uint8Array, encoding: number): number {
  if (encoding === 1 || encoding === 2) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    }
    return -1;
  }
  return bytes.indexOf(0);
}

function decodeId3Text(body: Uint8Array, encoding: number): string {
  if (encoding === 3) return TD_UTF8.decode(body);
  if (encoding === 1) {
    if (body.length >= 2 && body[0] === 0xFF && body[1] === 0xFE) return TD_UTF16_LE.decode(body.subarray(2));
    if (body.length >= 2 && body[0] === 0xFE && body[1] === 0xFF) return TD_UTF16_BE.decode(body.subarray(2));
    return TD_UTF16_LE.decode(body);
  }
  if (encoding === 2) return TD_UTF16_BE.decode(body);
  return TD_LATIN1.decode(body);
}

// ─── MPEG frame ───────────────────────────────────────────────────────────────

type MpegHeader = {
  version: 1 | 2 | 2.5;
  layer: 1 | 2 | 3;
  bitrate: number;       // bps
  sampleRate: number;    // Hz
  channels: 1 | 2;
  samplesPerFrame: number;
  xingOffset: number;    // bytes from frame start
};

// Scan byte-by-byte for the first valid MPEG header at/after `start`. Some
// files have ID3v2 padding (zeros) or AlbumArt junk between the tag and the
// first frame, so we can't just assume id3End is frame-aligned.
function findMpegFrame(bytes: Uint8Array, start: number): number {
  for (let i = start; i + 4 <= bytes.length; i++) {
    if (bytes[i] !== 0xFF) continue;
    if (((bytes[i + 1] ?? 0) & 0xE0) !== 0xE0) continue;
    if (parseMpegHeader(bytes, i)) return i;
  }
  return -1;
}

function parseMpegHeader(bytes: Uint8Array, offset: number): MpegHeader | null {
  if (offset + 4 > bytes.length) return null;
  if (bytes[offset] !== 0xFF) return null;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  if ((b1 & 0xE0) !== 0xE0) return null;

  const versionBits = (b1 >> 3) & 0b11;
  const layerBits = (b1 >> 1) & 0b11;
  const bitrateIdx = (b2 >> 4) & 0x0F;
  const srIdx = (b2 >> 2) & 0b11;
  const channelMode = (b3 >> 6) & 0b11;

  if (versionBits === 1 || layerBits === 0) return null;       // reserved
  if (bitrateIdx === 0 || bitrateIdx === 15) return null;      // free / invalid
  if (srIdx === 3) return null;                                // reserved

  const version: 1 | 2 | 2.5 = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer: 1 | 2 | 3 = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;

  const brRow = BITRATE_TABLE[version === 1 ? 0 : 1]?.[layer - 1];
  const bitrateKbps = brRow?.[bitrateIdx];
  if (!bitrateKbps) return null;

  const sampleRate = SAMPLE_RATE_TABLE[version === 1 ? 0 : version === 2 ? 1 : 2]?.[srIdx];
  if (!sampleRate) return null;

  const channels: 1 | 2 = channelMode === 3 ? 1 : 2;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;

  const sideInfoLen = version === 1
    ? (channels === 2 ? 32 : 17)
    : (channels === 2 ? 17 : 9);

  return {
    version, layer,
    bitrate: bitrateKbps * 1000,
    sampleRate, channels, samplesPerFrame,
    xingOffset: 4 + sideInfoLen,
  };
}

// [MPEG1 [L1, L2, L3]], [MPEG2/2.5 [L1, L2, L3]] — bitrate in kbps, index 0
// is "free" and 15 is "bad"; both rejected upstream.
const BITRATE_TABLE: readonly (readonly (readonly number[])[])[] = [
  [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
];

const SAMPLE_RATE_TABLE: readonly (readonly number[])[] = [
  [44100, 48000, 32000],
  [22050, 24000, 16000],
  [11025, 12000, 8000],
];

// ─── Xing / Info / VBRI ───────────────────────────────────────────────────────

function parseXing(bytes: Uint8Array, frameOff: number, hdr: MpegHeader): number | null {
  const off = frameOff + hdr.xingOffset;
  if (off + 8 > bytes.length) return null;
  const magic = TD_LATIN1.decode(bytes.subarray(off, off + 4));
  if (magic !== 'Xing' && magic !== 'Info') return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = v.getUint32(off + 4);
  if (!(flags & 0x0001)) return null;
  if (off + 12 > bytes.length) return null;
  const frameCount = v.getUint32(off + 8);
  if (!frameCount) return null;
  return (frameCount * hdr.samplesPerFrame) / hdr.sampleRate;
}

function parseVbri(bytes: Uint8Array, frameOff: number, hdr: MpegHeader): number | null {
  const off = frameOff + 36;
  if (off + 32 > bytes.length) return null;
  const magic = TD_LATIN1.decode(bytes.subarray(off, off + 4));
  if (magic !== 'VBRI') return null;
  // VBRI: magic[4] version[2] delay[2] quality[2] bytes[4] frames[4] ...
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = v.getUint32(off + 14);
  if (!frames) return null;
  return (frames * hdr.samplesPerFrame) / hdr.sampleRate;
}

// ─── Range fetch ──────────────────────────────────────────────────────────────

async function rangeFetch(
  url: string, start: number, endInclusive: number,
): Promise<{ bytes: Uint8Array; totalSize: number | null }> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`Range fetch failed: ${res.status} ${res.statusText}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
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
