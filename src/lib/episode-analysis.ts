// Episode analysis (2026-10-13): a wharf job transcribes an episode exactly
// as this shim serves it (whisper.cpp on Joseph's Mac), aligns the
// publisher's transcript and chapters to that file, marks inserted ads, and
// writes a transcript and chapters for shows that publish none (an LLM pass
// on the node). Node side: wharf-project/podcast-transcribe/README.md.
//
// Why: hosts that stitch ads in per download (art19, Audioboom, …) serve a
// file whose times differ from the master the feed's chapters and transcript
// were made from, piecewise and differently per stitch (CLAUDE.md "Dynamic
// ad insertion"). Results are keyed by (episode, byte size): a size is one
// stitch.
//
// The contract with the node (fixed; the handler is built to it):
//   submit  project `podcast-transcribe`, handler `analyse_episode`, async,
//           args {episodeId, libraryItemId, sizeBytes, audioUrl, token,
//           transcripts, chapters, title, show, dynamicAds, showNotes,
//           wantLlm, resultUrl} (show and dynamicAds since 2026-10-14;
//           the node reads both as optional).
//           audioUrl is this shim's own stream route, so the node gets the
//           stitch listeners get (the Worker's fetch, EPISODE_AUDIO_UA);
//           token is a 20-minute access token for the tenant owner.
//   result  POSTed to resultUrl with the same bearer, and printed as the
//           job result, so the pump can take it from the job when the POST
//           never came. Stored under the size the node MEASURED.
//
// The pump runs on the 2-minute podcast cron with one job in flight at a
// time (one Mac). The Mac sleeps: a submit answered island_unreachable
// leaves the row queued with the reason (shown in /admin) and is tried again
// next tick; a job caught by sleep freezes until wake, so one unfinished
// past its island's limit (`lostAfterMs`: 45 minutes on the Mac) is treated
// as lost and submitted again (3 tries).

import type { Env } from '../types';
import type { EpisodeRow } from '../db/podcasts';
import { issueAccessToken } from '../auth/tokens';
import { getActiveMembership } from '../db/tenants';
import { cancelJob, getJob, getJobLog, runAsync, TERMINAL, wharfConfigured, WharfError, type WharfJob } from './wharf';
import {
  analysisField, currentAnalysis, hasDynamicAds, servedChapters,
  type AnalysisAd, type AnalysisCut, type AnalysisOffset, type AnalysisSummary,
} from './podcast-shapes';
import { rankTranscripts, whisperTranscript, type Transcript } from './transcript';
import { stripAllTags, type TranscriptLink } from './rss';
import { doneRun, emptyRun, LOST_PREFIX, nodeStats, recordRun } from './analysis-runs';

export const ANALYSIS_PROJECT = 'podcast-transcribe';
export const ANALYSIS_HANDLER = 'analyse_episode';

const RECENT_MS = 14 * 86400_000;          // new episodes analysed ahead of the first listen
const PLAYING_MS = 2 * 3600_000;           // "being played": progress written this recently
const UNSUBMITTED_AFTER_MS = 5 * 60_000;   // a claim whose submit never finished
const MAX_ATTEMPTS = 3;
// wharfd logs a job's full args, token included, so keep it short: the shim
// has one job in flight, so the node fetches the audio within a minute of the
// submit, and a result POST after expiry (a long stereo-au run) is covered by
// the pump taking the result from the finished job (2026-10-13).
const TOKEN_TTL_SECONDS = 20 * 60;
const KEEP_ROWS = 2;
// "Right box, wrong moment" (and "no box routed yet"): the row stays queued
// and costs no attempt.
const QUIET_CODES = new Set(['island_unreachable', 'island_unconfigured', 'node_busy', 'busy', 'project_not_routed', 'capabilities_initialising']);

// ─── When a job in flight counts as lost ─────────────────────────────────────

const MIN_MS = 60_000;

// The island a job runs on: wharf-router namespaces job ids `<island>.<id>`
// (`mac.…`, `stereo-au.…`). null for an id without one.
export function jobIsland(jobId: string | null | undefined): string | null {
  if (!jobId) return null;
  const dot = jobId.indexOf('.');
  return dot > 0 ? jobId.slice(0, dot) : null;
}

// How long a job may stay unfinished before it is cancelled and resubmitted,
// per island, as a function of the episode's length. whisper's speed differs
// ~50× between the boxes, so one number can't serve both:
//  - mac: M1 Max, whisper.cpp on Metal, a 74-minute episode in about 2 min.
//    45 min is far past any real run and short enough that a job frozen by
//    the Mac sleeping is retried within the hour.
//  - stereo-au: a Celeron, CPU only; whisper takes about 80 min of CPU per
//    hour of audio with base.en (~30 with tiny.en). At 45 min every hour-long
//    episode would be cancelled and resubmitted until it ran out of tries.
//    2.5× the audio + 15 min covers base.en with headroom; capped at 6 h so a
//    job that really is stuck still gets retried the same day.
// An island not listed here gets the Mac's rule. A new island is one line.
const LOST_AFTER: ReadonlyMap<string, (audioMs: number) => number> = new Map([
  ['mac', () => 45 * MIN_MS],
  ['stereo-au', (audioMs: number) => Math.min(2.5 * audioMs + 15 * MIN_MS, 6 * 60 * MIN_MS)],
]);
const UNKNOWN_AUDIO_MS = 90 * MIN_MS;     // an episode whose length the feed and probe never gave

