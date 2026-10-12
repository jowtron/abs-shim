-- Episode analysis (2026-10-13): a wharf job (project podcast-transcribe,
-- handler analyse_episode, on Joseph's Mac) transcribes an episode exactly as
-- this shim serves it, maps the publisher's chapter and transcript times onto
-- that file, marks inserted ads, and writes a transcript and chapters for
-- shows that publish none. See src/lib/episode-analysis.ts and
-- wharf-project/podcast-transcribe/README.md.
--
-- Keyed by (episode, byte size): ad-inserting hosts restitch an episode as
-- campaigns change, and a result describes one stitch only. The newest two
-- rows per episode are kept (a listener can flip between two stitches).
CREATE TABLE episode_analysis (
  episode_id        TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  size_bytes        INTEGER NOT NULL,           -- the stitch this describes (0 = not known when queued)
  tenant_id         TEXT NOT NULL,
  library_item_id   TEXT NOT NULL,              -- the show, for /admin's per-show counts
  state             TEXT NOT NULL,              -- queued | running | done | error
  job_id            TEXT,                       -- wharf-router job id (<island>.<uuid>)
  attempts          INTEGER NOT NULL DEFAULT 0,
  error             TEXT,                       -- the last problem (also on a queued row: "the Mac is asleep")
  duration          REAL,                       -- the served file's length, measured by the node
  model             TEXT,                       -- whisper model
  llm_model         TEXT,
  offsets           TEXT,                       -- JSON [{from,to,shift}] master ranges; served = master + shift
  cuts              TEXT,                       -- JSON [{from,to}] master audio the served file lacks
  ads               TEXT,                       -- JSON [{start,end,kind,confidence,source,label}] served time
  chapters          TEXT,                       -- JSON [{start,title}] GENERATED chapters only (publisher ones are mapped when served)
  transcript_source TEXT,                       -- 'publisher' (aligned) | 'whisper' | NULL
  transcript_key    TEXT,                       -- R2 (COVERS) transcripts/<episode>/<size>.json, whisper transcripts only
  timings           TEXT,                       -- JSON, the node's own timings
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (episode_id, size_bytes)
);
CREATE INDEX idx_analysis_state ON episode_analysis(state, updated_at);
CREATE INDEX idx_analysis_show ON episode_analysis(library_item_id);

-- Per show: NULL = auto (a dynamic-ads host, or episodes without chapters or
-- a transcript), 'on', 'off'.
ALTER TABLE podcasts ADD COLUMN analyse TEXT;

-- The episode's newest finished analysis, summarised (size, duration,
-- offsets, cuts, ads, generated chapters, transcript source), so every list
-- that selects episodes carries it without a join. Served only while its
-- size equals the episode's size_bytes.
ALTER TABLE podcast_episodes ADD COLUMN analysis TEXT;

-- 1 once duration_seconds holds a length measured from the file (the chapter
-- probe, or an analysis), which a feed's itunes:duration must not overwrite.
-- Until now every poll that listed an episode put the feed's number back:
-- LINUX Unplugged 688 was probed at 4440.555 s and back at the feed's 4833 s
-- an hour later.
ALTER TABLE podcast_episodes ADD COLUMN duration_measured INTEGER NOT NULL DEFAULT 0;

-- Probe every episode on a show again so the flag is set and the lengths the
-- feed overwrote are measured once more.
UPDATE podcast_episodes SET chapters_checked_at = NULL WHERE in_library = 1;
