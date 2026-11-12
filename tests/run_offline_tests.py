#!/usr/bin/env python3
"""Run every OFFLINE test in tests/ in parallel, with no credentials.

This is what the pull-request job (.github/workflows/stats-pr-check.yml) runs, and
you can run it locally the same way:

    python tests/run_offline_tests.py              # all offline tests, one process per CPU
    python tests/run_offline_tests.py -j 1         # one at a time
    python tests/run_offline_tests.py tests/test_causal_fdr.py   # just these files
    python tests/run_offline_tests.py --list       # show what would run and why

A test file is "offline" if it is named tests/test_*.py and is not listed in LIVE_TESTS.
Each file runs as its own process (`python tests/test_x.py`, exactly how its docstring
says to run it), so module-level stubs and monkeypatching cannot leak between files.

Children never receive credentials: secret-looking environment variables are removed
before launch, and the tests stub the SUPABASE_* values they need themselves.

Adding a test: drop tests/test_<name>.py in. It is picked up automatically. If it needs
the production database it is NOT offline - add it to LIVE_TESTS below and to
.github/workflows/live-checks.yml (this script fails if you forget the second part).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
LIVE_WORKFLOW = ROOT / ".github" / "workflows" / "live-checks.yml"

# --- The ONE place that decides what is not an offline test -------------------------------
# Needs the production Supabase project (service-role key). Run by live-checks.yml only,
# on master / on a schedule / on demand - never on a pull request.
LIVE_TESTS = {
    "test_hrv_alignment_live.py": "reads the live behavioral matrix (read-only)",
    "test_habit_rename.py": "WRITES uuid-tagged fixtures to the live database (manual opt-in only)",
}

# Offline tests that currently fail for a reason unrelated to the change under test.
# They still RUN and are reported loudly, but do not fail the job. If one starts passing the
# job fails until it is removed from here, so this list cannot go stale. Format:
#   "test_x.py": "why it fails, and where the fix is tracked",
KNOWN_BROKEN: dict[str, str] = {}
# -------------------------------------------------------------------------------------------

# Environment variables that must never reach an offline test, even when run on a dev box
# that has a real .env loaded into the shell.
SECRET_ENV = re.compile(
    r"(SUPABASE|SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|_KEY$|^IMAP_|^GARMIN_|^WHOOP_|^SPOTIFY_"
    r"|^EIGHTSLEEP_|^TANITA_|^CRONOMETER_|^NOTION_|^VOYAGE_|^ANTHROPIC_|^ONYX_REQUIRE_LIVE$)",
    re.IGNORECASE,
)

PER_TEST_TIMEOUT_S = 600


def discover() -> list[Path]:
    return sorted(TESTS.glob("test_*.py"))


def check_lists() -> list[str]:
    """Problems with the exclusion lists themselves (typos would silently change coverage)."""
    problems = []
    for name in [*LIVE_TESTS, *KNOWN_BROKEN]:
        if not (TESTS / name).is_file():
            problems.append(f"{name} is listed in run_offline_tests.py but tests/{name} does not exist")
    live_yml = LIVE_WORKFLOW.read_text(encoding="utf-8") if LIVE_WORKFLOW.is_file() else ""
    for name in LIVE_TESTS:
        if name not in live_yml:
            problems.append(
                f"{name} is excluded from the offline run but never run by "
                f".github/workflows/live-checks.yml - it would not be tested anywhere"
            )
    return problems


def child_env(jobs: int) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not SECRET_ENV.search(k)}
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["MPLBACKEND"] = "Agg"
    if jobs > 1:  # one BLAS/OpenMP thread per process; processes already use every core
        for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
            env.setdefault(var, "1")
    return env


def run_one(path: Path, env: dict[str, str]) -> tuple[Path, int, float, str]:
    start = time.monotonic()
    try:
        proc = subprocess.run(
            [sys.executable, str(path.relative_to(ROOT))],
            cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=PER_TEST_TIMEOUT_S, stdin=subprocess.DEVNULL,
        )
        rc, out = proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired as exc:
        rc = 124
        out = f"TIMEOUT after {PER_TEST_TIMEOUT_S}s\n{exc.stdout or ''}{exc.stderr or ''}"
    return path, rc, time.monotonic() - start, out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", help="run only these test files (default: all offline tests)")
    ap.add_argument("-j", "--jobs", type=int, default=os.cpu_count() or 2, help="parallel processes")
    ap.add_argument("--list", action="store_true", help="print the plan and exit")
    args = ap.parse_args()

    problems = check_lists()
    if problems:
        for p in problems:
            print(f"::error::{p}" if os.environ.get("GITHUB_ACTIONS") else f"ERROR: {p}")
        return 2

    if args.files:
        selected = [Path(f).resolve() for f in args.files]
    else:
        selected = [p for p in discover() if p.name not in LIVE_TESTS]

    if args.list:
        for p in discover():
            if p.name in LIVE_TESTS:
                print(f"live          {p.name}  ({LIVE_TESTS[p.name]})")
            elif p.name in KNOWN_BROKEN:
                print(f"known-broken  {p.name}  ({KNOWN_BROKEN[p.name]})")
            else:
                print(f"offline       {p.name}")
        return 0

    live_selected = [p.name for p in selected if p.name in LIVE_TESTS]
    if live_selected:
        print(f"ERROR: refusing to run live tests offline: {', '.join(live_selected)}")
        return 2
    if not selected:
        print("ERROR: no tests selected (is tests/ empty?)")
        return 2

    jobs = max(1, min(args.jobs, len(selected)))
    env = child_env(jobs)
    gha = bool(os.environ.get("GITHUB_ACTIONS"))
    print(f"Running {len(selected)} offline test files with {jobs} parallel process(es); no credentials in env.")

    wall = time.monotonic()
    results: list[tuple[Path, int, float, str]] = []
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = [pool.submit(run_one, p, env) for p in selected]
        for fut in as_completed(futures):
            path, rc, secs, out = fut.result()
            results.append((path, rc, secs, out))
            tag = "ok  " if rc == 0 else ("warn" if path.name in KNOWN_BROKEN else "FAIL")
            if rc != 0 or os.environ.get("ONYX_TEST_VERBOSE"):
                print(f"{'::group::' if gha else ''}{tag} {path.name} ({secs:.1f}s)\n{out.rstrip()}")
                if gha:
                    print("::endgroup::")
            else:
                print(f"{tag} {path.name} ({secs:.1f}s)")

    results.sort(key=lambda r: r[0].name)
    failed, stale_known, tolerated = [], [], []
    for path, rc, _secs, _out in results:
        known = path.name in KNOWN_BROKEN
        if rc != 0 and not known:
            failed.append(path.name)
        elif rc != 0 and known:
            tolerated.append(path.name)
        elif rc == 0 and known:
            stale_known.append(path.name)

    total_cpu = sum(r[2] for r in results)
    print(f"\n{len(results) - len(failed) - len(tolerated)}/{len(results)} passed; "
          f"{total_cpu:.0f}s of test time in {time.monotonic() - wall:.0f}s wall clock.")
    for name in tolerated:
        msg = f"KNOWN_BROKEN {name} still fails: {KNOWN_BROKEN[name]}"
        print(f"::warning::{msg}" if gha else f"WARNING: {msg}")
    for name in stale_known:
        msg = f"{name} passes now - remove it from KNOWN_BROKEN in tests/run_offline_tests.py"
        print(f"::error::{msg}" if gha else f"ERROR: {msg}")
    if failed:
        print("FAILED: " + ", ".join(failed))
    return 1 if (failed or stale_known) else 0


if __name__ == "__main__":
    sys.exit(main())
