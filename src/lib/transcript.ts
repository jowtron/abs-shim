// Episode transcripts (Podcasting 2.0 <podcast:transcript>, 2026-10-12).
// A feed may list several files per episode (LINUX Unplugged lists a WebVTT
// and an SRT of the same text); the client asks for "the transcript" and the
// shim picks one, fetches it from the publisher and answers one shape for
// every format, so Pholia needs no subtitle parsers of its own.
//
// Timed formats come back as paragraphs with a start time (`cues`): caption
// files are cut for the screen, not for reading — Linux & Open Source News'
// SRT is two-second fragments, "weekly Linux and open" — so consecutive
// cues are joined into paragraphs, a new one at each change of speaker, at a
// pause, or after a sentence once the paragraph is long enough. Untimed
// formats (plain text, HTML) come back as `text` paragraphs.

import type { TranscriptLink } from './rss';
import { decodeEntities } from './rss';

export type TranscriptCue = { start: number; end: number; speaker: string | null; text: string };
export type Transcript =
  | { format: 'cues'; source: string; cues: TranscriptCue[] }
  | { format: 'text'; source: string; paragraphs: string[] };

type Kind = 'vtt' | 'srt' | 'json' | 'html' | 'text';

// Most useful first: speaker names and timing (WebVTT's <v Name>, the JSON
// format's `speaker`), then timing alone, then text alone.
const ORDER: Kind[] = ['vtt', 'json', 'srt', 'html', 'text'];

function kindOf(l: TranscriptLink): Kind | null {
  const t = (l.type || '').toLowerCase().split(';')[0]!.trim();
  if (t === 'text/vtt') return 'vtt';
  if (t === 'application/x-subrip' || t === 'application/srt' || t === 'text/srt' || t === 'application/x-srt') return 'srt';
  if (t === 'application/json') return 'json';
  if (t === 'text/html') return 'html';
  if (t === 'text/plain') return 'text';
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(l.url)?.[1]?.toLowerCase();
  return ext === 'vtt' ? 'vtt' : ext === 'srt' ? 'srt' : ext === 'json' ? 'json'
    : ext === 'html' || ext === 'htm' ? 'html' : ext === 'txt' ? 'text' : null;
}

// The links worth trying, best first. Unknown types are dropped.
export function rankTranscripts(links: TranscriptLink[]): Array<TranscriptLink & { kind: Kind }> {
  return links
    .map((l) => ({ ...l, kind: kindOf(l) }))
    .filter((l): l is TranscriptLink & { kind: Kind } => l.kind !== null)
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

export function parseTranscript(kind: Kind, body: string, duration: number): Transcript | null {
  const source = kind;
  if (kind === 'vtt' || kind === 'srt') {
    const cues = joinCues(fixOffset(parseCaptions(body), duration));
    return cues.length ? { format: 'cues', source, cues } : null;
  }
  if (kind === 'json') {
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { return null; }
    const cues = joinCues(fixOffset(parseJsonSegments(raw), duration));
    return cues.length ? { format: 'cues', source, cues } : null;
  }
  const paragraphs = kind === 'html' ? htmlParagraphs(body) : textParagraphs(body);
  return paragraphs.length ? { format: 'text', source, paragraphs } : null;
}

// "01:02:03.456", "01:02:03,456" (SRT), "02:03.456" (WebVTT may omit hours).
function clock(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0);
}

function cleanText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// WebVTT and SRT share the shape that matters: blocks separated by blank
// lines, one "start --> end" line, then the text. Blocks without a timing
// line (WEBVTT header, NOTE, STYLE, REGION) are skipped.
function parseCaptions(body: string): TranscriptCue[] {
  const out: TranscriptCue[] = [];
  const blocks = body.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at === -1) continue;
    const [a, b] = lines[at]!.split('-->');
    const start = clock(a ?? '');
    const end = clock((b ?? '').trim().split(/\s+/)[0] ?? '');
    if (start == null || end == null) continue;
    const raw = lines.slice(at + 1).join(' ');
    // WebVTT voice span: <v Chris> or <v.loud Chris>.
    const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(raw);
    const text = cleanText(raw);
    if (text) out.push({ start, end: Math.max(end, start), speaker: voice ? cleanText(voice[1]!) || null : null, text });
    if (out.length >= 50_000) break;
  }
  return out;
}