export function lostAfterMs(jobId: string | null | undefined, durationSeconds: number | null | undefined): number {
  const rule = LOST_AFTER.get(jobIsland(jobId) ?? 'mac') ?? LOST_AFTER.get('mac')!;
  const audioMs = durationSeconds && durationSeconds > 0 ? durationSeconds * 1000 : UNKNOWN_AUDIO_MS;
  return Math.round(rule(audioMs));
}

export class AnalysisInputError extends Error {}

export type AnalysisRow = {
  episode_id: string;
  size_bytes: number;
  tenant_id: string;
  library_item_id: string;
  state: 'queued' | 'running' | 'done' | 'error';
  job_id: string | null;
  attempts: number;
  error: string | null;
  duration: number | null;
  model: string | null;
  llm_model: string | null;
  offsets: string | null;
  cuts: string | null;
  ads: string | null;
  chapters: string | null;
  transcript_source: string | null;
  transcript_key: string | null;
  timings: string | null;
  reason: string | null;              // migration 0027: 'asked' | 'played' | 'new'
  created_at: number;
  updated_at: number;
};

export const transcriptKeyFor = (episodeId: string, size: number) => `transcripts/${episodeId}/${size}.json`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

// The origin the node is given for audioUrl and resultUrl. It must be one the
// Mac can reach, so a request's own origin only when it is a public https
// one (not wrangler dev, not a Tailscale name).
export function analysisOrigin(env: Env, reqUrl?: string): string {
  if (reqUrl) {
    try {
      const u = new URL(reqUrl);
      if (u.protocol === 'https:' && !/^(localhost|127\.|\[::1\])/.test(u.hostname) && !u.hostname.endsWith('.ts.net')) return u.origin;
    } catch { /* fall through */ }
  }
  return (env.PUBLIC_ORIGIN ?? 'https://rhapsode.jderrick.app').replace(/\/+$/, '');
}

function publisherChapters(e: EpisodeRow): Array<{ start: number; title: string }> {
  try { return (JSON.parse(e.chapters || '[]') as Array<{ start: number; title: string }>); } catch { return []; }
}

function transcriptLinks(e: EpisodeRow) {
  let links: TranscriptLink[] = [];
  try { links = JSON.parse(e.transcripts || '[]') as TranscriptLink[]; } catch { /* none */ }
  return rankTranscripts(links).map((l) => ({ url: l.url, type: l.type, language: l.language }));
}

// A show's `analyse`: 'off' never, 'on' always, auto (NULL) when there is
// something to fix or fill: a host that inserts ads, or no chapters, or no
// transcript.
//
// An ad-inserting host serves a different stitch over time (LUP 688 came
// back 90 s shorter the day after it was first measured, a Fish episode
// moved 156 s between two Worker fetches), so an analysis of a STREAMED copy
// is right only until the next restitch. The pump therefore analyses those
// shows' episodes once they are archived, when the file is fixed for good;
// "Analyse now" (a queued row) still works on anything, see waitsForArchive.
// Joseph, 2026-10-13.
export function wantsAnalysis(e: EpisodeRow, analyse: string | null): boolean {
  if (analyse === 'off') return false;
  if (hasDynamicAds(e.enclosure_url) && e.archive_state !== 'done') return false;
  if (analyse === 'on') return true;
  return hasDynamicAds(e.enclosure_url) || !publisherChapters(e).length || !transcriptLinks(e).length;
}

// "Analyse now" on an ad-inserting host that isn't archived: the run route
// queues the pCloud copy first (when the show can archive), and the pump
// holds the queued row while that copy is queued or being fetched, for the
// reason above: the streamed stitch changes between fetches (a Fish episode
// changed size three times on 2026-10-13), the archived file never does.
// When the copy lands, submit() moves the row to the archived file's size.
// Only an archive IN FLIGHT holds it: one that ended in error, or a show that
// can't archive (no pCloud folder, so nothing was queued), lets the streamed
// copy be analysed anyway, because the listener asked for it explicitly.
export function waitsForArchive(e: Pick<EpisodeRow, 'enclosure_url' | 'archive_state'>): boolean {
  return hasDynamicAds(e.enclosure_url) && (e.archive_state === 'queued' || e.archive_state === 'fetching');
}

// ─── Submitting ──────────────────────────────────────────────────────────────

