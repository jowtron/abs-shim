import type { Env } from '../types';
import type { EpisodeRow } from './podcasts';
import { jobIsland, parseResult, waitsForArchive, type AnalysisRow, ANALYSIS_PROJECT } from '../lib/episode-analysis';
import {
  doneRun, emptyRun, knownCost, nodeStats, RUN_INSERT, runValues, sameResultLogged, type RunLlm, type RunRecord,
} from '../lib/analysis-runs';
import { getJob, listJobs, wharfConfigured, type WharfJob } from '../lib/wharf';

// Reading the episode analysis run log (migration 0027) for
// GET /api/analysis/runs, and the one-off backfill from what existed before
// it. Writing lives in src/lib/analysis-runs.ts.

type RunDbRow = {
  id: string; tenant_id: string; episode_id: string; library_item_id: string; show_title: string | null; episode_title: string | null;
  size_bytes: number | null; job_id: string | null; island: string | null; outcome: 'done' | 'error'; error: string | null;
  reason: string | null; audio_seconds: number | null; whisper_model: string | null; whisper_backend: string | null;
  whisper_seconds: number | null; total_seconds: number | null; transcript_source: string | null; aligned: number | null;
  ads_count: number | null; chapters_generated: number | null; llm: string | null; llm_model: string | null;
  tokens_in: number | null; tokens_out: number | null; tokens_reasoning: number | null; cost_usd: number | null; created_at: number;
};

export type RunsQuery = { limit: number; before: number | null; showId: string | null; tz: string };

const MONTHS = 12;
// Enough history for twelve calendar months in any time zone.
const MONTHS_WINDOW_MS = 400 * 86400_000;

// Money is summed in SQL as floats; round to a millionth of a dollar so
// $0.07 + $0.07 doesn't read 0.14000000000000001.
const money = (n: number | null | undefined) => Math.round((n ?? 0) * 1e6) / 1e6;
const flag = (n: number | null) => (n == null ? null : n === 1);

