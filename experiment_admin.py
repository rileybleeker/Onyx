"""N-of-1 experiment framework: the admin CLI Riley runs on purpose (docs/experiment-framework.md).

Starting a trial is two deliberate steps, both run from GitHub Actions because this needs the
service-role key (`gh workflow run experiment-admin.yml ...`, master only; see AGENTS.md):

  1. seed      python experiment_admin.py seed --protocol docs/experiments/EXP-001.md
               Creates the draft and a secret 32-byte seed in the database and prints ONLY its
               sha256 commitment. Put that value in the protocol's allocation.seed_sha256 and
               merge the protocol to master.
  2. register  python experiment_admin.py register --protocol docs/experiments/EXP-001.md --confirm EXP-001
               Validates the merged protocol, generates the whole schedule from the stored seed,
               writes it and locks the protocol in one transaction (pds.experiment_register).

Other commands:
  power    read-only planning check before registering: placebo schedules over the latest N
           nights of real HRV -> how many days an effect of the given size needs (aggregates only)
  verify   regenerate the schedule from the stored seed and compare it with the stored rows
  stop     Riley stops the trial early (recorded as stopped_early, never erased)
  status   list experiments (no arms)

What this never does: print or log a seed or an arm (Actions logs of this repo are public), read
or write outcome data, or analyse anything. It is not reachable from the web app or by the CI
token; it needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment.

Every command that writes leaves a pds.sync_log heartbeat (experiments|admin), success or failure.
"""
from __future__ import annotations

import argparse
import os
import secrets
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

import experiment_design as design

ET = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parent
PROTOCOL_DIR = "docs/experiments"


class AdminError(RuntimeError):
    """A refusal with a message that is safe to print (never contains a seed or an arm)."""


def et_today() -> date:
    return datetime.now(ET).date()


# ---------------------------------------------------------------------------
# Database access (one small surface, so the tests can stand in for it)
# ---------------------------------------------------------------------------

class Store:
    def __init__(self, supa: Any):
        self.supa = supa

    def _t(self, table: str):
        return self.supa.schema("pds").from_(table)

    def experiment(self, experiment_id: str) -> dict | None:
        rows = self._t("experiments").select(
            "experiment_id,title,status,seed_sha256,start_date,planned_end,n_days,n_blocks,block_len,"
            "n_a_per_block,locked_at,stopped_on").eq("experiment_id", experiment_id).execute().data
        return rows[0] if rows else None

    def experiment_active(self) -> bool:
        return bool(self._t("experiments").select("experiment_id").in_(
            "status", ["registered", "running", "paused"]).limit(1).execute().data)

    def experiments(self) -> list[dict]:
        return self._t("experiments").select(
            "experiment_id,title,status,start_date,planned_end,n_days,locked_at,stopped_on"
        ).order("experiment_id").execute().data or []

    def create_draft(self, experiment_id: str, title: str, commitment: str, seed_hex: str) -> None:
        self._t("experiments").insert(
            {"experiment_id": experiment_id, "title": title, "seed_sha256": commitment}).execute()
        self._t("experiment_secrets").insert({"experiment_id": experiment_id, "seed_hex": seed_hex}).execute()

    def seed_hex(self, experiment_id: str) -> str | None:
        rows = self._t("experiment_secrets").select("seed_hex").eq("experiment_id", experiment_id).execute().data
        return rows[0]["seed_hex"] if rows else None

    def register(self, experiment_id: str, fields: dict, schedule: list[dict]) -> dict:
        return self.supa.schema("pds").rpc(
            "experiment_register",
            {"p_experiment_id": experiment_id, "p_fields": fields, "p_schedule": schedule}).execute().data

    def schedule(self, experiment_id: str) -> list[dict]:
        out: list[dict] = []
        page = 1000
        while True:
            rows = self._t("experiment_schedule").select("day_index,behavioral_date,arm").eq(
                "experiment_id", experiment_id).order("day_index").range(len(out), len(out) + page - 1).execute().data or []
            out.extend(rows)
            if len(rows) < page:
                return out

    def hrv_by_day(self, first: date, last: date) -> dict[str, float]:
        """whoop_hrv_rmssd per behavioral day (the planning check only; never used on trial days)."""
        rows = self._t("daily_health_matrix_behavioral").select("calendar_date,whoop_hrv_rmssd").gte(
            "calendar_date", first.isoformat()).lte("calendar_date", last.isoformat()).not_.is_(
            "whoop_hrv_rmssd", "null").order("calendar_date").limit(1000).execute().data or []
        return {str(r["calendar_date"])[:10]: float(r["whoop_hrv_rmssd"]) for r in rows}

    def behavioral_today(self) -> date:
        return date.fromisoformat(str(self.supa.schema("pds").rpc("behavioral_today_now", {}).execute().data))

    def stop(self, experiment_id: str, stopped_on: date, reason: str) -> None:
        self._t("experiments").update(
            {"status": "stopped_early", "stopped_on": stopped_on.isoformat(), "stop_reason": reason}
        ).eq("experiment_id", experiment_id).execute()