async function buildArgs(env: Env, e: EpisodeRow, origin: string) {
  const owner = await env.DB.prepare(
    'SELECT u.id, u.username, u.tokens_valid_after FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE t.id = ?',
  ).bind(e.tenant_id).first<{ id: string; username: string; tokens_valid_after: number | null }>();
  if (!owner) throw new Error('the library has no owner to act as');
  // Never logged: it is a full access token (TOKEN_TTL_SECONDS).
  const { token } = await issueAccessToken(env, owner, TOKEN_TTL_SECONDS);
  // The token acts in the owner's default tenant; name this one when it isn't.
  const m = await getActiveMembership(env, owner.id);
  const q = m?.tenantId === e.tenant_id ? '' : `?tenant=${encodeURIComponent(e.tenant_id)}`;
  const chapters = publisherChapters(e);
  const transcripts = transcriptLinks(e);
  const show = await env.DB.prepare('SELECT title FROM podcasts WHERE library_item_id = ?')
    .bind(e.library_item_id).first<{ title: string | null }>();
  return {
    episodeId: e.id,
    libraryItemId: e.library_item_id,
    sizeBytes: e.size_bytes || 0,
    audioUrl: `${origin}/api/items/${e.library_item_id}/file/${e.ino}${q}`,
    token,
    transcripts,
    chapters: chapters.length ? chapters.map((c) => ({ start: c.start, title: c.title })) : null,
    title: e.title ?? '',
    // For the LLM prompt (2026-10-14): the show's name, and whether its host
    // stitches ads in per download. Told that, Haiku 5.5 labels a
    // host-voiced pre-roll "inserted" (which is skipped automatically)
    // instead of "host-read"; without either the prompt said "Show:
    // (unknown)". Both optional on the node.
    show: show?.title ?? '',
    dynamicAds: hasDynamicAds(e.enclosure_url),
    showNotes: stripAllTags(e.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 20_000),
    // The LLM labels ads and cuts chapters; without a publisher transcript
    // it also is the only ad finder (align.py needs one), and without
    // publisher chapters it writes them.
    wantLlm: !chapters.length || !transcripts.length,
    resultUrl: `${origin}/api/podcasts/${e.library_item_id}/episode/${e.id}/analysis${q}`,
  };
}

function isQuiet(err: unknown): boolean {
  if (err instanceof WharfError) return QUIET_CODES.has(err.code);
  // Not an answer from the router at all (the binding's fetch threw).
  return true;
}

// A failed try: queued again while tries are left, else error. Only a row
// still running: a result POST that landed meanwhile has settled it. Every
// failed try is one error row in the run log (analysis_runs), written only
// when this call is the one that settled the row, so a try is logged once.
// `jobId`: the job that failed, if one was started; `raw`: its result, when
// it delivered one that couldn't be used (it may still say what it cost);
// `noJob`: nothing ran, so nothing was spent.
type FailOpts = { jobId?: string | null; raw?: unknown; noJob?: boolean };
async function failRow(env: Env, episodeId: string, size: number, msg: string, opts: FailOpts = {}): Promise<void> {
  const now = Date.now();
  const error = msg.slice(0, 300);
  const settled = await env.DB.prepare(
    `UPDATE episode_analysis SET state = CASE WHEN attempts >= ? THEN 'error' ELSE 'queued' END, job_id = NULL, error = ?, updated_at = ?
      WHERE episode_id = ? AND size_bytes = ? AND state = 'running'
      RETURNING tenant_id, library_item_id, reason`,
  ).bind(MAX_ATTEMPTS, error, now, episodeId, size).all<{ tenant_id: string; library_item_id: string; reason: string | null }>();
  const row = settled.results[0];
  if (!row) return;
  const run = emptyRun({ tenantId: row.tenant_id, episodeId, libraryItemId: row.library_item_id, outcome: 'error' });
  const s = opts.raw && typeof opts.raw === 'object' ? nodeStats(opts.raw) : null;
  await recordRun(env, {
    ...run,
    ...(s ?? {}),
    sizeBytes: size || null,
    jobId: opts.jobId ?? null,
    island: jobIsland(opts.jobId) ?? s?.island ?? null,
    error,
    reason: row.reason,
    // A failed job's spend is unknown unless its result said; a try that
    // never started a job spent nothing.
    costUsd: s?.costUsd ?? (opts.noJob ? 0 : null),
    createdAt: now,
  });
}

// `reason`: why the pump took it ('asked', 'played', 'new'), kept on the
// row and copied onto its runs.
async function submit(env: Env, e: EpisodeRow, queuedSize: number | null, origin: string, reason: string | null): Promise<string> {
  const now = Date.now();
  const size = e.size_bytes || 0;
  // A row queued for a stitch the episode no longer has gives way to one
  // for the size it has now.
  if (queuedSize != null && queuedSize !== size) {
    await env.DB.prepare("DELETE FROM episode_analysis WHERE episode_id = ? AND size_bytes = ? AND state = 'queued'")
      .bind(e.id, queuedSize).run();
  }
  // The claim is one statement, so two pumps (the cron and a route's
  // waitUntil) can't both start a job: it only inserts while no row is
  // running.
  const claim = await env.DB.prepare(
    `INSERT INTO episode_analysis (episode_id, size_bytes, tenant_id, library_item_id, state, attempts, reason, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'running', 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM episode_analysis WHERE state = 'running')
     ON CONFLICT (episode_id, size_bytes) DO UPDATE SET state = 'running', job_id = NULL,
       attempts = episode_analysis.attempts + 1, reason = COALESCE(excluded.reason, episode_analysis.reason),
       updated_at = excluded.updated_at
     WHERE episode_analysis.state != 'running'`,
  ).bind(e.id, size, e.tenant_id, e.library_item_id, reason, now, now).run();
  if (!claim.meta.changes) return `analysis: ${e.id} not started (a job is in flight)`;
  let jobId: string | null = null;
  try {
    const args = await buildArgs(env, e, origin);
    // wharf's dashboard line for the job: which episode it is.
    const label = [args.show, e.title ?? e.id].filter((x): x is string => !!x && !!x.trim()).join(' \u00b7 ');
    jobId = await runAsync(env, ANALYSIS_PROJECT, ANALYSIS_HANDLER, args, { label });
    await env.DB.prepare('UPDATE episode_analysis SET job_id = ?, error = NULL, updated_at = ? WHERE episode_id = ? AND size_bytes = ?')
      .bind(jobId, Date.now(), e.id, size).run();
    return `analysis: submitted "${e.title ?? e.id}" as ${jobId}`;
  } catch (err) {
    const msg = errMsg(err);
    if (isQuiet(err)) {
      // The Mac asleep (or not routed yet): no attempt spent, the reason kept
      // for /admin, tried again next tick.
      await env.DB.prepare(
        "UPDATE episode_analysis SET state = 'queued', job_id = NULL, attempts = MAX(attempts - 1, 0), error = ?, updated_at = ? WHERE episode_id = ? AND size_bytes = ? AND state = 'running'",
      ).bind(msg, Date.now(), e.id, size).run();
      return `analysis: ${msg} (left queued)`;
    }
    // runAsync refused: no job ran. A job id here means it was accepted and
    // only recording it failed; that job may yet run (and cost).
    await failRow(env, e.id, size, `submit failed: ${msg}`, jobId ? { jobId } : { noJob: true });
    return `analysis: submit failed: ${msg}`;
  }
}

