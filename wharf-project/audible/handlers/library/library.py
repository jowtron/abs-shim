#!/usr/bin/env python3
"""library — the account's Audible library, from cache or refreshed.

stdin:  {"account": "joseph", "refresh": true}
stdout: {"ok": true, "account", "fetched_at", "items": [{asin, title, subtitle, authors[],
          narrators[], runtime_min, purchase_date, release_date, cover, series,
          series_sequence, finished, downloadable, synced: {path, at} | null}]}

Pages through the Audible library API with the account's auth file (the
`audible` library refreshes the access token; the file is re-saved so the
refreshed token persists). Cached in data/library/<account>.json.
"""
import os
import sys
import time

# wharf copies an approved handler to state/registered/<project>/<name>/,
# so locate the shared lib from the working dir (the project dir), not __file__.
sys.path.insert(0, os.path.join(os.getcwd(), "handlers", "_lib"))
sys.path.insert(0, "/srv/wharf/projects/audible/handlers/_lib")
import audiblelib as L  # noqa: E402

L.ensure_venv()

import audible  # noqa: E402

RESPONSE_GROUPS = "product_desc,product_attrs,media,contributors,series,relationships,customer_rights,is_finished"


def fetch(account):
    auth = audible.Authenticator.from_file(L.auth_path(account))
    items = []
    with audible.Client(auth=auth) as client:
        page = 1
        while True:
            r = client.get("1.0/library", num_results=1000, page=page, response_groups=RESPONSE_GROUPS, sort_by="-PurchaseDate")
            got = r.get("items", [])
            items.extend(got)
            L.log(f"page {page}: {len(got)} items")
            if len(got) < 1000:
                break
            page += 1
    auth.to_file(L.auth_path(account), encryption=False)
    return items


def trim(it):
    imgs = it.get("product_images") or {}
    cover = imgs.get("500") or imgs.get("1215") or next(iter(imgs.values()), None)
    series = (it.get("series") or [{}])[0] if it.get("series") else {}
    rights = it.get("customer_rights") or {}
    return {
        "asin": it.get("asin"),
        "title": it.get("title"),
        "subtitle": it.get("subtitle"),
        "authors": [a.get("name") for a in it.get("authors") or [] if a.get("name")],
        "narrators": [n.get("name") for n in it.get("narrators") or [] if n.get("name")],
        "runtime_min": it.get("runtime_length_min"),
        "purchase_date": it.get("purchase_date"),
        "release_date": it.get("release_date"),
        "cover": cover,
        "series": series.get("title"),
        "series_sequence": series.get("sequence"),
        "finished": bool(it.get("is_finished")),
        "content_type": it.get("content_type"),
        "downloadable": rights.get("is_consumable_offline", True),
    }


args = L.read_args()
account = L.check_account(args.get("account"))
if account not in L.accounts():
    L.fail(f"unknown account '{account}'")
cache_path = L.LIBRARY_DIR / f"{account}.json"
cache = L.load_json(cache_path, None)
if args.get("refresh") or not cache:
    L.log(f"fetching library for {account}…")
    try:
        raw = fetch(account)
    except Exception as e:  # noqa: BLE001
        L.fail(f"Audible library fetch failed: {e}")
    cache = {"fetched_at": int(time.time() * 1000), "items": [trim(i) for i in raw]}
    L.save_json(cache_path, cache)
    L.log(f"{len(cache['items'])} titles")
synced = L.load_json(L.SYNCED_DIR / f"{account}.json", {})
items = []
for it in cache["items"]:
    it = dict(it)
    it["synced"] = synced.get(it["asin"])
    items.append(it)
L.emit({"ok": True, "account": account, "fetched_at": cache["fetched_at"], "items": items})
