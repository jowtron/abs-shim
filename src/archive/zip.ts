// Minimal zip central-directory reader over a random-access byte source.
//
// Why hand-rolled: pCloud's extractarchive API returns 3006 for every archive
// (tested 2026-08-22 — zip and rar, inside and outside Public Folder, on a
// premium account), so archives fetched into pCloud have to be unpacked by
// us. We never hold the archive in memory: the directory is read from the
// tail via Range requests, and each entry's compressed bytes are streamed
// through DecompressionStream('deflate-raw') straight into pCloud's upload
// API (see src/do/archive-extract.ts). Only stored (0) and deflate (8) are
// supported — that covers everything zip tools produce by default.
//
// Spec reference: PKWARE APPNOTE 4.4.x. Zip64 is handled for the two places
// it matters for big audiobook archives: the EOCD (directory offset past
// 4 GiB) and per-entry sizes/offsets via the 0x0001 extra field.

export type ZipEntry = {
  name: string;
  method: number;          // 0 = stored, 8 = deflate
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
  isDir: boolean;
};

// Fetch bytes [start, end) — end exclusive. Must return exactly that range.
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function u16(b: Uint8Array, o: number): number { return b[o]! | (b[o + 1]! << 8); }
function u32(b: Uint8Array, o: number): number { return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000; }
function u64(b: Uint8Array, o: number): number {
  const lo = u32(b, o);
  const hi = u32(b, o + 4);
  if (hi > 0x1fffff) throw new Error('zip: 64-bit value exceeds JS safe integer');
  return hi * 0x100000000 + lo;
}

const utf8 = new TextDecoder('utf-8');

export async function readZipDirectory(read: RangeReader, totalSize: number): Promise<ZipEntry[]> {
  // EOCD is 22 bytes + a comment of up to 65535; scan the tail for the signature.
  const tailLen = Math.min(totalSize, 22 + 65535 + 20);
  const tailStart = totalSize - tailLen;
  const tail = await read(tailStart, totalSize);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found (not a zip, or truncated)');

  let cdOffset = u32(tail, eocd + 16);
  let cdSize = u32(tail, eocd + 12);
  let cdCount = u16(tail, eocd + 10);

  // Zip64: the locator sits immediately before the EOCD.
  const needs64 = cdOffset === 0xffffffff || cdSize === 0xffffffff || cdCount === 0xffff;
  if (needs64) {
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== SIG_EOCD64_LOCATOR) throw new Error('zip: zip64 locator missing');
    const eocd64Offset = u64(tail, loc + 8);
    const rec = await read(eocd64Offset, eocd64Offset + 56);
    if (u32(rec, 0) !== SIG_EOCD64) throw new Error('zip: bad zip64 EOCD record');
    cdCount = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }

  const cd = await read(cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < cdCount && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== SIG_CENTRAL) throw new Error(`zip: bad central directory entry at ${p}`);
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let compressedSize = u32(cd, p + 20);
    let uncompressedSize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let localHeaderOffset = u32(cd, p + 42);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));

    // Zip64 extra field: only the fields that were 0xFFFFFFFF are present, in
    // this fixed order.
    let q = p + 46 + nameLen;
    const extraEnd = q + extraLen;
    while (q + 4 <= extraEnd) {
      const id = u16(cd, q);
      const len = u16(cd, q + 2);
      if (id === 0x0001) {
        let r = q + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = u64(cd, r); r += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(cd, r); r += 8; }
        if (localHeaderOffset === 0xffffffff) { localHeaderOffset = u64(cd, r); r += 8; }
      }
      q += 4 + len;
    }

    entries.push({
      name, method, compressedSize, uncompressedSize, localHeaderOffset,
      encrypted: (flags & 0x0001) !== 0,
      isDir: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// The local header repeats name/extra with possibly different lengths, so the
// data offset can't be derived from the central directory alone.
export async function zipEntryDataOffset(read: RangeReader, entry: ZipEntry): Promise<number> {
  const h = await read(entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (u32(h, 0) !== SIG_LOCAL) throw new Error(`zip: bad local header for ${entry.name}`);
  const nameLen = u16(h, 26);
  const extraLen = u16(h, 28);
  return entry.localHeaderOffset + 30 + nameLen + extraLen;
}

// Wrap an entry's raw compressed byte stream into its decompressed form.
export function inflateZipEntry(entry: ZipEntry, raw: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipeThrough(new DecompressionStream('deflate-raw'));
  throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
}