function monthKey(f: Intl.DateTimeFormat, ms: number): string {
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.year}-${p.month}`;
}

function monthFormat(tz: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' });
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit' });
  }
}

function runJson(r: RunDbRow) {
  return {
    id: r.id,
    at: r.created_at,
    episodeId: r.episode_id,
    libraryItemId: r.library_item_id,
    showTitle: r.show_title,
    episodeTitle: r.episode_title,
    island: r.island,
    outcome: r.outcome,
    error: r.error,
    reason: r.reason,
    audioSeconds: r.audio_seconds,
    whisperModel: r.whisper_model,
    // '' marks a backfilled run recovered from a job that didn't say.
    whisperBackend: r.whisper_backend || null,
    whisperSeconds: r.whisper_seconds,
    totalSeconds: r.total_seconds,
    transcriptSource: r.transcript_source,
    aligned: flag(r.aligned),
    adsCount: r.ads_count,
    chaptersGenerated: flag(r.chapters_generated),
    llm: r.llm,
    llmModel: r.llm_model,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    tokensReasoning: r.tokens_reasoning,
    costUsd: r.cost_usd,
  };
}

// GET /api/analysis/runs. Every statement reads through an index:
// (tenant_id, created_at) for the tenant, (library_item_id, created_at) for
// one show, idx_analysis_state for what's in flight, and podcasts by
// (tenant_id, feed_url). One D1 round trip (a batch).
export async function analysisRunsReport(env: Env, tenantId: string, q: RunsQuery) {
  const now = Date.now();
  // With a show, its own index leads (tenant_id is still checked).
  const scope = q.showId ? 'library_item_id = ? AND tenant_id = ?' : 'tenant_id = ?';
  const binds: unknown[] = q.showId ? [q.showId, tenantId] : [tenantId];
  const [totals, months, showRuns, shows, active, runs] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS runs, SUM(outcome = 'done') AS done, SUM(outcome = 'error') AS failed,
              SUM(cost_usd) AS cost, SUM(cost_usd IS NULL) AS cost_unknown,
              SUM(CASE WHEN outcome = 'done' THEN audio_seconds END) AS audio, SUM(whisper_seconds) AS whisper,
              SUM(llm = 'ok') AS llm_runs, MIN(created_at) AS since
         FROM analysis_runs WHERE ${scope}`,
    ).bind(...binds),
    env.DB.prepare(
      `SELECT created_at, cost_usd, audio_seconds, outcome FROM analysis_runs WHERE ${scope} AND created_at >= ?`,
    ).bind(...binds, now - MONTHS_WINDOW_MS),
    env.DB.prepare(
      `SELECT library_item_id, MAX(show_title) AS title, COUNT(*) AS runs, SUM(cost_usd) AS cost
         FROM analysis_runs WHERE ${scope} GROUP BY library_item_id`,
    ).bind(...binds),
    env.DB.prepare(
      `SELECT library_item_id, title, analyse FROM podcasts WHERE tenant_id = ?${q.showId ? ' AND library_item_id = ?' : ''}`,
    ).bind(tenantId, ...(q.showId ? [q.showId] : [])),
    env.DB.prepare(
      `SELECT a.episode_id, a.library_item_id, a.state, a.job_id, a.error, a.reason, a.updated_at,
              e.title AS episode_title, e.enclosure_url, e.archive_state, p.title AS show_title
         FROM episode_analysis a
         LEFT JOIN podcast_episodes e ON e.id = a.episode_id
         LEFT JOIN podcasts p ON p.library_item_id = a.library_item_id
        WHERE a.state IN ('running', 'queued') AND a.tenant_id = ?${q.showId ? ' AND a.library_item_id = ?' : ''}
        ORDER BY a.state = 'running' DESC, a.updated_at ASC`,
    ).bind(tenantId, ...(q.showId ? [q.showId] : [])),
    env.DB.prepare(
      `SELECT * FROM analysis_runs WHERE ${scope} AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
    ).bind(...binds, q.before ?? Number.MAX_SAFE_INTEGER, q.limit + 1),
  ]);

  const t = (totals!.results[0] ?? {}) as Record<string, number | null>;

  const fmt = monthFormat(q.tz);
  const byMonth = new Map<string, { month: string; runs: number; costUsd: number; audioSeconds: number }>();
  for (const r of months!.results as Array<{ created_at: number; cost_usd: number | null; audio_seconds: number | null; outcome: string }>) {
    const key = monthKey(fmt, r.created_at);
    const m = byMonth.get(key) ?? { month: key, runs: 0, costUsd: 0, audioSeconds: 0 };
    m.runs += 1;
    m.costUsd += r.cost_usd ?? 0;
    if (r.outcome === 'done') m.audioSeconds += r.audio_seconds ?? 0;
    byMonth.set(key, m);
  }
  const monthList = [...byMonth.values()]
    .sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, MONTHS)
    .map((m) => ({ ...m, costUsd: money(m.costUsd), audioSeconds: Math.round(m.audioSeconds * 1000) / 1000 }));

  // Every show of the tenant (so a show switched off, with no runs, still
  // has its line), plus any show that has runs but has since gone.
  const showMap = new Map<string, { libraryItemId: string; title: string | null; analyse: string | null; runs: number; costUsd: number }>();
  for (const s of shows!.results as Array<{ library_item_id: string; title: string | null; analyse: string | null }>) {
    showMap.set(s.library_item_id, { libraryItemId: s.library_item_id, title: s.title, analyse: s.analyse, runs: 0, costUsd: 0 });
  }
  for (const s of showRuns!.results as Array<{ library_item_id: string; title: string | null; runs: number; cost: number | null }>) {
    const cur = showMap.get(s.library_item_id) ?? { libraryItemId: s.library_item_id, title: s.title, analyse: null, runs: 0, costUsd: 0 };
    cur.runs = s.runs;
    cur.costUsd = money(s.cost);
    showMap.set(s.library_item_id, cur);
  }
  const showList = [...showMap.values()].sort((a, b) =>
    b.costUsd - a.costUsd || b.runs - a.runs || (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' }));

  type ActiveRow = Pick<AnalysisRow, 'episode_id' | 'library_item_id' | 'state' | 'job_id' | 'error' | 'reason' | 'updated_at'>
    & Pick<EpisodeRow, 'enclosure_url' | 'archive_state'> & { episode_title: string | null; show_title: string | null };
  const activeList = (active!.results as ActiveRow[]).map((a) => ({
    episodeId: a.episode_id,
    libraryItemId: a.library_item_id,
    showTitle: a.show_title,
    episodeTitle: a.episode_title,
    state: a.state,
    island: jobIsland(a.job_id),
    waitingFor: a.state === 'queued' && a.enclosure_url != null && waitsForArchive(a) ? 'archive' as const : null,
    error: a.error,
    reason: a.reason,
    since: a.updated_at,
  }));

  const runRows = runs!.results as RunDbRow[];
  const more = runRows.length > q.limit;
  const page = runRows.slice(0, q.limit);
  return {
    totals: {
      runs: t['runs'] ?? 0,
      done: t['done'] ?? 0,
      failed: t['failed'] ?? 0,
      costUsd: money(t['cost']),
      costUnknownRuns: t['cost_unknown'] ?? 0,
      audioSeconds: Math.round((t['audio'] ?? 0) * 1000) / 1000,
      whisperSeconds: Math.round((t['whisper'] ?? 0) * 1000) / 1000,
      llmRuns: t['llm_runs'] ?? 0,
      since: t['since'] ?? 0,
    },
    months: monthList,
    shows: showList,
    active: activeList,
    runs: page.map(runJson),
    nextBefore: more && page.length ? page[page.length - 1]!.created_at : null,
  };
}

// ─── Backfill (POST /api/admin/analysis/runs/backfill, owner only) ───────────
//
// The run log starts with migration 0027; before it, the only record was
// episode_analysis (newest two rows per episode, no cost). The backfill:
//  1. adds one run per done/error episode_analysis row, from what it holds;
//  2. recovers cost, tokens, island and whisper backend for those from the
//     finished job's own result, read through the wharf-router (the job
//     list of the project's home island, then GET /jobs/:id for the rest);
//     a row with no job id is matched to a job by episode, measured size
//     and the node's total time;
//  3. adds a run for each other finished job of the project the router
//     still has, for an episode of this tenant: runs whose rows were pruned
//     (a stale stitch) or never kept.
// Idempotent: backfilled ids are deterministic (`bf_…`), job ids are unique,
// and step 2 only touches rows it hasn't recovered yet. `dry` reports
// without writing.

type StoredRow = AnalysisRow & { episode_title: string | null; show_title: string | null };

function fromStoredRow(a: StoredRow): RunRecord {
  const j = <T>(s: string | null, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };
  const timings = j<Record<string, unknown>>(a.timings, {});
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const done = a.state === 'done';
  // episode_analysis never kept the node's `llm`. A model name means the
  // call was made; no `llm` timing means none was asked for; a model-less
  // step that took no time is the "no OPENROUTER_API_KEY" skip (it raises
  // before any request), anything longer an error. The job's own result
  // replaces this guess when it can be read (step 2).
  let llm: RunLlm = null;
  if (done) {
    const llmSecs = n(timings['llm']);
    llm = a.llm_model ? 'ok' : llmSecs == null ? null : llmSecs < 1 ? 'skipped' : 'error';
  }
  const offsets = j<unknown[]>(a.offsets, []);
  const ads = j<unknown[]>(a.ads, []);
  const chapters = j<unknown[] | null>(a.chapters, null);
  return {
    ...emptyRun({ tenantId: a.tenant_id, episodeId: a.episode_id, libraryItemId: a.library_item_id, outcome: done ? 'done' : 'error' }),
    showTitle: a.show_title,
    episodeTitle: a.episode_title,
    sizeBytes: a.size_bytes || null,
    jobId: a.job_id,
    island: jobIsland(a.job_id),
    error: done ? null : a.error,
    reason: a.reason ?? null,
    audioSeconds: done ? a.duration : null,
    whisperModel: done ? a.model : null,
    whisperSeconds: done ? n(timings['whisper']) : null,
    totalSeconds: done ? n(timings['total']) : null,
    transcriptSource: done ? a.transcript_source : null,
    aligned: done ? offsets.length > 0 : null,
    adsCount: done ? ads.length : null,
    chaptersGenerated: done ? !!chapters?.length : null,
    llm,
    llmModel: llm === 'ok' ? a.llm_model : null,
    costUsd: done ? knownCost(llm, null) : null,
    createdAt: a.updated_at,
  };
}

// What a job holds that the backfill uses, without its args (which carry
// the job's token on an island that predates wharf's redaction) or the
// whisper cues in its result (hundreds of KB a job).
type JobBrief = {
  id: string; state: string; error: string | null; endedAt: number | null;
  episodeId: string | null; requestedSize: number; result: Record<string, unknown> | null;
  transcriptSource: 'publisher' | 'whisper' | null; resultGone: boolean;
};

function brief(j: WharfJob): JobBrief {
  const args = (j.args && typeof j.args === 'object' ? j.args : {}) as Record<string, unknown>;
  let result = j.result && typeof j.result === 'object' && !Array.isArray(j.result) ? { ...(j.result as Record<string, unknown>) } : null;
  // Still a spill marker after GET /jobs/:id: the file is gone, and with it
  // everything the run said about itself.
  const resultGone = result?.['_wharf_result_spilled'] === true;
  if (resultGone) result = null;
  let transcriptSource: JobBrief['transcriptSource'] = null;
  if (result?.['transcript'] && typeof result['transcript'] === 'object') {
    // The cues are the bulk of a result and the log needs only where the
    // transcript came from (kept aside: parseResult reads an empty whisper
    // cue list as no transcript).
    const src = String((result['transcript'] as Record<string, unknown>)['source'] ?? '').toLowerCase();
    transcriptSource = src.startsWith('publisher') ? 'publisher' : src === 'whisper' ? 'whisper' : null;
    result = { ...result, transcript: null };
  }
  const ended = Date.parse(j.ended_at ?? j.created_at ?? '');
  return {
    id: j.id, state: j.state, error: j.error ?? null, endedAt: Number.isFinite(ended) ? ended : null,
    episodeId: typeof args['episodeId'] === 'string' ? args['episodeId'] : null,
    requestedSize: typeof args['sizeBytes'] === 'number' ? args['sizeBytes'] : 0,
    result, transcriptSource, resultGone,
  };
}

const sameTotal = (a: unknown, b: number | null) => typeof a === 'number' && b != null && Math.abs(a - b) < 0.011;

export async function backfillAnalysisRuns(env: Env, tenantId: string, opts: { dry?: boolean } = {}) {
  const report = {
    dry: !!opts.dry,
    fromRows: 0, fromRowsSkipped: 0,
    jobsListed: 0, listError: null as string | null,
    recovered: 0, costsRecovered: 0, unrecovered: [] as Array<{ id: string; jobId: string | null; why: string }>,
    fromJobs: 0,
    totals: { runs: 0, costUsd: 0, costUnknownRuns: 0 },
  };

  // Job ids steps 1 and 2 take, so a dry run's step 3 doesn't count them
  // again (nothing it would have written is there to see).
  const claimed = new Set<string>();
  const wouldInsert: Array<Pick<RunDbRow, 'id' | 'job_id' | 'episode_id' | 'size_bytes' | 'total_seconds'>> = [];

  // 1. episode_analysis → runs.
  const stored = (await env.DB.prepare(
    `SELECT a.*, e.title AS episode_title, p.title AS show_title
       FROM episode_analysis a
       LEFT JOIN podcast_episodes e ON e.id = a.episode_id
       LEFT JOIN podcasts p ON p.library_item_id = a.library_item_id
      WHERE a.state IN ('done', 'error') AND a.tenant_id = ?`,
  ).bind(tenantId).all<StoredRow>()).results;
  for (const a of stored) {
    const rec = fromStoredRow(a);
    const id = `bf_${a.episode_id}_${a.size_bytes}`;
    const exists = await env.DB.prepare('SELECT 1 FROM analysis_runs WHERE id = ?').bind(id).first()
      || (rec.jobId && await env.DB.prepare('SELECT 1 FROM analysis_runs WHERE job_id = ?').bind(rec.jobId).first());
    if (exists || (rec.outcome === 'done' && await sameResultLogged(env, rec))) { report.fromRowsSkipped++; continue; }
    if (!opts.dry) await env.DB.prepare(RUN_INSERT.replace('INSERT', 'INSERT OR IGNORE')).bind(...runValues(id, rec)).run();
    else if (rec.outcome === 'done') wouldInsert.push({ id, job_id: rec.jobId, episode_id: rec.episodeId, size_bytes: rec.sizeBytes, total_seconds: rec.totalSeconds });
    if (rec.jobId) claimed.add(rec.jobId);
    report.fromRows++;
  }

  // 2. Recover from the jobs. The listing covers the project's home island
  //    (the Mac); a job that ran on a fallback island is read by id.
  const jobs = new Map<string, JobBrief>();
  if (wharfConfigured(env)) {
    try {
      let after: string | undefined;
      for (let page = 0; page < 40; page++) {
        const r = await listJobs(env, ANALYSIS_PROJECT, { limit: 10, ...(after ? { afterId: after } : {}) });
        for (const j of r.jobs) {
          // wharf keeps a result over 256 KB (a long whisper transcript) in
          // a file and the LIST shows only a marker; GET /jobs/:id inlines
          // it again. Taken as a result, the marker made an empty run.
          const spilled = !!(j.result && typeof j.result === 'object' && (j.result as Record<string, unknown>)['_wharf_result_spilled'] === true);
          jobs.set(j.id, brief(spilled ? await getJob(env, j.id) : j));
        }
        if (!r.next_cursor || !r.jobs.length) break;
        after = r.next_cursor;
      }
    } catch (err) {
      report.listError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
  } else {
    report.listError = 'the wharf-router is not configured on this shim';
  }
  report.jobsListed = jobs.size;

  const pending = [...(await env.DB.prepare(
    `SELECT id, job_id, episode_id, size_bytes, total_seconds FROM analysis_runs
      WHERE tenant_id = ? AND id LIKE 'bf\\_%' ESCAPE '\\' AND outcome = 'done' AND whisper_backend IS NULL`,
  ).bind(tenantId).all<Pick<RunDbRow, 'id' | 'job_id' | 'episode_id' | 'size_bytes' | 'total_seconds'>>()).results, ...wouldInsert];
  for (const r of pending) {
    let job: JobBrief | null = r.job_id ? jobs.get(r.job_id) ?? null : null;
    if (!job && r.job_id && wharfConfigured(env)) {
      try { job = brief(await getJob(env, r.job_id)); } catch { job = null; }
    }
    if (!job && !r.job_id) {
      job = [...jobs.values()].find((j) => j.state === 'succeeded' && j.episodeId === r.episode_id && j.result
        && j.result['sizeBytes'] === r.size_bytes && sameTotal((j.result['timings'] as Record<string, unknown> | undefined)?.['total'], r.total_seconds)) ?? null;
    }
    if (!job?.result) {
      report.unrecovered.push({ id: r.id, jobId: r.job_id, why: !job ? (r.job_id ? 'the router has no such job now' : 'no job matched')
        : job.resultGone ? 'wharf no longer holds the result' : 'the job has no result' });
      continue;
    }
    const s = nodeStats(job.result);
    claimed.add(job.id);
    if (!opts.dry) {
      const res = await env.DB.prepare(
        `UPDATE OR IGNORE analysis_runs SET job_id = COALESCE(job_id, ?), island = COALESCE(?, island), whisper_backend = ?,
                llm = ?, llm_model = ?, tokens_in = ?, tokens_out = ?, tokens_reasoning = ?, cost_usd = ?,
                whisper_seconds = COALESCE(?, whisper_seconds), total_seconds = COALESCE(?, total_seconds)
          WHERE id = ?`,
      ).bind(job.id, jobIsland(job.id) ?? s.island, s.whisperBackend ?? '', s.llm, s.llmModel, s.tokensIn, s.tokensOut, s.tokensReasoning,
        s.costUsd, s.whisperSeconds, s.totalSeconds, r.id).run();
      // OR IGNORE: the job id is already another run's (logged live).
      if (!res.meta.changes) { report.unrecovered.push({ id: r.id, jobId: job.id, why: 'the job is already logged as another run' }); continue; }
    }
    report.recovered++;
    if (s.llm === 'ok' && s.costUsd != null) report.costsRecovered++;
  }

  // 3. Finished jobs the log doesn't have yet, for this tenant's episodes.
  const finished = [...jobs.values()].filter((j) => j.episodeId && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state));
  const ids = [...new Set(finished.map((j) => j.episodeId!))];
  const episodes = new Map<string, { id: string; library_item_id: string; title: string | null; show_title: string | null }>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = (await env.DB.prepare(
      `SELECT e.id, e.library_item_id, e.title, p.title AS show_title
         FROM podcast_episodes e LEFT JOIN podcasts p ON p.library_item_id = e.library_item_id
        WHERE e.id IN (${chunk.map(() => '?').join(', ')}) AND e.tenant_id = ?`,
    ).bind(...chunk, tenantId).all<{ id: string; library_item_id: string; title: string | null; show_title: string | null }>()).results;
    for (const r of rows) episodes.set(r.id, r);
  }
  for (const j of finished) {
    const e = episodes.get(j.episodeId!);
    if (!e) continue;
    if (claimed.has(j.id) || await env.DB.prepare('SELECT 1 FROM analysis_runs WHERE job_id = ?').bind(j.id).first()) continue;
    const base = { tenantId, episodeId: e.id, libraryItemId: e.library_item_id, showTitle: e.show_title, episodeTitle: e.title, jobId: j.id, reason: null };
    let rec: RunRecord;
    if (j.state === 'succeeded' && j.result) {
      try {
        rec = { ...doneRun(base, jobIsland(j.id), parseResult(j.result, j.requestedSize), j.result), transcriptSource: j.transcriptSource };
      } catch (err) {
        const s = nodeStats(j.result);
        rec = { ...emptyRun({ ...base, outcome: 'error' }), ...base, ...s, island: jobIsland(j.id) ?? s.island,
          sizeBytes: j.requestedSize || null, error: `the job's result was unusable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
      }
    } else if (j.state === 'succeeded') {
      // It ran and finished; what it did and cost is no longer held.
      rec = { ...emptyRun({ ...base, outcome: 'done' }), ...base, island: jobIsland(j.id), sizeBytes: j.requestedSize || null };
    } else {
      const s = j.result ? nodeStats(j.result) : null;
      rec = { ...emptyRun({ ...base, outcome: 'error' }), ...base, ...(s ?? {}), island: jobIsland(j.id) ?? s?.island ?? null,
        sizeBytes: j.requestedSize || null, error: `job ${j.state}${j.error ? `: ${j.error}` : ''}`.slice(0, 300), costUsd: s?.costUsd ?? null };
    }
    rec.createdAt = j.endedAt ?? Date.now();
    if (rec.outcome === 'done' && await sameResultLogged(env, rec)) continue;
    if (!opts.dry) await env.DB.prepare(RUN_INSERT.replace('INSERT', 'INSERT OR IGNORE')).bind(...runValues(`bf_${j.id}`, rec)).run();
    report.fromJobs++;
  }

  const t = await env.DB.prepare(
    'SELECT COUNT(*) AS runs, SUM(cost_usd) AS cost, SUM(cost_usd IS NULL) AS unknown FROM analysis_runs WHERE tenant_id = ?',
  ).bind(tenantId).first<{ runs: number; cost: number | null; unknown: number | null }>();
  report.totals = { runs: t?.runs ?? 0, costUsd: money(t?.cost), costUnknownRuns: t?.unknown ?? 0 };
  return report;
}
