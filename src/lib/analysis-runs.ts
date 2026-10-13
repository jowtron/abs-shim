// The episode analysis run log (migration 0027, 2026-10-13): one append-only
// row per finished attempt, done or failed, with what it did and what it
// cost. episode_analysis can't serve as the record: it keeps the newest two
// rows per episode and never stored the node's stats, so cost and tokens
// were dropped as each result was stored. Read by GET /api/analysis/runs
// (src/routes/analysis.ts) for Pholia's Settings page and /admin.
//
// This module only writes. It imports nothing at runtime from
// episode-analysis.ts, which calls into it, so the two can't form a cycle.

import type { Env } from '../types';
import type { ParsedResult } from './episode-analysis';

export type RunLlm = 'ok' | 'skipped' | 'error' | null;

export type RunRecord = {
  tenantId: string;
  episodeId: string;
  libraryItemId: string;
  showTitle: string | null;
  episodeTitle: string | null;
  sizeBytes: number | null;
  jobId: string | null;
  island: string | null;
  outcome: 'done' | 'error';
  error: string | null;
  reason: string | null;
  audioSeconds: number | null;
  whisperModel: string | null;
  whisperBackend: string | null;
  whisperSeconds: number | null;
  totalSeconds: number | null;
  transcriptSource: string | null;
  aligned: boolean | null;
  adsCount: number | null;
  chaptersGenerated: boolean | null;
  llm: RunLlm;
  llmModel: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensReasoning: number | null;
  costUsd: number | null;
  createdAt: number;
};

// A failed attempt whose job is lost (the Mac asleep past its limit) can
// still finish and deliver: its result upgrades that run rather than
// adding a second one, for this long after it was given up.
const LATE_RESULT_MS = 7 * 86400_000;
// failRow's message for a lost job starts with this (episode-analysis.ts).
export const LOST_PREFIX = 'no result after';

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.round(n); };
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

export function emptyRun(base: Pick<RunRecord, 'tenantId' | 'episodeId' | 'libraryItemId' | 'outcome'>): RunRecord {
  return {
    ...base, showTitle: null, episodeTitle: null, sizeBytes: null, jobId: null, island: null, error: null, reason: null,
    audioSeconds: null, whisperModel: null, whisperBackend: null, whisperSeconds: null, totalSeconds: null,
    transcriptSource: null, aligned: null, adsCount: null, chaptersGenerated: null,
    llm: null, llmModel: null, tokensIn: null, tokensOut: null, tokensReasoning: null, costUsd: null, createdAt: Date.now(),
  };
}

// The node's `llm`: "ok", or "skipped: …" / "error: …"; absent when the job
// was not asked for an LLM pass (wantLlm false).
export function llmStatus(v: unknown): RunLlm {
  if (obj(v)) return 'ok';
  if (typeof v !== 'string' || !v) return null;
  if (v === 'ok') return 'ok';
  if (v.startsWith('skipped')) return 'skipped';
  if (v.startsWith('error')) return 'error';
  return 'ok';   // an older node put the model name here when the step ran
}

// Cost is only claimed when it is known: the node's own figure (OpenRouter's
// `usage.cost`), or zero when no model call happened at all (none asked
// for, or skipped for want of a key). An LLM error may have been billed, and
// an "ok" without a figure is an older node: both stay NULL, "not recorded".
export function knownCost(llm: RunLlm, reported: number | null): number | null {
  if (reported != null) return reported;
  return llm === null || llm === 'skipped' ? 0 : null;
}

// What the node's result JSON says about the run itself (README of
// wharf-project/podcast-transcribe): stats.node, stats.whisperBackend,
// timings, llm, and stats.llm = {model, usage: {prompt_tokens,
// completion_tokens, reasoning_tokens}, costUsd}. Loose on purpose: it also
// reads a result that failed parseResult, so a run with an unusable result
// still records what it cost.
export function nodeStats(raw: unknown): Pick<RunRecord,
  'island' | 'whisperBackend' | 'whisperSeconds' | 'totalSeconds' | 'llm' | 'llmModel' | 'tokensIn' | 'tokensOut' | 'tokensReasoning' | 'costUsd' | 'audioSeconds' | 'whisperModel'> {
  // No result object at all (a failed job), or wharf's marker for a result
  // too big to keep that is gone, says nothing about the LLM step, so its
  // cost stays unknown rather than "no call, $0".
  const given = obj(raw)?.['_wharf_result_spilled'] === true ? null : obj(raw);
  const o = given ?? {};
  const stats = obj(o['stats']) ?? {};
  const timings = obj(o['timings']) ?? {};
  const sl = obj(stats['llm']) ?? {};
  const usage = obj(sl['usage']) ?? {};
  const llm = llmStatus(o['llm']);
  const dur = num(o['duration']);
  return {
    island: str(stats['node'], 40),
    whisperBackend: str(stats['whisperBackend'], 40),
    whisperSeconds: num(timings['whisper']),
    totalSeconds: num(timings['total']),
    llm,
    llmModel: llm === 'ok' ? (str(sl['model'], 80) ?? str(o['llmModel'], 80)) : null,
    tokensIn: int(usage['prompt_tokens']),
    tokensOut: int(usage['completion_tokens']),
    tokensReasoning: int(usage['reasoning_tokens']),
    costUsd: given ? knownCost(llm, num(sl['costUsd'])) : null,
    audioSeconds: dur && dur > 0 ? dur : null,
    whisperModel: str(o['model'], 80),
  };
}

