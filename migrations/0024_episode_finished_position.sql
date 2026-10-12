-- Where the listener was in an episode when it was marked played (see
-- "Played, and played again" in src/db/progress.ts). A later progress write
-- well BEFORE it is a replay and un-marks the episode, as Pocket Casts does;
-- a write after it is the same listen carrying on (a "Mark played" on the
-- episode that is still playing) and leaves the mark alone. NULL while the
-- episode is unplayed.
ALTER TABLE media_progress ADD COLUMN finished_position REAL;

-- Rows already played: the position they hold is the best there is (the
-- end, for one that played out or was marked from a list; the position a
-- "Mark played" mid-listen has synced to since).
UPDATE media_progress SET finished_position = current_time_seconds
 WHERE is_finished = 1 AND episode_id IS NOT NULL;
