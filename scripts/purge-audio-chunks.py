#!/usr/bin/env python3
"""Delete the R2 audio byte-cache chunks for one or more audio_files ids.

    CLOUDFLARE_API_TOKEN=... python3 scripts/purge-audio-chunks.py af-97ff8327-dea [...]

MANDATORY whenever a file's bytes change underneath a row that keeps its
`audio_files.id` — a container remux, a re-upload, a repaired download. Chunk
keys are `audio/<tenant>/<audio id>/<n>` and do not include a content hash, so
stale chunks would be stitched into the new file's ranges by
`tryServeByteRange` and served as corrupt audio. Run it BEFORE the D1 update
and again AFTER (a background warm can land mid-flip).

There is no bulk-delete endpoint: R2's `/objects/delete` answers 404 with code
10015, so this deletes per object, 8 at a time.
"""

import json, os, subprocess, sys, urllib.parse
from concurrent.futures import ThreadPoolExecutor

ACCT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "41a62277421a452c6499884fd17b3c8d")
BUCKET = "abs-shim-covers"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/r2/buckets/{BUCKET}/objects"

def curl(args):
    return subprocess.run(["curl", "-s", "-H", f"Authorization: Bearer {TOKEN}"] + args,
                          capture_output=True, text=True).stdout

def keys_for(aid):
    out = curl([f"{BASE}?prefix=audio/tnt_default/{aid}/&per_page=1000"])
    return [o["key"] for o in json.loads(out)["result"]]

def delete(key):
    out = curl(["-X", "DELETE", f"{BASE}/{urllib.parse.quote(key, safe='')}"])
    try:
        return key, json.loads(out).get("success", False)
    except Exception:
        return key, False

for aid in sys.argv[1:]:
    ks = keys_for(aid)
    if not ks:
        print(f"{aid}: nothing cached")
        continue
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(delete, ks))
    bad = [k for k, ok in res if not ok]
    left = keys_for(aid)
    print(f"{aid}: deleted {len(res) - len(bad)}/{len(res)}, failures={len(bad)}, remaining={len(left)}")