def get_store() -> Store:
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    from supabase import create_client
    return Store(create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]))


# ---------------------------------------------------------------------------
# Git facts about the protocol file (the merge to master is the registration record)
# ---------------------------------------------------------------------------

def git_info(protocol_path: str) -> dict[str, Any]:
    def run(*args: str) -> tuple[int, str]:
        proc = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
        return proc.returncode, proc.stdout.strip()

    tracked = run("ls-files", "--error-unmatch", "--", protocol_path)[0] == 0
    clean = tracked and run("status", "--porcelain", "--", protocol_path)[1] == ""
    commit = run("rev-parse", "HEAD")[1]
    branch = os.environ.get("GITHUB_REF_NAME") or run("rev-parse", "--abbrev-ref", "HEAD")[1]
    on_master = branch == "master" and (
        bool(os.environ.get("GITHUB_ACTIONS")) or run("merge-base", "--is-ancestor", "HEAD", "origin/master")[0] == 0)
    return {"tracked": tracked, "clean": clean, "commit": commit, "branch": branch, "on_master": on_master}


def _protocol_relpath(path: str, root: Path = ROOT) -> str:
    try:
        rel = (root / path).resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        raise AdminError(f"the protocol must be a .md file under {PROTOCOL_DIR}/") from None
    if not rel.startswith(PROTOCOL_DIR + "/") or not rel.endswith(".md"):
        raise AdminError(f"the protocol must be a .md file under {PROTOCOL_DIR}/")
    return rel


# ---------------------------------------------------------------------------
# Commands (each returns the lines to print)
# ---------------------------------------------------------------------------

def cmd_seed(store: Store, protocol_path: str, *, root: Path = ROOT,
             new_seed: Callable[[], bytes] = lambda: secrets.token_bytes(design.SEED_BYTES)) -> list[str]:
    rel = _protocol_relpath(protocol_path, root)
    protocol, _ = design.load_protocol(root / rel)
    experiment_id, title = str(protocol.get("id") or ""), str(protocol.get("title") or "")
    if not design.ID_PATTERN.match(experiment_id) or experiment_id == design.TEMPLATE_ID or not title:
        raise AdminError("the protocol needs an id like EXP-001 (not the template id) and a title")
    if Path(rel).stem != experiment_id:
        raise AdminError(f"the file must be named {experiment_id}.md")

    existing = store.experiment(experiment_id)
    if existing:
        if existing["status"] != "draft":
            raise AdminError(f"{experiment_id} is already {existing['status']}; a new trial needs a new id")
        return [f"{experiment_id} already has a draft; nothing was generated.",
                f"seed_sha256: {existing['seed_sha256']}"]

    seed = new_seed()
    commitment = design.seed_commitment(seed)
    store.create_draft(experiment_id, title, commitment, seed.hex())
    return [f"{experiment_id}: draft created; the seed is stored in the database and shown nowhere.",
            f"seed_sha256: {commitment}",
            "Put this value in the protocol's allocation.seed_sha256, merge the protocol to master, then run register."]


