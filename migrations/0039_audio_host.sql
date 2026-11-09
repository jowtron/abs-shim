-- Which host an episode's audio comes from, and what each analysis found
-- (2026-11-10). Evidence for the home-fetch idea: does the stitch depend on
-- the host and on where it was fetched from? See src/lib/audio-host.ts.
--
-- audio_host: the company label ('Megaphone', 'PRX', or a self-hosted
-- registrable domain); audio_host_url_host: the hostname the redirect chain
-- really ended at. Both written by a fetch that saw the end of the chain
-- (the stream route, a hold download, an archive pull); NULL until then, and
-- the wire falls back to naming the enclosure's host.
ALTER TABLE podcast_episodes ADD COLUMN audio_host TEXT;
ALTER TABLE podcast_episodes ADD COLUMN audio_host_url_host TEXT;
-- /admin's "Ads by host" counts observed episodes per host without
-- reading the rest.
CREATE INDEX podcast_episodes_audio_host ON podcast_episodes(tenant_id, audio_host) WHERE audio_host IS NOT NULL;

-- One row per analysed file (episode + size, i.e. one stitch), written by
-- storeResult; never pruned with episode_analysis. fetched_via: who
-- downloaded the bytes from the publisher: 'worker' (streamed or held
-- through this Worker, Cloudflare's egress), 'pcloud' (an archived copy,
-- pulled by pCloud from its own servers), later 'home'.
CREATE TABLE episode_ad_observations (
  episode_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  library_item_id TEXT NOT NULL,
  fetched_via TEXT NOT NULL,
  host TEXT,
  final_host TEXT,
  inserted_ads INTEGER NOT NULL,
  inserted_seconds REAL NOT NULL,
  ads_total INTEGER NOT NULL,
  analysed_at INTEGER NOT NULL,
  PRIMARY KEY (episode_id, size_bytes)
);
CREATE INDEX episode_ad_observations_tenant ON episode_ad_observations(tenant_id, analysed_at);

-- The analyses already made. Their host is unknown here (the label is
-- computed in code); the report names it from the episode.
INSERT OR IGNORE INTO episode_ad_observations
  (episode_id, size_bytes, tenant_id, library_item_id, fetched_via, host, final_host, inserted_ads, inserted_seconds, ads_total, analysed_at)
SELECT a.episode_id, a.size_bytes, a.tenant_id, a.library_item_id,
  CASE WHEN e.archive_state = 'done' AND e.size_bytes = a.size_bytes THEN 'pcloud' ELSE 'worker' END,
  NULL, NULL,
  (SELECT count(*) FROM json_each(COALESCE(a.ads, '[]')) j WHERE json_extract(j.value, '$.kind') = 'inserted'),
  COALESCE((SELECT sum(json_extract(j.value, '$.end') - json_extract(j.value, '$.start')) FROM json_each(COALESCE(a.ads, '[]')) j
    WHERE json_extract(j.value, '$.kind') = 'inserted'), 0),
  (SELECT count(*) FROM json_each(COALESCE(a.ads, '[]'))),
  a.updated_at
FROM episode_analysis a JOIN podcast_episodes e ON e.id = a.episode_id
WHERE a.state = 'done' AND a.size_bytes > 0;
