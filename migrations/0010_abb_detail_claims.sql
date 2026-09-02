-- Detail-page backfill farmed out to wharf nodes (2026-09-03).
--
-- The cron crawler can only fetch ~1 detail page/min from Cloudflare's
-- shared egress, so 10k pending posts would take a week. Nodes with their
-- own IPs (stereo-nz, wharf-syd-1 — stereo-au can't reach ABB at all, its
-- consumer range is blocked at TCP level) claim batches over the API and
-- post the HTML back for the shim to parse, so the markup parser stays in
-- exactly one place.
--
-- A claim is a lease, not an assignment: detail_claim_until is when it
-- lapses, so a node that dies mid-batch (or a closed tab) returns its rows
-- to the pool without any cleanup path. Both the lease check and the
-- crawler's own detail pass filter on it, so no two fetchers take the same
-- post while it's live.
ALTER TABLE abb_posts ADD COLUMN detail_claim_by TEXT;
ALTER TABLE abb_posts ADD COLUMN detail_claim_until INTEGER;
-- The claim query is "pending, unclaimed, oldest first" (nodes work up from
-- the oldest end while the cron works down from the newest, so the two only
-- meet when the backfill is done).
CREATE INDEX abb_posts_detail_pending ON abb_posts(posted_ts, id) WHERE detail_fetched_at IS NULL;
