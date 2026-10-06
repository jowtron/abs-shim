# pcloud-health: watching rclone's pCloud token

One rclone pCloud token is shared by every box in `nodes.conf`: wharf-syd-1 (eastsidefm uploads) and stereo-au (the Audible sync). On 2026-10-05 pCloud revoked it (error 2095) and nothing said so. eastsidefm reported "Upload complete" while losing three episodes, and the Audible sync downloaded titles only to fail at the pCloud step.

## What runs where

- **On each node**, `pcloud-health.timer` (hourly, randomised by up to 10 min) runs `/usr/local/bin/pcloud-health` as `wharf`. It runs `rclone about pcloud:` with that node's config and posts the outcome to the shim, `POST /api/node-health`, authenticated by the `NODE_HEALTH_KEY` secret (copied in `/etc/pcloud-health.env`, root 600).
- **The shim** (`src/lib/node-health.ts`) decides what the output means and sends the Pushover. The nodes hold no Pushover keys. State is one `server_settings` row per node, `node_health:pcloud-rclone:<node>`.
  - A revoked or invalid token (pCloud 1000, 2000, 2094, 2095) pushes at once, with the fix. It pushes again every 12 h while it lasts.
  - Any other failure (DNS, network) pushes after three hourly checks in a row.
  - A node with no report for 3 h pushes too: a dead timer would otherwise look like a healthy token.
  - The first good report after any of those pushes "OK again".
- **The Audible sync** checks pCloud itself before downloading anything (`userinfo` with the same token), and stops the run at the first pCloud auth error instead of downloading every remaining title first.

## Fixing a revoked token

```sh
ops/pcloud-health/pcloud-reauth.sh            # every node in nodes.conf
ops/pcloud-health/pcloud-reauth.sh stereo-au  # just one
```

This opens pCloud's sign-in in the browser (`rclone authorize pcloud`). On each node it then:

- replaces only the `token =` line of `[pcloud]`, in place, keeping owner, mode and `hostname =` (the old file is kept as `rclone.conf.bak-reauth`);
- checks the token with `rclone about pcloud:`;
- runs the health check, so the shim sends "OK again".

The token travels on ssh's stdin and is never printed. This Mac's own `[pcloud]` remote is not touched.

## Installing or changing it

```sh
ops/pcloud-health/deploy.sh                       # update script and units on every node, keep each node's key
ops/pcloud-health/deploy.sh stereo-au             # one node
ops/pcloud-health/deploy.sh --key-file F [node]   # first install, or after rotating NODE_HEALTH_KEY
```

A new node: add a line to `nodes.conf`, then deploy to it with `--key-file`. The key can't be read back from Cloudflare, so either copy it from an existing node's `/etc/pcloud-health.env` into a temporary file, or rotate it: generate a new one, `npx wrangler secret put NODE_HEALTH_KEY < F`, then `deploy.sh --key-file F` to all nodes. Delete `F` afterwards.

On a node: `systemctl list-timers pcloud-health.timer`, `journalctl -u pcloud-health -n 20`, `systemctl start pcloud-health` (check now).
