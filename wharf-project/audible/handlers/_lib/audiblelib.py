"""Shared code for the audible wharf handlers.

Every handler: reads its args as JSON on stdin, writes progress to stderr
(wharf keeps it in the job log, which the shim tails), and prints ONE JSON
object to stdout at the end — that object is the job's `result`.

Handlers run with cwd = the project dir, under the system python3 with a
scrubbed env; `ensure_venv()` re-execs the script under the project venv so
the `audible` library is importable, and `env()` builds the environment the
audible-cli / ffmpeg / rclone subprocesses need.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

PROJECT = Path(os.getcwd()).resolve()
VENV_PY = PROJECT / "venv" / "bin" / "python3"
BIN = PROJECT / "bin"
DATA = PROJECT / "data"
CLI_DIR = DATA / "cli"            # audible-cli config dir (config.toml + <account>.json)
ACCOUNTS = DATA / "accounts.json"
LIBRARY_DIR = DATA / "library"
SYNCED_DIR = DATA / "synced"
PENDING_DIR = DATA / "pending"
DL_DIR = DATA / "dl"
RCLONE_CONF = DATA / "rclone.conf"

ACCOUNT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")

# Audible marketplaces → audible library locale codes.
MARKETPLACES = {
    "au": "australia", "us": "united_states", "uk": "united_kingdom", "ca": "canada",
    "de": "germany", "fr": "france", "it": "italy", "es": "spain", "jp": "japan", "in": "india", "br": "brazil",
}


def ensure_venv():
    """Re-exec under the project venv (idempotent)."""
    # Compare prefixes, not executables: the venv's python3 is a symlink to
    # /usr/bin/python3, so resolved paths are equal even outside the venv.
    if VENV_PY.exists() and Path(sys.prefix).resolve() != (PROJECT / "venv").resolve():
        os.execv(str(VENV_PY), [str(VENV_PY)] + sys.argv)


def log(msg):
    sys.stderr.write(time.strftime("%H:%M:%S ") + str(msg) + "\n")
    sys.stderr.flush()


def read_args():
    raw = sys.stdin.read()
    try:
        return json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        fail(f"bad args JSON: {e}")


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(msg, code=1):
    log("ERROR " + str(msg))
    emit({"ok": False, "error": str(msg)})
    sys.exit(code)


def env():
    e = {
        "PATH": f"{BIN}:{PROJECT / 'venv' / 'bin'}:/usr/local/bin:/usr/bin:/bin",
        "HOME": str(DATA),
        "AUDIBLE_CONFIG_DIR": str(CLI_DIR),
        "RCLONE_CONFIG": str(RCLONE_CONF),
        "PYTHONUNBUFFERED": "1",
        "LANG": "C.UTF-8",
    }
    return e


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def check_account(name):
    if not isinstance(name, str) or not ACCOUNT_RE.match(name):
        fail("account must be 1-32 chars: lowercase letters, digits, dashes")
    return name


def accounts():
    return load_json(ACCOUNTS, {})


def auth_path(account):
    return CLI_DIR / f"{account}.json"


def write_cli_config():
    """Regenerate audible-cli's config.toml from accounts.json so
    `audible -P <account> ...` works for every registered account."""
    accts = accounts()
    lines = ['title = "Audible Config File"', "", "[APP]"]
    names = sorted(accts)
    if names:
        lines.append(f'primary_profile = "{names[0]}"')
    for n in names:
        lines += ["", f"[profile.{n}]", f'auth_file = "{n}.json"', f'country_code = "{accts[n]["marketplace"]}"']
    CLI_DIR.mkdir(parents=True, exist_ok=True)
    with open(CLI_DIR / "config.toml", "w") as f:
        f.write("\n".join(lines) + "\n")


def run(cmd, timeout=None, cwd=None, capture=True):
    """Run a subprocess with the project env; returns CompletedProcess."""
    return subprocess.run(
        cmd, cwd=str(cwd or PROJECT), env=env(), timeout=timeout,
        stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None, text=True,
    )


def safe_name(s, maxlen=120):
    """Folder/file name from a title: strip path separators and the
    characters pCloud/Windows/ABS choke on, collapse whitespace."""
    s = re.sub(r'[\\/:*?"<>|]+', " ", s or "")
    s = re.sub(r"\s+", " ", s).strip(" .")
    return s[:maxlen] or "audiobook"