def cmd_register(store: Store, protocol_path: str, confirm: str, *, root: Path = ROOT, today: date | None = None,
                 git: Callable[[str], dict[str, Any]] = git_info) -> list[str]:
    import hrv_alignment

    rel = _protocol_relpath(protocol_path, root)
    protocol, sha = design.load_protocol(root / rel)
    experiment_id = str(protocol.get("id") or "")
    if confirm != experiment_id:
        raise AdminError(f"--confirm must repeat the experiment id ({experiment_id}); registering locks the protocol for good")
    if Path(rel).stem != experiment_id:
        raise AdminError(f"the file must be named {experiment_id}.md")

    existing = store.experiment(experiment_id)
    if not existing:
        raise AdminError(f"{experiment_id} has no draft; run the seed step first")
    if existing["status"] != "draft":
        raise AdminError(f"{experiment_id} is already {existing['status']} and cannot be registered again")

    facts = git(rel)
    if not (facts["tracked"] and facts["clean"]):
        raise AdminError("the protocol file must be committed with no local changes")
    if not facts["on_master"]:
        raise AdminError(f"the protocol must be merged to master before it is registered (this checkout is on {facts['branch']})")

    fields = design.validate_protocol(protocol, today=today or et_today(),
                                      alignment_version=hrv_alignment.ALIGNMENT_VERSION,
                                      seed_sha256=existing["seed_sha256"])
    seed_hex = store.seed_hex(experiment_id)
    if not seed_hex or design.seed_commitment(bytes.fromhex(seed_hex)) != existing["seed_sha256"]:
        raise AdminError("GUARD experiment_schedule: the stored seed does not match its commitment")

    arms = design.generate_schedule(bytes.fromhex(seed_hex), fields["n_blocks"], fields["block_len"], fields["n_a_per_block"])
    rows = design.schedule_rows(experiment_id, date.fromisoformat(fields["start_date"]), arms, fields["block_len"])
    fields.update(protocol_path=rel, protocol_sha256=sha, git_commit=facts["commit"], generator=design.GENERATOR)
    result = store.register(experiment_id, fields, rows) or {}

    stored = store.schedule(experiment_id)
    if [(r["day_index"], r["arm"]) for r in stored] != [(r["day_index"], r["arm"]) for r in rows]:
        raise AdminError("GUARD experiment_schedule: the stored schedule differs from the generated one")
    return [f"{experiment_id} registered and locked ({result.get('locked_at', 'now')}).",
            f"First day {fields['start_date']}, last day {fields['planned_end']}, {fields['n_days']} days in "
            f"{fields['n_blocks']} blocks. The schedule is stored and verified; arms are shown one day at a time on /today.",
            f"protocol_sha256: {sha}", f"git_commit: {facts['commit']}", f"seed_sha256: {fields['seed_sha256']}"]


def cmd_verify(store: Store, experiment_id: str) -> list[str]:
    exp = store.experiment(experiment_id)
    if not exp or exp["status"] == "draft":
        raise AdminError(f"{experiment_id} is not registered")
    seed_hex = store.seed_hex(experiment_id)
    if not seed_hex or design.seed_commitment(bytes.fromhex(seed_hex)) != exp["seed_sha256"]:
        raise AdminError("GUARD experiment_schedule: the stored seed does not match its commitment")
    arms = design.generate_schedule(bytes.fromhex(seed_hex), exp["n_blocks"], exp["block_len"], exp["n_a_per_block"])
    stored = store.schedule(experiment_id)
    mismatched = sum(1 for i, arm in enumerate(arms) if i >= len(stored) or stored[i]["day_index"] != i or stored[i]["arm"] != arm)
    if mismatched or len(stored) != len(arms):
        raise AdminError(f"GUARD experiment_schedule: {experiment_id} has {mismatched} day(s) that differ from the "
                         f"schedule its seed generates ({len(stored)} stored, {len(arms)} expected)")
    return [f"{experiment_id}: all {len(arms)} stored days match the schedule generated from the committed seed."]


def cmd_stop(store: Store, experiment_id: str, reason: str, confirm: str) -> list[str]:
    if confirm != experiment_id:
        raise AdminError("--confirm must repeat the experiment id; a stopped trial cannot be resumed")
    if not reason.strip():
        raise AdminError("--reason is required")
    exp = store.experiment(experiment_id)
    if not exp or exp["status"] not in ("registered", "running", "paused"):
        raise AdminError(f"{experiment_id} is not an active trial")
    stopped_on = store.behavioral_today()
    store.stop(experiment_id, stopped_on, reason.strip())
    return [f"{experiment_id} stopped early on {stopped_on}. It stays on record and can be analysed as stopped_early."]