// Podcasting 2.0's JSON transcript: {version, segments: [{speaker,
// startTime, endTime, body}]}, often one word per segment.
function parseJsonSegments(raw: unknown): TranscriptCue[] {
  const segs = (raw as { segments?: unknown })?.segments;
  if (!Array.isArray(segs)) return [];
  const out: TranscriptCue[] = [];
  for (const s of segs.slice(0, 200_000) as Array<Record<string, unknown>>) {
    const start = Number(s?.startTime), end = Number(s?.endTime);
    const text = typeof s?.body === 'string' ? cleanText(s.body) : '';
    if (!Number.isFinite(start) || !text) continue;
    out.push({ start, end: Number.isFinite(end) ? Math.max(end, start) : start, speaker: typeof s.speaker === 'string' && s.speaker.trim() ? s.speaker.trim() : null, text });
  }
  return out;
}

// Video editors start a timeline at 01:00:00:00, and captions exported from
// one keep that hour: every cue of Linux & Open Source News' SRT is an hour
// late. Nobody starts talking an hour into a podcast, so a first cue past
// the hour mark is an offset — removed only when the cues then fit the
// episode (or the episode's length isn't known).
function fixOffset(cues: TranscriptCue[], duration: number): TranscriptCue[] {
  if (!cues.length) return cues;
  cues.sort((x, y) => x.start - y.start);
  const first = cues[0]!.start;
  if (first < 3600) return cues;
  const shift = Math.floor(first / 3600) * 3600;
  const lastEnd = cues[cues.length - 1]!.end - shift;
  if (duration > 0 && lastEnd > duration + 120) return cues;
  return cues.map((c) => ({ ...c, start: c.start - shift, end: c.end - shift }));
}

const SENTENCE_END = /[.?!…]["'”’)\]]?$/;
// A paragraph ends at the first sentence end after this many characters.
const PARA_MIN = 200;
const SENTENCE_INSIDE = /[.?!…]["'”’)\]]?\s+(?=\S)/;

function joinCues(cues: TranscriptCue[]): TranscriptCue[] {
  const out: TranscriptCue[] = [];
  let cur: TranscriptCue | null = null;
  // WebVTT names the voice on some lines only; a line without one is the
  // last speaker still talking.
  let speaker: string | null = null;
  for (const c of cues) {
    if (cur) {
      const speakerChanged = !!c.speaker && !!cur.speaker && c.speaker !== cur.speaker;
      const pause = c.start - cur.end > 3;
      const long = (SENTENCE_END.test(cur.text) && cur.text.length >= PARA_MIN) || cur.text.length >= 900;
      if (!speakerChanged && !pause && !long) {
        // A cue repeating the previous one's words (some VTT exporters roll
        // lines up) adds nothing.
        if (cur.text.endsWith(c.text)) { cur.end = Math.max(cur.end, c.end); continue; }
        // Fragment captions rarely END on a full stop ("…a podcast where
        // we"), so a long paragraph also breaks at a sentence end inside a
        // cue; the rest starts the next one, its time estimated by where in
        // the cue the break fell.
        const inner: RegExpExecArray | null = cur.text.length >= PARA_MIN ? SENTENCE_INSIDE.exec(c.text) : null;
        if (inner) {
          const cut: number = inner.index + inner[0].length;
          const at: number = c.start + (c.end - c.start) * (cut / c.text.length);
          cur.text += ' ' + c.text.slice(0, cut).trim();
          cur.end = at;
          out.push(cur);
          speaker = c.speaker ?? speaker;
          cur = { start: at, end: c.end, speaker, text: c.text.slice(cut).trim() };
          continue;
        }
        cur.text += ' ' + c.text;
        cur.end = Math.max(cur.end, c.end);
        continue;
      }
      out.push(cur);
    }
    speaker = c.speaker ?? speaker;
    cur = { ...c, speaker };
  }
  if (cur) out.push(cur);
  const ms = (n: number) => Math.round(n * 1000) / 1000;
  return out.map((c) => ({ ...c, start: ms(c.start), end: ms(c.end) }));
}

function textParagraphs(body: string): string[] {
  const t = body.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  // Blank-line paragraphs when the file has them, else one per line.
  const parts = /\n[ \t]*\n/.test(t) ? t.split(/\n[ \t]*\n/) : t.split('\n');
  return parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20_000);
}

function htmlParagraphs(body: string): string[] {
  const inner = /<body[^>]*>([\s\S]*)<\/body>/i.exec(body)?.[1] ?? body;
  const marked = inner
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n\n');
  return textParagraphs(decodeEntities(marked.replace(/<[^>]*>/g, '')));
}
