// Opus-in-WebM prober: duration, tags, chapters and cover from the EBML
// header region, in one or two Range reads.
//
// Why this container exists in the library at all: Ogg has no seek index, so
// WebKit finds a file's headers by walking Ogg pages forward from byte 0.
// Over the network that is ~40 sequential Range requests before playback can
// start — 17 s on a 254 MB book, and often a fatal MediaError 4 first
// (2026-09-07 crash log). The five Percy Jackson books were remuxed
// `-c:a copy` (the Opus packets are untouched; only the wrapper changed), the
// same fix the StoryTeller site landed on for the same reason.
//
// What actually wins is header LOCALITY, not the seek index: ffmpeg's matroska
// muxer writes SeekHead, Info, Tracks, Chapters and Tags in the first few KB,
// before the first Cluster, so one read answers everything. Do NOT expect a
// real Cues index — for an audio-only file ffmpeg writes a single CuePoint at
// t=0 (18 bytes for a 7,210-cluster book, verified 2026-09-07), so players
// still seek by byte estimation exactly as they did with Ogg. That was already
// working; startup was the broken part.

export type WebmProbe = {
  codec: 'opus' | 'vorbis' | 'unknown';
  durationSeconds: number | null;
  sampleRate: number | null;
  channels: number | null;
  tags: Record<string, string>;   // upper-cased keys, first value wins
  chapters: Array<{ start: number; title: string }>;
  cover: { bytes: Uint8Array; mimeType: string } | null;
  sizeBytes: number | null;
};

const HEAD_BYTES = 256 * 1024;
const HEAD_MAX_BYTES = 8 * 1024 * 1024; // a big embedded cover can push Attachments out past 256 KB

// EBML / Matroska element ids, as read by readVint(keepMarker=true).
const ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Tags: 0x1254c367,
  Tag: 0x7373,
  SimpleTag: 0x67c8,
  TagName: 0x45a3,
  TagString: 0x4487,
  Attachments: 0x1941a469,
  AttachedFile: 0x61a7,
  FileMimeType: 0x4660,
  FileData: 0x465c,
  Chapters: 0x1043a770,
  EditionEntry: 0x45b9,
  ChapterAtom: 0xb6,
  ChapterTimeStart: 0x91,
  ChapterDisplay: 0x80,
  ChapString: 0x85,
} as const;

async function rangeGet(
  url: string,
  start: number,
  end: number,
  headers?: Record<string, string>,
): Promise<{ bytes: Uint8Array; total: number | null }> {
  const res = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`Range fetch failed: HTTP ${res.status}`);
  const cr = res.headers.get('Content-Range');
  const total = cr ? Number(/\/(\d+)$/.exec(cr)?.[1]) : Number(res.headers.get('Content-Length'));
  return { bytes: new Uint8Array(await res.arrayBuffer()), total: Number.isFinite(total) ? total : null };
}

type Vint = { value: number; len: number; unknown: boolean };

