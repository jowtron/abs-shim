-- Who added which Real-Debrid torrent (2026-09-05).
--
-- One RD account serves a whole tenant (the owner's token), so the torrent
-- list on RD is everyone's grabs mixed together. Members who are allowed to
-- add books (tenant setting members_can_add) get to see, watch and delete
-- only the torrents they added themselves; the owner sees everything. RD
-- expires torrents on its own, so rows are pruned whenever a listing no
-- longer contains them — there is no other cleanup path.
CREATE TABLE rd_torrents (
  tenant_id  TEXT NOT NULL,
  torrent_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, torrent_id)
);
