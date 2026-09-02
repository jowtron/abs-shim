#!/usr/bin/env python3
"""auth_finish — complete a login started by auth_start.

stdin:  {"account": "joseph", "response_url": "https://www.amazon.com.au/ap/maplanding?...openid.oa2.authorization_code=..."}
stdout: {"ok": true, "account", "marketplace", "customer_name"}

Registers a (virtual) Audible device with the one-time authorization code,
stores the resulting auth file as data/cli/<account>.json (what audible-cli
and the `audible` library both read; refresh tokens keep it alive), and
adds the account to accounts.json + the CLI's config.toml.
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

import base64  # noqa: E402
from urllib.parse import parse_qs, urlparse  # noqa: E402

from audible import Authenticator  # noqa: E402
from audible.localization import Locale  # noqa: E402
from audible.register import register  # noqa: E402

args = L.read_args()
account = L.check_account(args.get("account"))
response_url = str(args.get("response_url") or "").strip()
pending = L.load_json(L.PENDING_DIR / f"{account}.json", None)
if not pending:
    L.fail("no login in progress for this account — start again")
if pending["expires_at"] < time.time():
    L.fail("that login link expired (15 min) — start again")
qs = parse_qs(urlparse(response_url).query)
code = (qs.get("openid.oa2.authorization_code") or [None])[0]
if not code:
    L.fail("that doesn't look like the page Amazon sent you to — paste the full address of the error page (it contains openid.oa2.authorization_code=)")

locale = Locale(pending["marketplace"])
L.log(f"registering device for {account} ({pending['marketplace']})…")
try:
    reg = register(
        authorization_code=code, code_verifier=base64.b64decode(pending["code_verifier"]),
        domain=locale.domain, serial=pending["serial"], with_username=False,
    )
except Exception as e:  # noqa: BLE001
    L.fail(f"Amazon rejected the code: {e}")

auth = Authenticator()
auth.locale = locale
auth._update_attrs(with_username=False, **reg)
L.CLI_DIR.mkdir(parents=True, exist_ok=True)
auth.to_file(L.auth_path(account), encryption=False)
os.chmod(L.auth_path(account), 0o600)

name = None
try:
    name = (reg.get("customer_info") or {}).get("name")
except AttributeError:
    pass
accts = L.accounts()
accts[account] = {"marketplace": pending["marketplace"], "added_at": int(time.time() * 1000), "customer_name": name}
L.save_json(L.ACCOUNTS, accts)
L.write_cli_config()
try:
    os.remove(L.PENDING_DIR / f"{account}.json")
except FileNotFoundError:
    pass
L.log(f"account {account} linked" + (f" ({name})" if name else ""))
L.emit({"ok": True, "account": account, "marketplace": pending["marketplace"], "customer_name": name})
