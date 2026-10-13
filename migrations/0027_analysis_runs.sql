-- Episode analysis run log (2026-10-13). Joseph asked for "records kept of
-- what's being transcribed, analysed and what it's costing". episode_analysis
-- can't be that record: it keeps the newest two rows per episode (one per
-- stitch) and drops the node's stats, so a run's cost and tokens were lost
-- the moment it was stored. This table is append-only: one row per finished
-- attempt, done or failed, written where a result is stored (the node's POST
-- or the pump reading the finished job) and where an attempt fails or is
-- given up. Never pruned. See src/lib/analysis-runs.ts.
--
-- No foreign keys on purpose: the record of a run (and what it cost) outlives
-- the episode and the show, so the titles are copied in when it is written.
CREATE TABLE analysis_runs (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  episode_id         TEXT NOT NULL,
  library_item_id    TEXT NOT NULL,          -- the show
  show_title         TEXT,
  episode_title      TEXT,
  size_bytes         INTEGER,                -- the stitch analysed (the node's measured size on success)
  job_id             TEXT,                   -- wharf-router job id (<island>.<uuid>); NULL when no job ran
  island             TEXT,                   -- 'mac' | 'stereo-au' | …
  outcome            TEXT NOT NULL,          -- done | error
  error              TEXT,
  reason             TEXT,                   -- asked (Analyse now) | played | new | NULL = unknown
  audio_seconds      REAL,
  whisper_model      TEXT,
  whisper_backend    TEXT,
  whisper_seconds    REAL,
  total_seconds      REAL,
  transcript_source  TEXT,                   -- publisher (aligned) | whisper | NULL
  aligned            INTEGER,                -- 1 when the publisher's times were mapped onto the file
  ads_count          INTEGER,
  chapters_generated INTEGER,
  llm                TEXT,                   -- ok | skipped | error | NULL (no model call asked for)
  llm_model          TEXT,
  tokens_in          INTEGER,
  tokens_out         INTEGER,
  tokens_reasoning   INTEGER,
  cost_usd           REAL,                   -- OpenRouter's own figure; NULL = not known
  created_at         INTEGER NOT NULL        -- when the attempt finished or was given up
);
CREATE INDEX idx_analysis_runs_tenant ON analysis_runs(tenant_id, created_at);
CREATE INDEX idx_analysis_runs_show ON analysis_runs(library_item_id, created_at);
-- The duplicate check (one result can arrive by POST and by the pump) and a
-- late result for a job given up as lost look runs up by episode.
CREATE INDEX idx_analysis_runs_episode ON analysis_runs(episode_id, created_at);
-- One row per job: the POST and the pump reading the same finished job race.
CREATE UNIQUE INDEX idx_analysis_runs_job ON analysis_runs(job_id) WHERE job_id IS NOT NULL;

-- Why the pump took a row: 'asked' (Analyse now), 'played' (listened to in
-- the last 2 h), 'new' (a recent episode on the show). Set when the row is
-- claimed (or queued by Analyse now) and copied onto its runs.
ALTER TABLE episode_analysis ADD COLUMN reason TEXT;
