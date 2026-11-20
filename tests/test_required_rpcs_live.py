"""Every database function the deployed app calls must exist in production (Codex #838 REW842-2).

#842 shipped a Rewards save that calls pds.rewards_settings_merge before that SQL file was applied, so every
settings save answered 503 and nothing went red. This check reads the frontend source for every PostgREST RPC it
calls (`.rpc("name"` and `*_RPC = "name"` constants) and fails when one of them is not exposed by the production
API for the pds schema to the service role the app uses.

How it reads the catalog (read-only): PostgREST's OpenAPI description (GET <SUPABASE_URL>/rest/v1/ with
Accept-Profile: pds and the service-role key) lists one `/rpc/<name>` path per function in the schema that role
may execute. No function is called and nothing is written. Fail closed: a response without any `/rpc/` path means
the catalog could not be read, which is a failure, never a pass.

Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (live-checks.yml passes them to this step only). Without them it
SKIPS, unless ONYX_REQUIRE_LIVE=1 (set in CI), which makes missing credentials a failure.

A missing function is fixed by applying its sql/*.sql file (Riley's PC session; agents cannot apply SQL), not by
editing this list. A name the app calls on purpose before its SQL exists would go in ALLOW_MISSING with a reason.

Run: python tests/test_required_rpcs_live.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "src"

# name -> why the app may call it while it is absent from production. Keep empty unless there is a reason.
ALLOW_MISSING: dict[str, str] = {}

RPC_CALL = re.compile(r"""\.rpc\(\s*["']([a-z_][a-z0-9_]*)["']""")
RPC_CONST = re.compile(r"""\b[A-Z][A-Z0-9_]*_RPC\s*=\s*["']([a-z_][a-z0-9_]*)["']""")


def required_rpcs(src: Path = SRC) -> dict[str, list[str]]:
    """RPC name -> the source files that call it."""
    found: dict[str, list[str]] = {}
    for path in sorted(src.rglob("*")):
        if path.suffix not in {".ts", ".tsx", ".js", ".mjs", ".cjs"} or "node_modules" in path.parts:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for name in RPC_CALL.findall(text) + RPC_CONST.findall(text):
            found.setdefault(name, [])
            rel = str(path.relative_to(ROOT))
            if rel not in found[name]:
                found[name].append(rel)
    return found


def exposed_rpcs(url: str, key: str) -> set[str]:
    req = urllib.request.Request(
        url.rstrip("/") + "/rest/v1/",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/openapi+json",
            "Accept-Profile": "pds",
            "User-Agent": "onyx-live-checks",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (fixed https Supabase URL)
        spec = json.loads(resp.read().decode("utf-8"))
    paths = spec.get("paths") if isinstance(spec, dict) else None
    if not isinstance(paths, dict):
        raise RuntimeError("the API description has no 'paths'; cannot read the function catalog")
    return {p[len("/rpc/"):] for p in paths if isinstance(p, str) and p.startswith("/rpc/")}


def main() -> int:
    required = required_rpcs()
    # Self-check of the source scan, so a refactor that hides every call cannot turn this into a silent pass.
    for must in ("rewards_settings_merge", "behavioral_today_now", "save_supplement_stack"):
        if must not in required:
            print(f"FAIL: source scan did not find {must}; RPC_CALL/RPC_CONST no longer match the frontend")
            return 1
    print(f"{len(required)} RPC names called by frontend/src")

    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        if os.environ.get("ONYX_REQUIRE_LIVE") == "1":
            print("FAIL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing and ONYX_REQUIRE_LIVE=1")
            return 1
        print("SKIP: no Supabase credentials (this check reads the production API description; it runs in CI)")
        return 0

    try:
        exposed = exposed_rpcs(url, key)
    except Exception as e:  # noqa: BLE001
        print(f"FAIL: could not read the production function catalog: {type(e).__name__}: {e}")
        return 1
    if not exposed:
        print("FAIL: the production API lists no /rpc/ functions for pds; cannot verify (fail closed)")
        return 1
    print(f"{len(exposed)} pds functions exposed to the service role")

    missing = sorted(n for n in required if n not in exposed and n not in ALLOW_MISSING)
    for name in sorted(n for n in required if n not in exposed and n in ALLOW_MISSING):
        print(f"allowed missing: {name} ({ALLOW_MISSING[name]})")
    stale = sorted(n for n in ALLOW_MISSING if n in exposed or n not in required)
    for name in stale:
        print(f"FAIL: ALLOW_MISSING lists {name}, which is now present or no longer called; remove it")
    for name in missing:
        print(f"FAIL: pds.{name} is called by {', '.join(required[name])} but is missing in production "
              f"(apply its sql/*.sql file)")
    if missing or stale:
        return 1
    print("ok: every RPC the app calls exists in production")
    return 0


if __name__ == "__main__":
    sys.exit(main())
