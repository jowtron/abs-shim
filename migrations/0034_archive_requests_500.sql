-- Two changes of 2026-10-21 (Joseph: "Archive all" should mean all, show
-- me how it's going, and tell me when it's done).
--
-- 1. Whoever presses "Archive all" is told when the copying ends: one row
--    per show and person while their request is under way. archivePump's
--    last step (announceArchiveDone) finds requests whose show has nothing
--    queued or fetching any more, deletes the row and sends a push.
--    `queued` is how many copies the request covers: what it queued plus
--    what was already on its way for the show (a second press while it is
--    open adds only episodes never tried), the number the notice reports.
CREATE TABLE archive_requests (
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  requested_at    INTEGER NOT NULL,
  queued          INTEGER NOT NULL,
  PRIMARY KEY (library_item_id, user_id)
);

-- 2. A new show now gets an episodic feed's newest 500 episodes, not 100
--    (INITIAL_EPISODES). Existing shows get the same now: the newest 500 of
--    every episodic show go on the show, except episodes the owner removed
--    (`removed`, which the poller never re-adds) and shows that keep only
--    their newest N (`max_episodes_to_keep`, trimShow's). A serial show
--    already has its first 500. Per-person hidden episodes stay hidden
--    (podcast_episode_hidden). An UPDATE, so no new-episode push, and
--    nothing is queued for archiving; the chapter pump checks the newly
--    added episodes, 15 per tick.
UPDATE podcast_episodes SET in_library = 1
 WHERE in_library = 0 AND removed = 0
   AND id IN (
     SELECT id FROM (
       SELECT e.id, ROW_NUMBER() OVER (PARTITION BY e.library_item_id ORDER BY e.published_at DESC, e.idx DESC) AS rn
         FROM podcast_episodes e
         JOIN podcasts p ON p.library_item_id = e.library_item_id
        WHERE e.removed = 0 AND COALESCE(p.podcast_type, '') <> 'serial' AND p.max_episodes_to_keep = 0
     ) WHERE rn <= 500
   );