// EBML variable-length integer. Element ids keep their length-marker bits
// (that is what makes 0xA3 and 0x1F43B675 distinct ids); sizes strip them.
function readVint(buf: Uint8Array, pos: number, keepMarker: boolean): Vint | null {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let mask = 0x80;
  let len = 1;
  while (!(first & mask)) {
    mask >>= 1;
    len++;
    if (len > 8) return null;
  }
  if (pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let unknown = keepMarker ? false : (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    const b = buf[pos + i]!;
    value = value * 256 + b;
    if (b !== 0xff) unknown = false;
  }
  return { value, len, unknown };
}

// Walk one master element's children in [start, end), calling cb(id, dataStart,
// dataEnd). Returning true from cb stops the walk.
function walk(
  buf: Uint8Array,
  start: number,
  end: number,
  cb: (id: number, dataStart: number, dataEnd: number) => boolean | void,
): void {
  let pos = start;
  while (pos < end) {
    const idv = readVint(buf, pos, true);
    if (!idv) return;
    const sizev = readVint(buf, pos + idv.len, false);
    if (!sizev) return;
    const dataStart = pos + idv.len + sizev.len;
    // An unknown-size element (all-ones size) runs to the end of what we have.
    // Only Segment and Cluster are written that way in practice.
    const dataEnd = sizev.unknown ? end : Math.min(dataStart + sizev.value, end);
    if (cb(idv.value, dataStart, dataEnd) === true) return;
    pos = sizev.unknown ? dataStart : dataStart + sizev.value;
    if (pos <= dataStart - 1) return; // malformed: no forward progress
  }
}

function readUint(buf: Uint8Array, start: number, end: number): number {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + buf[i]!;
  return v;
}

// Matroska floats are 4 or 8 bytes, big-endian.
function readFloat(buf: Uint8Array, start: number, end: number): number | null {
  const len = end - start;
  const dv = new DataView(buf.buffer, buf.byteOffset + start, len);
  if (len === 4) return dv.getFloat32(0, false);
  if (len === 8) return dv.getFloat64(0, false);
  return null;
}

function readString(buf: Uint8Array, start: number, end: number): string {
  // Trailing NULs are legal padding in an EBML string.
  let e = end;
  while (e > start && buf[e - 1] === 0) e--;
  return new TextDecoder().decode(buf.subarray(start, e));
}

export async function probeWebm(url: string, headers?: Record<string, string>): Promise<WebmProbe> {
  let headLen = HEAD_BYTES;
  let head = await rangeGet(url, 0, headLen - 1, headers);
  const sizeBytes = head.total;

  // Grow the head read if the elements we want sit past it. `parseHead`
  // reports whether it ran off the end of the buffer mid-Segment; a book with
  // a large embedded cover pushes Attachments well past 256 KB.
  let parsed = parseHead(head.bytes);
  while (parsed.truncated && headLen < HEAD_MAX_BYTES && (sizeBytes == null || headLen < sizeBytes)) {
    headLen = Math.min(headLen * 4, HEAD_MAX_BYTES);
    head = await rangeGet(url, 0, headLen - 1, headers);
    parsed = parseHead(head.bytes);
  }

  return { ...parsed.probe, sizeBytes };
}

function parseHead(buf: Uint8Array): { probe: Omit<WebmProbe, 'sizeBytes'>; truncated: boolean } {
  const tags: Record<string, string> = {};
  const chapters: Array<{ start: number; title: string }> = [];
  let codec: WebmProbe['codec'] = 'unknown';
  let durationSeconds: number | null = null;
  let sampleRate: number | null = null;
  let channels: number | null = null;
  let cover: { bytes: Uint8Array; mimeType: string } | null = null;
  let timecodeScale = 1_000_000; // ns per tick; Matroska's default
  let rawDuration: number | null = null;
  // True when we stopped because the buffer ran out rather than because we
  // reached the first Cluster — i.e. the caller should read more.
  let truncated = true;

  walk(buf, 0, buf.length, (id, s, e) => {
    if (id !== ID.Segment) return;
    walk(buf, s, e, (sid, ss, se) => {
      if (se > buf.length) return true; // element extends past what we read
      switch (sid) {
        case ID.Info:
          walk(buf, ss, se, (iid, is, ie) => {
            if (iid === ID.TimecodeScale) timecodeScale = readUint(buf, is, ie);
            else if (iid === ID.Duration) rawDuration = readFloat(buf, is, ie);
          });
          break;
        case ID.Tracks:
          walk(buf, ss, se, (tid, ts, te) => {
            if (tid !== ID.TrackEntry) return;
            walk(buf, ts, te, (eid, es, ee) => {
              if (eid === ID.CodecID) {
                const c = readString(buf, es, ee);
                if (c === 'A_OPUS') codec = 'opus';
                else if (c === 'A_VORBIS') codec = 'vorbis';
              } else if (eid === ID.CodecPrivate && ee - es >= 11) {
                // OpusHead: channels at byte 9, original sample rate at 12.
                if (readString(buf, es, es + 8) === 'OpusHead') {
                  channels = buf[es + 9]!;
                }
              } else if (eid === ID.Audio) {
                walk(buf, es, ee, (aid, as_, ae) => {
                  if (aid === ID.SamplingFrequency) sampleRate = readFloat(buf, as_, ae);
                  else if (aid === ID.Channels) channels = readUint(buf, as_, ae);
                });
              }
            });
          });
          break;
        case ID.Tags:
          walk(buf, ss, se, (tid, ts, te) => {
            if (tid !== ID.Tag) return;
            walk(buf, ts, te, (gid, gs, ge) => {
              if (gid !== ID.SimpleTag) return;
              // Held in an object because TypeScript narrows a `let` to its
              // initialiser and cannot see that the walk callback writes to it.
              const t: { name: string | null; value: string | null } = { name: null, value: null };
              walk(buf, gs, ge, (nid, ns, ne) => {
                if (nid === ID.TagName) t.name = readString(buf, ns, ne);
                else if (nid === ID.TagString) t.value = readString(buf, ns, ne);
              });
              // First value wins, matching the Ogg prober's convention.
              if (t.name && t.value && !(t.name.toUpperCase() in tags)) tags[t.name.toUpperCase()] = t.value;
            });
          });
          break;
        case ID.Chapters:
          walk(buf, ss, se, (cid, cs, ce) => {
            if (cid !== ID.EditionEntry) return;
            walk(buf, cs, ce, (aid, as_, ae) => {
              if (aid !== ID.ChapterAtom) return;
              let start: number | null = null;
              let title = '';
              walk(buf, as_, ae, (pid, ps, pe) => {
                if (pid === ID.ChapterTimeStart) start = readUint(buf, ps, pe) / 1e9; // always nanoseconds
                else if (pid === ID.ChapterDisplay) {
                  walk(buf, ps, pe, (did, ds, de) => {
                    if (did === ID.ChapString) title = readString(buf, ds, de);
                  });
                }
              });
              if (start != null) chapters.push({ start, title: title || `Chapter ${chapters.length + 1}` });
            });
          });
          break;
        case ID.Attachments:
          walk(buf, ss, se, (aid, as_, ae) => {
            if (aid !== ID.AttachedFile || cover) return;
            let mimeType: string | null = null;
            let bytes: Uint8Array | null = null;
            walk(buf, as_, ae, (fid, fs, fe) => {
              if (fid === ID.FileMimeType) mimeType = readString(buf, fs, fe);
              else if (fid === ID.FileData) bytes = buf.slice(fs, fe);
            });
            if (bytes && mimeType && /^image\//.test(mimeType)) cover = { bytes, mimeType };
          });
          break;
        default:
          // Clusters begin the audio body: everything we care about is behind
          // us, so this is a clean stop rather than a truncated read.
          if (sid === 0x1f43b675) {
            truncated = false;
            return true;
          }
      }
      return;
    });
    return true;
  });

  if (rawDuration != null) durationSeconds = (rawDuration * timecodeScale) / 1e9;
  // A file whose header region we fully parsed but that has no Cluster in the
  // window is still complete for our purposes once Info and Tracks are known.
  if (durationSeconds != null && codec !== 'unknown') truncated = false;

  chapters.sort((a, b) => a.start - b.start);
  return {
    probe: { codec, durationSeconds, sampleRate, channels, tags, chapters, cover },
    truncated,
  };
}
