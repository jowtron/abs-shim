-- Every new episode a feed lists lands on the show (2026-10-13). ABS's
-- default of 3 per check protects disk; here "on the show" costs nothing,
-- and the cap hid episodes 1-5 of a serial's 8-episode drop, or a day of a
-- news feed after a backoff. 0 = no cap (what the poller already treats it as).
UPDATE podcasts SET max_new_episodes_to_download = 0 WHERE max_new_episodes_to_download = 3;
