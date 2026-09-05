# abbcrawl / abbcovers — catalogue work off the Worker

Two wharf projects that take work off Cloudflare's shared egress (and off
Joseph's laptop). **Two projects, not one**, so a small box can run the cheap
half and skip the expensive one:

| Project · service | What it does | Cost | Why not in the Worker / on the Mac |
|---|---|---|---|
| `abbcrawl` · `abb-detail-crawler` | Claims batches of un-fetched ABB posts from the shim, fetches each detail page, posts the HTML back for the Worker to parse | stdlib only, ~15 MB RSS | The cron tick shares Cloudflare egress with the shim's live ABB search, so it can only afford ~1 page/min — 10k pending posts is a week |
| `abbcovers` · `abb-covers` | Downloads catalogue covers, fits them into a 500 px webp, PUTs them to the shim (R2) | Pillow, hundreds of MB peak | Workers can't resize images and CF transformations would cost ~$20 for the catalogue; this was `ABB Covers.command` on the Mac |

## Memory — read this before deploying abbcovers

wharfd runs every project's services **inside its own systemd cgroup**, and
the cap differs per box:

```sh
ssh <host> "systemctl show wharfd -p MemoryMax -p MemoryCurrent"
# stereo-nz    536870912  (512 MB)   ← raised 2026-09-03; runs both, peaks ~103 MB
# stereo-au    536870912  (512 MB)   ← raised 2026-09-03
# wharf-syd-1  469762048  (448 MB)
# incrediblepbx 134217728 (128 MB)   ← correct: that box really has 451 MB
```

Deploying both to stereo-nz on 2026-09-03 OOM-killed wharfd **75 times in an
hour** — and every kill restarted that node's other services too (netprobe,
and cfpbx-stereo's ESL forwarder). The cap was 128 MB on a box with 7.3 GB of
RAM: wharf's installer ships one profile sized for the 450 MB PBX VPS, and
both stereo boxes inherited it. Both are now 512 MB via a drop-in:

```
/etc/systemd/system/wharfd.service.d/20-memory.conf
[Service]
MemoryMax=512M
```

A drop-in rather than an edit to the shipped unit, so a wharf update keeps it
and `rm` on that one file reverts. `GOMEMLIMIT=64MiB` in the shipped unit is
Go's soft target for wharfd's own heap and is deliberately left alone — the
headroom is for the services wharfd supervises. Note that *job* handlers are
capped separately (`systemd-run --scope`, e.g. audible's `max_memory_mb`), so
they don't spend this budget; `[[services]]` processes do.

The shim routes they use: `POST /api/admin/abb/catalog/details/{claim,submit}`
(owner-only) and `GET/PUT /api/admin/abb/catalog/covers/*`.

## Nodes

As of 2026-09-05 **stereo-nz** (`core@100.111.229.12`, FCOS — `sudo`) and
**wharf-syd-1** (`root@100.65.13.50`) each run **both** projects; they are
cover shards 0 and 1 of 2.

**Not stereo-au** — and not for the reason it first looked. ABB does not
geo-block Australia: wharf-syd-1 is in Sydney and fetches fine, DNS resolves
identically everywhere, and the `audiobookbay.li` mirror on another IP
completes TLS from home. What is blocked is the single pair
`49.179.117.247 → 176.97.124.219` (SYNs dropped on 80 and 443) — Joseph's
home WAN IP, which stereo-au shares with his Mac, firewalled by ABB after a
burst on 2026-09-02 and still blocked days later. So an ABB ban is
long-lived, and stereo-au can never crawl from that line — though it could
resize covers, which never touch ABB.

Test any new node with **one** `curl -A '<browser UA>'
https://audiobookbay.lu/` before adding it. Never loop-probe: that burst
(≈50 pages in 3 min) is what earned the ban.

## Not competing

- **Detail pages** are leased. `claim` hands out rows with an expiry
  (10 min), so two nodes never hold the same post and a node that dies
  returns its rows automatically. Nodes take the **oldest** pending posts;
  the Worker's cron takes the **newest** and skips leased rows, so the two
  only meet when the backfill is done.
- **Covers** are partitioned by `id % ABS_SHIM_SHARDS == ABS_SHIM_SHARD`, so
  extra runners can be added without resizing anything twice. No lease: the
  partition is fixed, and a duplicate PUT would waste a download, not corrupt
  anything. Both nodes run it as of 2026-09-03 (nz = shard 0, syd = shard 1):
  one runner stopped keeping up once the listing backfill started adding ~30
  posts a minute, each with a cover. An unsharded Mac run alongside them
  duplicates the work.
- Pacing is per node: `PACE_SECONDS=8` ≈ 7 pages/min each, well under the
  rate that got an IP firewalled. Three consecutive failures and a node
  hands its batch back and sleeps 30 min, doubling to 6 h.

## Deploy

```sh
./deploy.sh abbcrawl  core@100.111.229.12    # stereo-nz
./deploy.sh abbcrawl  root@100.65.13.50      # wharf-syd-1
./deploy.sh abbcovers root@100.65.13.50      # syd only — see Memory above
```

Copies `project.toml` and the handlers, and for `abbcovers` the shim repo's
`scripts/abb-covers.py` (copied, never forked — the Mac and the node run the
same file) plus the venv Pillow needs, then reloads wharfd.

Then the credentials, which deliberately never live in this repo — copy
`env.example`, fill in the shim owner account and the node's shard, and:

```sh
scp <proj>.env <host>:/tmp/<proj>.env
ssh <host> "sudo install -o wharf -g wharf -m 600 /tmp/<proj>.env \
  /srv/wharf/projects/<proj>/.env && rm -f /tmp/<proj>.env && \
  sudo /srv/wharf/bin/wharf reload-projects"
```

`SHIM_USER` must be the tenant **owner** for `abbcrawl`: `claim`/`submit` are
owner-only, since a submission becomes catalogue content every tenant sees.
`abbcovers` only needs a member (the cover routes aren't owner-gated).

## Watching it

```sh
ssh <host> "sudo journalctl -u wharfd -f | grep -E 'abbcrawl|abbcovers'"
```

Per-node totals also show in /admin's "AudioBookBay catalogue" card
(`Node stereo-nz: 1,234 detail pages, 1,180 with a magnet · last seen 12s ago`),
fed by `abb_crawl` rows keyed `node:<name>`.
