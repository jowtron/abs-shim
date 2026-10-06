-- When an episode counts as played (2026-10-07). ABS marks media finished
-- when the time left drops under its library's markAsFinishedTimeRemaining
-- (default 10 s, kept in libraries.settings). A show with a long outro or
-- end-of-episode ads wants more, so each show can carry its own; NULL means
-- "use the library's" (src/db/podcasts.ts episodeFinishRemaining).
ALTER TABLE podcasts ADD COLUMN finish_remaining_seconds INTEGER;