// ─── Following the job in flight ─────────────────────────────────────────────

async function jobFailure(env: Env, job: WharfJob): Promise<string> {
  let detail = job.error ?? job.state;
  try {
    const log = await getJobLog(env, job.id, { tail: 800 });
    const last = log.content.trim().split('\n').filter((l) => l.startsWith('ERR:') || /error/i.test(l)).pop();
    if (last) detail = last.replace(/^ERR:\s*/, '');
  } catch { /* keep job.error */ }
  return `job ${job.state}: ${detail}`;
}

// 'busy' while the job is still going, 'freed' once its row is settled.
// `episode_duration` is podcast_episodes.duration_seconds (the pump joins it).
type RunningRow = AnalysisRow & { episode_duration: number | null };
async function checkRunning(env: Env, r: RunningRow, now: number): Promise<{ busy: boolean; log: string }> {
  const age = now - r.updated_at;
  const lostAfter = lostAfterMs(r.job_id, r.episode_duration);
  const after = `${Math.round(lostAfter / MIN_MS)} min${jobIsland(r.job_id) ? ` on ${jobIsland(r.job_id)}` : ''}`;
  if (!r.job_id) {
    if (age < UNSUBMITTED_AFTER_MS) return { busy: true, log: '' };
    await failRow(env, r.episode_id, r.size_bytes, 'the submit never finished');
    return { busy: false, log: `analysis: ${r.episode_id} claim abandoned` };
  }
  let job: WharfJob;
  try {
    job = await getJob(env, r.job_id);
  } catch (err) {
    // Asleep mid-job: the job freezes with the Mac and /jobs/:id reads only
    // reach its own island. Wait, then give it up as lost.
    if (age > lostAfter) {
      await failRow(env, r.episode_id, r.size_bytes, `${LOST_PREFIX} ${after} (${errMsg(err)})`, { jobId: r.job_id });
      return { busy: false, log: `analysis: ${r.job_id} lost` };
    }
    await env.DB.prepare('UPDATE episode_analysis SET error = ? WHERE episode_id = ? AND size_bytes = ? AND state = ?')
      .bind(errMsg(err), r.episode_id, r.size_bytes, 'running').run();
    return { busy: true, log: '' };
  }
  if (job.state === 'succeeded') {
    // The result POST normally lands first and settles the row; this is
    // the fallback for when it never came.
    const e = await env.DB.prepare('SELECT * FROM podcast_episodes WHERE id = ?').bind(r.episode_id).first<EpisodeRow>();
    try {
      if (!e) throw new AnalysisInputError('the episode is gone');
      await storeResult(env, e, job.result, { jobId: r.job_id });
      return { busy: false, log: `analysis: ${r.job_id} done (from the job)` };
    } catch (err) {
      if (!e) {
        // The run still happened (and may have cost): log it before the
        // rows go.
        const s = nodeStats(job.result);
        await recordRun(env, {
          ...emptyRun({ tenantId: r.tenant_id, episodeId: r.episode_id, libraryItemId: r.library_item_id, outcome: 'error' }),
          ...s, sizeBytes: r.size_bytes || null, jobId: r.job_id, island: jobIsland(r.job_id) ?? s.island,
          error: 'the episode is gone', reason: r.reason ?? null,
        });
        await env.DB.prepare('DELETE FROM episode_analysis WHERE episode_id = ?').bind(r.episode_id).run();
      } else {
        await failRow(env, r.episode_id, r.size_bytes, `the job's result was unusable: ${errMsg(err)}`, { jobId: r.job_id, raw: job.result });
      }
      return { busy: false, log: `analysis: ${r.job_id} result unusable` };
    }
  }
  if (TERMINAL.has(job.state)) {
    await failRow(env, r.episode_id, r.size_bytes, await jobFailure(env, job), { jobId: r.job_id, raw: job.result });
    return { busy: false, log: `analysis: ${r.job_id} ${job.state}` };
  }
  if (age > lostAfter) {
    await cancelJob(env, r.job_id).catch(() => undefined);
    await failRow(env, r.episode_id, r.size_bytes, `${LOST_PREFIX} ${after} (job still ${job.state})`, { jobId: r.job_id });
    return { busy: false, log: `analysis: ${r.job_id} given up after ${after}` };
  }
  return { busy: true, log: '' };
}

