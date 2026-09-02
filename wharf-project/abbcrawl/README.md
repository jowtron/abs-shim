# abbcrawl — ABB detail pages + catalogue covers, off the Worker

Two long-running wharf services that take work off Cloudflare's shared
egress (and off Joseph's laptop):

| Service | What it does | Why not in the Worker / on the Mac |
|---|---|---|
| `abb-detail-crawler` | Claims batches of un-fetched ABB posts from the shim, fetches each detail page, posts the HTML back for the Worker to parse | The cron tick shares Cloudflare egress with the shim's live ABB search, so it can only afford ~1 page/min — 10k pending posts is a week |
| `abb-covers` | Downloads catalogue covers, fits them into a 500 px webp, PUTs them to the shim (R2) | Workers can't resize images and CF transformations would cost ~$20 for the catalogue; this was `ABB Covers.command` on the Mac |

The shim routes they use: `POST /api/admin/abb/catalog/details/{claim,submit}`
(owner-only) and `GET/PUT /api/admin/abb/catalog/covers/*`.

## Nodes

Deployed 2026-09-03 to **stereo-nz** (`core@100.111.229.12`) and
**wharf-syd-1** (`root@100.65.13.50`).

**Not stereo-au.** ABB drops that AU consumer range at TCP level — a single
curl never completes the handshake, while both other nodes answered 200 in
~2 s. Test any new node with **one** `curl -A '<browser UA>'
https://audiobookbay.lu/` before adding it. Never loop-probe: ABB firewalls
an IP that bursts (≈50 pages in 3 min got the dev Mac dropped, 2026-09-02).

## Not competing

- **Detail pages** are leased. `claim` hands out rows with an expiry
  (10 min), so two nodes never hold the same post and a node that dies
  returns its rows automatically. Nodes take the **oldest** pending posts;
  the Worker's cron takes the **newest** and skips leased rows, so the two
  only meet when the backfill is done.
- **Covers** are partitioned by `id % ABS_SHIM_SHARDS == ABS_SHIM_SHARD`
  (nz = 0, syd = 1). No lease: the partition is fixed, and a duplicate PUT
  would waste a download, not corrupt anything.
- Pacing is per node: `PACE_SECONDS=8` ≈ 7 pages/min each, well under the
  rate that got an IP firewalled. Three consecutive failures and a node
  hands its batch back and sleeps 30 min, doubling to 6 h.

## Deploy

```sh
./deploy.sh core@100.111.229.12      # stereo-nz
./deploy.sh root@100.65.13.50        # wharf-syd-1
```

Copies `project.toml`, `handlers/abb-detail-crawler.py` and the shim repo's
`scripts/abb-covers.py` (copied, never forked — the Mac and the nodes run
the same file), builds the venv Pillow needs, and reloads wharfd.

Then the credentials, which deliberately never live in this repo — copy
`env.example`, fill in the shim owner account and the node's shard, and:

```sh
scp abbcrawl.env <host>:/tmp/abbcrawl.env
ssh <host> "sudo install -o wharf -g wharf -m 600 /tmp/abbcrawl.env \
  /srv/wharf/projects/abbcrawl/.env && rm -f /tmp/abbcrawl.env && \
  sudo /srv/wharf/bin/wharf reload-projects"
```

`SHIM_USER` must be the tenant **owner**: `claim`/`submit` are owner-only,
since a submission becomes catalogue content every tenant sees.

## Watching it

```sh
ssh <host> "sudo journalctl -u wharfd -f | grep abbcrawl"
```

Per-node totals also show in /admin's "AudioBookBay catalogue" card
(`Node stereo-nz: 1,234 detail pages, 1,180 with a magnet · last seen 12s ago`),
fed by `abb_crawl` rows keyed `node:<name>`.
