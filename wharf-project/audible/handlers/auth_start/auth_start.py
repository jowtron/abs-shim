#!/usr/bin/env python3
"""auth_start — begin a browser-assisted Audible login for an account.

stdin:  {"account": "joseph", "marketplace": "au"}
stdout: {"ok": true, "account", "marketplace", "login_url", "expires_at"}

The user opens login_url in ANY browser, signs in to Amazon there (2FA and
captchas are handled by Amazon's own pages), and ends on an error page whose
address starts with https://www.amazon.<tld>/ap/maplanding?... — they paste
that whole address into auth_finish. Nothing about their password ever
reaches this box; only the one-time authorization code in that URL does.
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

from audible.localization import Locale  # noqa: E402
from audible.login import build_oauth_url, create_code_verifier  # noqa: E402

args = L.read_args()
account = L.check_account(args.get("account"))
market = str(args.get("marketplace") or "au").lower()
if market not in L.MARKETPLACES:
    L.fail(f"marketplace must be one of {', '.join(sorted(L.MARKETPLACES))}")
if account in L.accounts():
    L.fail(f"account '{account}' already exists — remove it first to re-link")

locale = Locale(market)
code_verifier = create_code_verifier()
oauth_url, serial = build_oauth_url(
    country_code=locale.country_code, domain=locale.domain, market_place_id=locale.market_place_id,
    code_verifier=code_verifier, serial=None, with_username=False,
)
expires = int(time.time()) + 15 * 60
L.save_json(L.PENDING_DIR / f"{account}.json", {
    "account": account, "marketplace": market, "serial": serial,
    "code_verifier": base64.b64encode(code_verifier).decode(), "expires_at": expires,
})
L.log(f"login started for {account} ({market}); waiting for the pasted redirect URL")
L.emit({"ok": True, "account": account, "marketplace": market, "login_url": oauth_url, "expires_at": expires})