// A stored result's run: what it did (from the parsed result) plus how and
// at what cost (from the raw JSON). `island` prefers the router's job id
// prefix, the name clients know the box by.
export function doneRun(
  base: Pick<RunRecord, 'tenantId' | 'episodeId' | 'libraryItemId' | 'showTitle' | 'episodeTitle' | 'jobId' | 'reason'>,
  island: string | null, parsed: ParsedResult, raw: unknown,
): RunRecord {
  const s = nodeStats(raw);
  return {
    ...emptyRun({ ...base, outcome: 'done' }),
    ...base,
    ...s,
    island: island ?? s.island,
    sizeBytes: parsed.size,
    audioSeconds: parsed.duration ?? s.audioSeconds,
    whisperModel: parsed.model ?? s.whisperModel,
    llmModel: s.llmModel ?? (s.llm === 'ok' ? parsed.llmModel : null),
    transcriptSource: parsed.transcriptSource,
    aligned: parsed.offsets.length > 0,
    adsCount: parsed.ads.length,
    chaptersGenerated: !!parsed.generatedChapters?.length,
  };
}

async function titlesFor(env: Env, episodeId: string, libraryItemId: string) {
  const r = await env.DB.prepare(
    `SELECT (SELECT title FROM podcast_episodes WHERE id = ?) AS episode_title,
            (SELECT title FROM podcasts WHERE library_item_id = ?) AS show_title`,
  ).bind(episodeId, libraryItemId).first<{ episode_title: string | null; show_title: string | null }>();
  return { episodeTitle: r?.episode_title ?? null, showTitle: r?.show_title ?? null };
}

// The job a result belongs to when nothing running claims it: a job given
// up as lost that finished after all (the Mac woke). Its error run becomes
// the done run instead of a second row.
async function lateJobId(env: Env, episodeId: string, now: number): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT job_id FROM analysis_runs
      WHERE episode_id = ? AND created_at > ? AND outcome = 'error' AND job_id IS NOT NULL AND error LIKE ?
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(episodeId, now - LATE_RESULT_MS, `${LOST_PREFIX}%`).first<{ job_id: string }>();
  return r?.job_id ?? null;
}

const COLS = [
  'id', 'tenant_id', 'episode_id', 'library_item_id', 'show_title', 'episode_title', 'size_bytes', 'job_id', 'island',
  'outcome', 'error', 'reason', 'audio_seconds', 'whisper_model', 'whisper_backend', 'whisper_seconds', 'total_seconds',
  'transcript_source', 'aligned', 'ads_count', 'chapters_generated', 'llm', 'llm_model', 'tokens_in', 'tokens_out',
  'tokens_reasoning', 'cost_usd', 'created_at',
] as const;

const bool = (b: boolean | null) => (b == null ? null : b ? 1 : 0);

export function runValues(id: string, r: RunRecord): unknown[] {
  return [
    id, r.tenantId, r.episodeId, r.libraryItemId, r.showTitle, r.episodeTitle, r.sizeBytes, r.jobId, r.island,
    r.outcome, r.error, r.reason, r.audioSeconds, r.whisperModel, r.whisperBackend, r.whisperSeconds, r.totalSeconds,
    r.transcriptSource, bool(r.aligned), r.adsCount, bool(r.chaptersGenerated), r.llm, r.llmModel, r.tokensIn, r.tokensOut,
    r.tokensReasoning, r.costUsd, r.createdAt,
  ];
}

export const RUN_INSERT = `INSERT INTO analysis_runs (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`;

// The same finished result reaches the shim twice when the node's POST and
// the pump's read of the job both land (or the node retries a POST whose
// answer it lost). A done run already logged for this episode, stitch and
// node-measured total time is that result.
export async function sameResultLogged(env: Env, r: Pick<RunRecord, 'episodeId' | 'sizeBytes' | 'totalSeconds'>): Promise<boolean> {
  const hit = await env.DB.prepare(
    `SELECT 1 FROM analysis_runs WHERE episode_id = ? AND outcome = 'done' AND size_bytes IS ? AND total_seconds IS ? LIMIT 1`,
  ).bind(r.episodeId, r.sizeBytes, r.totalSeconds).first();
  return !!hit;
}

// Log one finished attempt, exactly once. Keyed on the job id when there is
// one (a unique index): a second write for the same job only ever turns a
// failure into the success that followed it (a lost job that delivered
// late); otherwise it changes nothing. Never throws: a run log that fails to
// write must not fail the result it describes.
export async function recordRun(env: Env, rec: RunRecord): Promise<boolean> {
  try {
    const r = { ...rec };
    if (r.showTitle == null || r.episodeTitle == null) {
      const t = await titlesFor(env, r.episodeId, r.libraryItemId);
      r.showTitle ??= t.showTitle;
      r.episodeTitle ??= t.episodeTitle;
    }
    if (r.outcome === 'done') {
      if (await sameResultLogged(env, r)) return false;
      r.jobId ??= await lateJobId(env, r.episodeId, r.createdAt);
    }
    // What the success knows wins, except what only the failed try knew
    // (why it ran: a late result's own row has usually been requeued).
    const keep = new Set(['reason', 'island', 'show_title', 'episode_title']);
    const update = COLS.filter((c) => c !== 'id' && c !== 'job_id')
      .map((c) => (keep.has(c) ? `${c} = COALESCE(excluded.${c}, analysis_runs.${c})` : `${c} = excluded.${c}`)).join(', ');
    const res = await env.DB.prepare(
      `${RUN_INSERT}
       ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO UPDATE SET ${update}
       WHERE analysis_runs.outcome = 'error' AND excluded.outcome = 'done'`,
    ).bind(...runValues(crypto.randomUUID(), r)).run();
    return !!res.meta.changes;
  } catch (err) {
    console.error('analysis run log:', err instanceof Error ? err.message : err);
    return false;
  }
}
