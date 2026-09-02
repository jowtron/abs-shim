#!/usr/bin/env python3
"""remove_account — unlink an Audible account (auth file, cached library,
sync record, any pending login). Books already uploaded to pCloud stay.

stdin:  {"account": "mum"}
stdout: {"ok": true, "account"}
"""
import os
import sys

# wharf copies an approved handler to state/registered/<project>/<name>/,
# so locate the shared lib from the working dir (the project dir), not __file__.
sys.path.insert(0, os.path.join(os.getcwd(), "handlers", "_lib"))
sys.path.insert(0, "/srv/wharf/projects/audible/handlers/_lib")
import audiblelib as L  # noqa: E402

args = L.read_args()
account = L.check_account(args.get("account"))
accts = L.accounts()
accts.pop(account, None)
L.save_json(L.ACCOUNTS, accts)
L.write_cli_config()
for p in (L.auth_path(account), L.LIBRARY_DIR / f"{account}.json", L.SYNCED_DIR / f"{account}.json", L.PENDING_DIR / f"{account}.json"):
    try:
        os.remove(p)
    except FileNotFoundError:
        pass
L.log(f"account {account} removed")
L.emit({"ok": True, "account": account})