// ─── Choosing the next episode ───────────────────────────────────────────────

type Candidate = EpisodeRow & { show_analyse: string | null; queued_size?: number; queued_reason?: string | null };

// The run log's `reason` for each kind of pick: a queued row keeps the one
// it was queued with ("Analyse now" queues 'asked'; an automatic pick that
// found the Mac asleep keeps its own).
async function nextCandidate(env: Env, now: number): Promise<(Candidate & { reason: string }) | null> {
  // 1. Asked for (the "Analyse now" route), or an automatic pick that found
  //    the Mac asleep: oldest first. A restitched episode waits for the
  //    chapter pump's re-probe (chapters_checked_at) like any other, and an
  //    ad-inserting one for its archive in flight (waitsForArchive). Those
  //    with an archive in flight sort last, so a run of them can't push a
  //    ready row out of the batch.
  const queued = await env.DB.prepare(
    `SELECT e.*, p.analyse AS show_analyse, a.size_bytes AS queued_size, a.reason AS queued_reason
       FROM episode_analysis a
       JOIN podcast_episodes e ON e.id = a.episode_id
       JOIN podcasts p ON p.library_item_id = e.library_item_id
      WHERE a.state = 'queued' AND e.chapters_checked_at IS NOT NULL
      ORDER BY COALESCE(e.archive_state IN ('queued', 'fetching'), 0) ASC, a.updated_at ASC LIMIT 25`,
  ).all<Candidate>();
  const q = queued.results.find((e) => !waitsForArchive(e));
  if (q) return { ...q, reason: q.queued_reason ?? 'asked' };

  // 2. Being played, with nothing for the stitch being streamed: results
  //    are a couple of minutes away, so the rest of this listen is right.
  //    CROSS JOIN pins the loop order (SQLite never reorders one), so
  //    idx_progress_user (user_id, last_update) is used per user instead of
  //    a scan of every progress row, every two minutes.
  const played = await env.DB.prepare(
    `SELECT e.*, p.analyse AS show_analyse
       FROM users u
       CROSS JOIN media_progress mp ON mp.user_id = u.id AND mp.last_update > ?
       JOIN podcast_episodes e ON e.id = mp.episode_id
       JOIN podcasts p ON p.library_item_id = e.library_item_id
      WHERE mp.is_finished = 0 AND e.size_bytes > 0 AND e.chapters_checked_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM episode_analysis a WHERE a.episode_id = e.id AND a.size_bytes = e.size_bytes)
      ORDER BY mp.last_update DESC LIMIT 10`,
  ).bind(now - PLAYING_MS).all<Candidate>();
  const p = played.results.find((e) => wantsAnalysis(e, e.show_analyse));
  if (p) return { ...p, reason: 'played' };

  // 3. New episodes on a show, newest first, ready before the first listen.
  //    Shows outer (CROSS JOIN) so idx_episodes_item_published reads only
  //    each show's recent episodes. Not a show nobody follows (migration
  //    0028): nobody is about to listen to it.
  const recent = await env.DB.prepare(
    `SELECT e.*, p.analyse AS show_analyse
       FROM podcasts p
       CROSS JOIN podcast_episodes e ON e.library_item_id = p.library_item_id AND e.in_library = 1 AND e.published_at > ?
      WHERE (p.analyse IS NULL OR p.analyse != 'off') AND e.chapters_checked_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM podcast_follows f WHERE f.library_item_id = p.library_item_id)
        AND NOT EXISTS (SELECT 1 FROM episode_analysis a WHERE a.episode_id = e.id AND a.size_bytes = e.size_bytes)
      ORDER BY e.published_at DESC LIMIT 25`,
  ).bind(now - RECENT_MS).all<Candidate>();
  const n = recent.results.find((e) => wantsAnalysis(e, e.show_analyse));
  return n ? { ...n, reason: 'new' } : null;
}

// Cron (runPodcastTick) and the routes' waitUntil. Without the router
// binding there is nothing to do; the run route answers 503 in that case.
export async function analysisPump(env: Env, opts: { origin?: string } = {}): Promise<string[]> {
  if (!wharfConfigured(env)) return [];
  const log: string[] = [];
  const now = Date.now();
  const running = await env.DB.prepare(
    `SELECT a.*, e.duration_seconds AS episode_duration
       FROM episode_analysis a LEFT JOIN podcast_episodes e ON e.id = a.episode_id
      WHERE a.state = 'running' ORDER BY a.updated_at ASC`,
  ).all<RunningRow>();
  let busy = false;
  for (const r of running.results) {
    const res = await checkRunning(env, r, now);
    if (res.log) log.push(res.log);
    busy ||= res.busy;
  }
  if (busy) return log;
  const next = await nextCandidate(env, now);
  if (next) log.push(await submit(env, next, next.queued_size ?? null, opts.origin ?? analysisOrigin(env), next.reason));
  return log;
}

