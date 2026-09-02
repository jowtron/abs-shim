#!/usr/bin/env python3
"""accounts — list linked Audible accounts.

stdin:  {}
stdout: {"ok": true, "accounts": [{account, marketplace, customer_name, added_at,
          library_count, library_fetched_at, synced_count}], "pending": [account...]}
"""
import os
import sys
import time

# wharf copies an approved handler to state/registered/<project>/<name>/,
# so locate the shared lib from the working dir (the project dir), not __file__.
sys.path.insert(0, os.path.join(os.getcwd(), "handlers", "_lib"))
sys.path.insert(0, "/srv/wharf/projects/audible/handlers/_lib")
import audiblelib as L  # noqa: E402

L.read_args()
out = []
for name, a in sorted(L.accounts().items()):
    lib = L.load_json(L.LIBRARY_DIR / f"{name}.json", {})
    synced = L.load_json(L.SYNCED_DIR / f"{name}.json", {})
    out.append({
        "account": name, "marketplace": a.get("marketplace"), "customer_name": a.get("customer_name"),
        "added_at": a.get("added_at"),
        "library_count": len(lib.get("items", [])), "library_fetched_at": lib.get("fetched_at"),
        "synced_count": len(synced),
    })
pending = []
now = time.time()
if L.PENDING_DIR.exists():
    for p in L.PENDING_DIR.glob("*.json"):
        d = L.load_json(p, {})
        if d.get("expires_at", 0) > now:
            pending.append(d["account"])
L.emit({"ok": True, "accounts": out, "pending": pending})