def cmd_power(store: Store, window_days: int, effect_ms: float, *, n_trials: int = 500) -> list[str]:
    """Phase 1 of the design as a repeatable check (docs/experiment-framework.md 7.6). Read-only."""
    import numpy as np

    import experiment_analysis as analysis

    if not 60 <= window_days <= 900 or effect_ms <= 0:
        raise AdminError("--window must be 60 to 900 days and --effect positive")
    if store.experiment_active():
        raise AdminError("a trial is active: a planning check on its nights would be an unregistered look at the outcome")
    window_days -= window_days % 4
    last = store.behavioral_today() - timedelta(days=1)
    first = last - timedelta(days=window_days - 1)
    hrv = store.hrv_by_day(first, last)
    days = [first + timedelta(days=i) for i in range(window_days)]
    y = np.array([hrv.get(d.isoformat(), np.nan) for d in days])
    nights = int((~np.isnan(y)).sum())
    if nights < 40:
        raise AdminError(f"only {nights} nights with HRV in the window")
    sd = analysis.placebo_noise(y, np.array([d.weekday() for d in days]), n_trials=n_trials,
                                seed=design.redraw_seed("planning", last))
    need = analysis.days_for_power(sd, window_days, effect_ms)
    obs = y[~np.isnan(y)]
    return [f"Window {first} to {last}: {nights} of {window_days} nights with HRV ({100 * (1 - nights / window_days):.1f}% missing), "
            f"mean {obs.mean():.1f} ms, SD {obs.std(ddof=1):.1f} ms.",
            f"Placebo schedules ({n_trials}) analysed as planned: the estimate's chance SD is {sd:.2f} ms over {window_days} days.",
            f"An effect of {effect_ms:g} ms needs about {need} days ({need // 4} blocks) for 80% power, if the noise stays like this window.",
            "Longer windows that include a noisier period give larger numbers; see docs/experiment-framework.md 7.6."]


def cmd_status(store: Store) -> list[str]:
    rows = store.experiments()
    if not rows:
        return ["No experiments."]
    return [f"{r['experiment_id']}  {r['status']:<13}  {r.get('start_date') or '-'} to {r.get('planned_end') or '-'}"
            f"  {r.get('n_days') or '-'} days  {r['title']}" for r in rows]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None, store: Store | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("seed"); p.add_argument("--protocol", required=True)
    p = sub.add_parser("register"); p.add_argument("--protocol", required=True); p.add_argument("--confirm", required=True)
    p = sub.add_parser("verify"); p.add_argument("--experiment", required=True)
    p = sub.add_parser("stop"); p.add_argument("--experiment", required=True)
    p.add_argument("--reason", required=True); p.add_argument("--confirm", required=True)
    p = sub.add_parser("power"); p.add_argument("--window", type=int, default=120)
    p.add_argument("--effect", type=float, default=design.MIN_MID_MS)
    sub.add_parser("status")
    args = ap.parse_args(argv)

    started = time.time()
    store = store or get_store()
    writes = args.command in ("seed", "register", "stop")
    status, error, code = "success", None, 0
    try:
        if args.command == "seed":
            lines = cmd_seed(store, args.protocol)
        elif args.command == "register":
            lines = cmd_register(store, args.protocol, args.confirm)
        elif args.command == "verify":
            lines = cmd_verify(store, args.experiment)
        elif args.command == "stop":
            lines = cmd_stop(store, args.experiment, args.reason, args.confirm)
        elif args.command == "power":
            lines = cmd_power(store, args.window, args.effect)
        else:
            lines = cmd_status(store)
        print("\n".join(lines))
    except (AdminError, design.ProtocolError) as exc:
        problems = getattr(exc, "problems", None) or [str(exc)]
        print(f"REFUSED ({args.command}):\n  - " + "\n  - ".join(problems), file=sys.stderr)
        text = "; ".join(problems)
        # A GUARD heartbeat must start with "GUARD <name>:" (AGENTS.md); the devops agent matches the prefix.
        status, error, code = "failed", (text if text.startswith("GUARD ") else f"{args.command}: {text}")[:500], 1
    except Exception as exc:  # noqa: BLE001 - every run leaves a heartbeat
        # A database refusal carries the guard's own sentence in .message (no seed, no arm). Its
        # .details can quote the failing row, so it is never printed; anything else prints its type only.
        message = getattr(exc, "message", None)
        text = f"{type(exc).__name__}: {message}" if isinstance(message, str) and message else type(exc).__name__
        print(f"FAILED ({args.command}): {text}", file=sys.stderr)
        status, error, code = "failed", f"{args.command}: {text}"[:500], 1
    if writes or (code and args.command == "verify"):
        from sync_log_helper import log_sync
        log_sync(store.supa, "experiments", "admin", status, records=0 if code else 1, started_at=started, error=error)
    return code


if __name__ == "__main__":
    sys.exit(main())