// "Analyse now": the episode's current stitch, queued (again, if it was
// done or failed). A job in flight for it is left alone.
export async function queueAnalysis(env: Env, e: EpisodeRow): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO episode_analysis (episode_id, size_bytes, tenant_id, library_item_id, state, attempts, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, 'asked', ?, ?)
     ON CONFLICT (episode_id, size_bytes) DO UPDATE SET state = 'queued', attempts = 0, error = NULL, job_id = NULL,
       reason = 'asked', updated_at = excluded.updated_at
     WHERE episode_analysis.state != 'running'`,
  ).bind(e.id, e.size_bytes || 0, e.tenant_id, e.library_item_id, now, now).run();
}

// ─── Storing a result ────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return t || null;
};

export type ParsedResult = {
  size: number;
  duration: number | null;
  offsets: AnalysisOffset[];
  cuts: AnalysisCut[];
  ads: AnalysisAd[];
  generatedChapters: Array<{ start: number; title: string }> | null;
  transcriptSource: 'publisher' | 'whisper' | null;
  whisper: Transcript | null;
  model: string | null;
  llmModel: string | null;
  timings: string | null;
};

// The node's JSON, checked and trimmed: it reaches every client.
export function parseResult(body: unknown, submittedSize: number): ParsedResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AnalysisInputError('the result must be a JSON object');
  const o = body as Record<string, unknown>;
  if (o['ok'] === false) throw new AnalysisInputError(text(o['error'], 300) ?? 'the node reported a failure');
  // wharf's stand-in for a result over 256 KB it no longer holds (GET
  // /jobs/:id inlines the real one while the spill file exists). Read as a
  // result it would store an empty analysis as done.
  if (o['_wharf_result_spilled'] === true) throw new AnalysisInputError('wharf no longer holds the job\'s result (it was spilled to a file that is gone)');
  const sizeRaw = num(o['sizeBytes']) ?? num(o['size']);
  const size = sizeRaw && sizeRaw > 0 ? Math.round(sizeRaw) : submittedSize > 0 ? submittedSize : 0;
  if (!size) throw new AnalysisInputError('sizeBytes (the measured size of the file analysed) is missing');
  const durRaw = num(o['duration']);
  const duration = durRaw && durRaw > 0 ? r3(durRaw) : null;
  const arr = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]) : []);

  const offsets: AnalysisOffset[] = [];
  for (const x of arr('offsets').slice(0, 500)) {
    const r = x as Record<string, unknown>;
    const from = num(r?.['from']), to = num(r?.['to']), shift = num(r?.['shift']);
    if (from != null && to != null && shift != null && to > from) offsets.push({ from: r3(from), to: r3(to), shift: r3(shift) });
  }
  offsets.sort((a, b) => a.from - b.from);
  const cuts: AnalysisCut[] = [];
  for (const x of arr('cuts').slice(0, 500)) {
    const r = x as Record<string, unknown>;
    const from = num(r?.['from']), to = num(r?.['to']);
    if (from != null && to != null && to > from) cuts.push({ from: r3(from), to: r3(to) });
  }
  const ads: AnalysisAd[] = [];
  for (const x of arr('ads').slice(0, 200)) {
    const r = x as Record<string, unknown>;
    const start = num(r?.['start']), end = num(r?.['end']);
    if (start == null || end == null || end <= start || start < 0) continue;
    const kindRaw = typeof r['kind'] === 'string' ? r['kind'].toLowerCase() : '';
    const kind = ['inserted', 'host-read', 'promo'].includes(kindRaw) ? kindRaw : 'other';
    const conf = num(r['confidence']);
    ads.push({
      start: r3(start), end: r3(duration ? Math.min(end, duration) : end), kind,
      confidence: conf == null ? 0.5 : Math.min(1, Math.max(0, Math.round(conf * 100) / 100)),
      source: text(r['source'], 20) ?? 'node',
      label: text(r['label'], 120) ?? text(r['advertiser'], 120) ?? text(r['where'], 40),
    });
  }
  ads.sort((a, b) => a.start - b.start);

  // Chapters in the result are either the publisher's, shifted (served from
  // D1 and mapped here instead, so they follow the next analysis), or
  // generated ones, kept.
  const chs = arr('chapters').slice(0, 200).map((x) => x as Record<string, unknown>);
  const generated = chs.length && chs.every((c) => c?.['source'] !== 'publisher')
    ? chs.map((c) => ({ start: num(c?.['start']), title: text(c?.['title'], 200) }))
      .filter((c): c is { start: number; title: string } => c.start != null && c.start >= 0 && !!c.title)
      .map((c) => ({ start: r3(c.start), title: c.title }))
      .sort((a, b) => a.start - b.start)
    : [];

  const t = o['transcript'] as Record<string, unknown> | null | undefined;
  const src = typeof t?.['source'] === 'string' ? t['source'].toLowerCase() : '';
  let transcriptSource: ParsedResult['transcriptSource'] = null;
  let whisper: Transcript | null = null;
  if (src.startsWith('publisher')) transcriptSource = 'publisher';
  else if (src === 'whisper' && Array.isArray(t?.['cues'])) {
    whisper = whisperTranscript(t['cues'] as unknown[]);
    if (whisper) transcriptSource = 'whisper';
  }

  const llm = o['llm'];
  // A string `llm` is a model name only when the step ran: with no key the
  // handler sets `llm` to "skipped: no OPENROUTER_API_KEY" and `llmError`,
  // which must not be stored as a model.
  const llmModel = text(o['llmModel'], 80) ?? text(o['llm_model'], 80)
    ?? (llm && typeof llm === 'object' ? text((llm as Record<string, unknown>)['model'], 80)
      : o['llmError'] ? null : text(llm, 80));
  let timings: string | null = null;
  if (o['timings'] && typeof o['timings'] === 'object') {
    const j = JSON.stringify(o['timings']);
    if (j.length <= 4000) timings = j;
  }
  return {
    size, duration, offsets, cuts, ads,
    generatedChapters: generated.length ? generated : null,
    transcriptSource, whisper,
    model: text(o['model'], 80), llmModel, timings,
  };
}

export function summaryFromRow(r: AnalysisRow): AnalysisSummary {
  const j = <T>(s: string | null, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };
  return {
    size: r.size_bytes,
    duration: r.duration,
    offsets: j<AnalysisOffset[]>(r.offsets, []),
    cuts: j<AnalysisCut[]>(r.cuts, []),
    ads: j<AnalysisAd[]>(r.ads, []),
    chapters: j<Array<{ start: number; title: string }> | null>(r.chapters, null),
    transcript: r.transcript_source === 'publisher' || r.transcript_source === 'whisper' ? r.transcript_source : null,
    at: r.updated_at,
  };
}

// Store one result: the row under the measured size, a speech-recognition
// transcript in R2, and (when it describes the file served now) the
// episode's summary and length. Idempotent: a late duplicate of a job that
// was given up on just stores the same thing again.
export async function storeResult(env: Env, e: EpisodeRow, body: unknown, opts: { jobId?: string | null } = {}): Promise<{ size: number; current: boolean }> {
  const r = parseResult(body, e.size_bytes);
  const now = Date.now();
  // The job this answers and why it ran. The node's POST names no job, so it
  // is the episode's row in flight, whatever its size: the node stores under
  // the size it measured, which differs from the one submitted when the
  // publisher restitched (until 2026-10-13 such a row lost its job id).
  const prior = (await env.DB.prepare('SELECT size_bytes, state, job_id, reason FROM episode_analysis WHERE episode_id = ?')
    .bind(e.id).all<Pick<AnalysisRow, 'size_bytes' | 'state' | 'job_id' | 'reason'>>()).results;
  const running = prior.find((p) => p.state === 'running') ?? null;
  const jobId = opts.jobId ?? running?.job_id ?? null;
  const reason = (jobId ? prior.find((p) => p.job_id === jobId)?.reason : null)
    ?? running?.reason ?? prior.find((p) => p.size_bytes === r.size)?.reason ?? null;
  let transcriptKey: string | null = null;
  if (r.whisper) {
    transcriptKey = transcriptKeyFor(e.id, r.size);
    await env.COVERS.put(transcriptKey, JSON.stringify(r.whisper), { httpMetadata: { contentType: 'application/json' } });
  }
  const json = (v: unknown) => JSON.stringify(v);
  await env.DB.batch([
    // The job this answers: its row may be keyed by the size known when it
    // was submitted (0 for a file never streamed yet).
    env.DB.prepare("DELETE FROM episode_analysis WHERE episode_id = ? AND size_bytes != ? AND state = 'running'").bind(e.id, r.size),
    env.DB.prepare(
      `INSERT INTO episode_analysis (episode_id, size_bytes, tenant_id, library_item_id, state, job_id, attempts, error, duration, model, llm_model,
         offsets, cuts, ads, chapters, transcript_source, transcript_key, timings, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'done', ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (episode_id, size_bytes) DO UPDATE SET state = 'done', job_id = COALESCE(excluded.job_id, episode_analysis.job_id),
         reason = COALESCE(excluded.reason, episode_analysis.reason),
         error = NULL, duration = excluded.duration, model = excluded.model, llm_model = excluded.llm_model,
         offsets = excluded.offsets, cuts = excluded.cuts, ads = excluded.ads, chapters = excluded.chapters,
         transcript_source = excluded.transcript_source, transcript_key = excluded.transcript_key, timings = excluded.timings,
         updated_at = excluded.updated_at`,
    ).bind(
      e.id, r.size, e.tenant_id, e.library_item_id, jobId, r.duration, r.model, r.llmModel,
      json(r.offsets), json(r.cuts), json(r.ads), r.generatedChapters ? json(r.generatedChapters) : null,
      r.transcriptSource, transcriptKey, r.timings, reason, now, now,
    ),
  ]);
  // The run log: once per job, whichever of the POST and the pump stores it
  // first (recordRun dedupes and never throws).
  await recordRun(env, doneRun(
    { tenantId: e.tenant_id, episodeId: e.id, libraryItemId: e.library_item_id, showTitle: null, episodeTitle: e.title, jobId, reason },
    jobIsland(jobId), r, body,
  ));

  // The episode as it is now (the stream route may have recorded a new
  // size while the job ran).
  const cur = await env.DB.prepare('SELECT size_bytes, analysis, duration_seconds FROM podcast_episodes WHERE id = ?')
    .bind(e.id).first<{ size_bytes: number; analysis: string | null; duration_seconds: number }>();
  const curSize = cur?.size_bytes || 0;
  const current = !curSize || curSize === r.size;
  await pruneRows(env, e.id, curSize || r.size);

  const summary: AnalysisSummary = {
    size: r.size, duration: r.duration, offsets: r.offsets, cuts: r.cuts, ads: r.ads,
    chapters: r.generatedChapters, transcript: r.transcriptSource, at: now,
  };
  let existing: AnalysisSummary | null = null;
  try { existing = cur?.analysis ? JSON.parse(cur.analysis) as AnalysisSummary : null; } catch { existing = null; }
  const sets: string[] = [];
  const binds: unknown[] = [];
  // The summary column holds the analysis of the file served now when there
  // is one; a result for another stitch replaces it only when it doesn't.
  if (current || !existing || existing.size !== curSize) { sets.push('analysis = ?'); binds.push(json(summary)); }
  // A file never streamed: the node's download went through the stream
  // route, so this is the size it serves.
  if (!curSize) { sets.push('size_bytes = ?'); binds.push(r.size); }
  // The measured length wins over the feed's (and an estimate's).
  if (current && r.duration) {
    sets.push('duration_measured = 1');
    if (Math.abs(r.duration - (cur?.duration_seconds || 0)) > 2) { sets.push('duration_seconds = ?'); binds.push(r.duration); }
  }
  if (sets.length) await env.DB.prepare(`UPDATE podcast_episodes SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, e.id).run();
  return { size: r.size, current };
}

