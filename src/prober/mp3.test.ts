// Pure in-memory self-test for the MP3 prober. No test framework — we have
// no harness, so this file exports runMp3SelfTest() and throws on failure.
//
// Run from a Node shell that can load TypeScript (e.g. `npx tsx`):
//
//   npx tsx -e 'import("./src/prober/mp3.test.ts").then(m => m.runMp3SelfTest())'
//
// or fold the call into a future test runner. The point is that this file is
// type-checked by `npm run typecheck`, so the prober signatures are exercised
// even when nobody runs the assertions.

import { parseMp3, synchsafe } from './mp3';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`MP3 self-test FAILED: ${msg}`);
}

// Build an ID3v2.3 frame (id[4] size[4 plain u32] flags[2] data[size]).
function id3v23Frame(id: string, data: Uint8Array): Uint8Array {
  if (id.length !== 4) throw new Error('id must be 4 chars');
  const out = new Uint8Array(10 + data.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  const sizeView = new DataView(out.buffer);
  sizeView.setUint32(4, data.length);
  // flags already 0x00 0x00
  out.set(data, 10);
  return out;
}

// Text frame body: [encoding=0x03 UTF-8] [utf8 bytes]
function utf8TextBody(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const out = new Uint8Array(1 + encoded.length);
  out[0] = 0x03;
  out.set(encoded, 1);
  return out;
}

// Latin1 text frame body: [encoding=0x00] [latin1 bytes]
function latin1TextBody(text: string): Uint8Array {
  const out = new Uint8Array(1 + text.length);
  out[0] = 0x00;
  for (let i = 0; i < text.length; i++) out[i + 1] = text.charCodeAt(i) & 0xff;
  return out;
}

function buildSynthetic(opts: {
  title: string;
  album: string;
  year: string;
  frameCount: number;
}): Uint8Array {
  // Frames.
  const tit2 = id3v23Frame('TIT2', utf8TextBody(opts.title));
  const talb = id3v23Frame('TALB', utf8TextBody(opts.album));
  const tyer = id3v23Frame('TYER', latin1TextBody(opts.year));
  const frames = new Uint8Array(tit2.length + talb.length + tyer.length);
  frames.set(tit2, 0);
  frames.set(talb, tit2.length);
  frames.set(tyer, tit2.length + talb.length);

  // ID3v2.3 header: "ID3" 0x03 0x00 0x00 + synchsafe(size).
  const id3Body = frames; // no extended header, no padding
  const tagSize = id3Body.length;
  const id3 = new Uint8Array(10 + tagSize);
  id3[0] = 0x49; id3[1] = 0x44; id3[2] = 0x33;   // "ID3"
  id3[3] = 0x03; id3[4] = 0x00;                  // version 2.3.0
  id3[5] = 0x00;                                 // flags
  // Synchsafe encode tagSize (28-bit) into bytes 6..9.
  id3[6] = (tagSize >>> 21) & 0x7f;
  id3[7] = (tagSize >>> 14) & 0x7f;
  id3[8] = (tagSize >>> 7) & 0x7f;
  id3[9] = tagSize & 0x7f;
  id3.set(id3Body, 10);

  // MPEG1 Layer III, 128kbps, 44100Hz, stereo, no CRC.
  //   0xFF, 0xFB (sync+ver=11(MPEG1)+layer=01(L3)+CRC=1),
  //   0x90 (bitrate=1001=128k, sr=00=44100, pad=0, priv=0),
  //   0x00 (chmode=00 stereo)
  const frame = new Uint8Array(4 + 32 + 12); // header + side info + Xing block
  frame[0] = 0xFF; frame[1] = 0xFB; frame[2] = 0x90; frame[3] = 0x00;
  // side info bytes 4..35 stay zero
  // Xing at offset 36
  frame[36] = 0x58; frame[37] = 0x69; frame[38] = 0x6E; frame[39] = 0x67; // "Xing"
  // flags u32 = 0x00000001 (frames-present)
  frame[40] = 0x00; frame[41] = 0x00; frame[42] = 0x00; frame[43] = 0x01;
  // frameCount u32 BE
  frame[44] = (opts.frameCount >>> 24) & 0xff;
  frame[45] = (opts.frameCount >>> 16) & 0xff;
  frame[46] = (opts.frameCount >>> 8) & 0xff;
  frame[47] = opts.frameCount & 0xff;

  const buf = new Uint8Array(id3.length + frame.length);
  buf.set(id3, 0);
  buf.set(frame, id3.length);
  return buf;
}

export function runMp3SelfTest(): void {
  // synchsafe round-trip check first.
  const probe = new Uint8Array([0x00, 0x00, 0x00, 0x3e]);
  assert(synchsafe(probe, 0) === 62, `synchsafe basic: got ${synchsafe(probe, 0)}`);
  // Largest synchsafe value: 0x7f 0x7f 0x7f 0x7f = (1<<28)-1.
  const max = new Uint8Array([0x7f, 0x7f, 0x7f, 0x7f]);
  assert(synchsafe(max, 0) === (1 << 28) - 1, 'synchsafe max');

  // End-to-end probe over a synthetic file.
  const FRAME_COUNT = 1000;
  const bytes = buildSynthetic({
    title: 'Chapter One',
    album: 'The Book Title',
    year: '2024',
    frameCount: FRAME_COUNT,
  });
  // fileSize doesn't matter when Xing provides the count, but pass a realistic
  // value so the CBR fallback branch isn't exercised here.
  const result = parseMp3(bytes, bytes.length + 5_000_000);

  assert(result.tags['TIT2'] === 'Chapter One', `TIT2 got ${result.tags['TIT2']}`);
  assert(result.tags['TALB'] === 'The Book Title', `TALB got ${result.tags['TALB']}`);
  assert(result.tags['TYER'] === '2024', `TYER got ${result.tags['TYER']}`);

  assert(result.bitrate === 128_000, `bitrate got ${result.bitrate}`);
  assert(result.sampleRate === 44_100, `sample rate got ${result.sampleRate}`);
  assert(result.channels === 2, `channels got ${result.channels}`);

  // 1000 frames × 1152 samples/frame ÷ 44100 Hz ≈ 26.1224s.
  const expected = (FRAME_COUNT * 1152) / 44100;
  const actual = result.durationSeconds ?? -1;
  assert(Math.abs(actual - expected) < 0.001, `duration got ${actual}, expected ${expected}`);

  // CBR fallback path: build a buffer with no Xing header (just zero out the
  // "Xing" magic at frame_start + 36) and verify duration is derived from
  // first-frame bitrate * (fileSize - id3End).
  const noXing = bytes.slice();
  const id3End = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
  const xingMagicAt = id3End + 36;
  for (let i = 0; i < 4; i++) noXing[xingMagicAt + i] = 0x00;
  const fakeFileSize = 5_000_000;
  const cbr = parseMp3(noXing, fakeFileSize);
  const cbrExpected = ((fakeFileSize - id3End) * 8) / 128_000;
  const cbrActual = cbr.durationSeconds ?? -1;
  assert(
    Math.abs(cbrActual - cbrExpected) < 0.001,
    `CBR duration got ${cbrActual}, expected ${cbrExpected}`,
  );
}