// The newest two rows per episode, plus the one for the size served now.
async function pruneRows(env: Env, episodeId: string, keepSize: number): Promise<void> {
  const rows = (await env.DB.prepare(
    'SELECT size_bytes, state, transcript_key FROM episode_analysis WHERE episode_id = ? ORDER BY updated_at DESC',
  ).bind(episodeId).all<{ size_bytes: number; state: string; transcript_key: string | null }>()).results;
  const drop = rows.slice(KEEP_ROWS).filter((r) => r.size_bytes !== keepSize && r.state !== 'running');
  if (!drop.length) return;
  await env.DB.batch(drop.map((r) => env.DB.prepare('DELETE FROM episode_analysis WHERE episode_id = ? AND size_bytes = ?').bind(episodeId, r.size_bytes)));
  const kept = new Set(rows.filter((r) => !drop.includes(r)).map((r) => r.transcript_key));
  const keys = drop.map((r) => r.transcript_key).filter((k): k is string => !!k && !kept.has(k));
  if (keys.length) await env.COVERS.delete(keys).catch(() => undefined);
}

// The stream route saw the publisher serve another size: if that stitch was
// analysed before (a listener flipping between two), its analysis becomes
// the episode's again.
export async function adoptAnalysisForSize(env: Env, episodeId: string, size: number): Promise<void> {
  const row = await env.DB.prepare("SELECT * FROM episode_analysis WHERE episode_id = ? AND size_bytes = ? AND state = 'done'")
    .bind(episodeId, size).first<AnalysisRow>();
  if (!row) return;
  const sets = ['analysis = ?'];
  const binds: unknown[] = [JSON.stringify(summaryFromRow(row))];
  if (row.duration && row.duration > 0) { sets.push('duration_seconds = ?', 'duration_measured = 1'); binds.push(row.duration); }
  await env.DB.prepare(`UPDATE podcast_episodes SET ${sets.join(', ')} WHERE id = ? AND size_bytes = ?`).bind(...binds, episodeId, size).run();
}

// ─── Reading ─────────────────────────────────────────────────────────────────

function rowJson(r: AnalysisRow) {
  return {
    size: r.size_bytes, state: r.state, attempts: r.attempts, error: r.error, jobId: r.job_id, island: jobIsland(r.job_id), reason: r.reason ?? null,
    duration: r.duration, model: r.model, llmModel: r.llm_model, transcriptSource: r.transcript_source,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// GET …/analysis: where the episode's analysis stands. `state` is the row
// for the size served now, else one waiting or running for it.
// `waitingFor: 'archive'` while a queued row is held for the pCloud copy.
export async function analysisStatus(env: Env, e: EpisodeRow) {
  const rows = (await env.DB.prepare('SELECT * FROM episode_analysis WHERE episode_id = ? ORDER BY updated_at DESC')
    .bind(e.id).all<AnalysisRow>()).results;
  const current = rows.find((r) => r.size_bytes === e.size_bytes)
    ?? rows.find((r) => r.state === 'running' || r.state === 'queued') ?? null;
  const a = currentAnalysis(e);
  return {
    configured: wharfConfigured(env),
    currentSize: e.size_bytes,
    state: current?.state ?? null,
    waitingFor: current?.state === 'queued' && waitsForArchive(e) ? 'archive' as const : null,
    current: current ? rowJson(current) : null,
    rows: rows.map(rowJson),
    analysis: analysisField(e, a, servedChapters(e, a).source),
  };
}

// The whisper transcript of the file served now, when its analysis made one.
export async function whisperTranscriptFor(env: Env, e: EpisodeRow): Promise<Transcript | null> {
  const a = currentAnalysis(e);
  if (a?.transcript !== 'whisper') return null;
  const obj = await env.COVERS.get(transcriptKeyFor(e.id, a.size));
  if (!obj) return null;
  try { return await obj.json() as Transcript; } catch { return null; }
}
