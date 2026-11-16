"""N-of-1 experiment framework: the daily report job (docs/experiment-framework.md 8 and 10).

    python experiment_report.py            # what the scheduled workflow runs (experiment-report.yml)
    python experiment_report.py --dry-run  # read and compute, write nothing (no heartbeat either)

What one run does, per registered trial:

  no trial registered        nothing. A healthy no-op: one read of pds.experiments, a success
                             heartbeat with 0 records. This is the usual case. Notion is not called.
  before the first day       nothing to count yet; the Notion page is created (or kept up to date)
                             from the protocol, Status Registered.
  while the trial runs       PROGRESS ONLY: days elapsed, nights that have an outcome, missing
                             share, adherence. Counts, never an effect. In this mode the job does
                             not even load an HRV value: it asks which days HAVE one. The counts
                             go to the Notion page's properties.
  at the pre-registered end  the FINAL report, once: the registered analysis
                             (experiment_analysis.analyze_trial, which itself refuses before the
                             end), written to pds.experiment_reports, mirrored to the Notion page
                             (effect fields + the "Report (auto)" section), and the trial is marked
                             complete. A trial Riley stopped early gets its final report the same
                             way, labelled stopped_early. An A/A check (protocol kind: aa) also gets
                             its pass / fail verdict (docs/experiment-framework.md 12.2).

The effect is analysed only at the pre-registered end (Riley's decision 1, doc section 13).
There is deliberately no --as-of / --force option: the only clock is the database's behavioral
today, so nobody, including a later agent, can ask this job for an early look.

The final report waits FINAL_SETTLE_DAYS after the last day, so the last night's HRV, its Screen
Time sync and a next-morning check-in answer are in, and up to FINAL_MAX_WAIT_DAYS if that last
night's HRV has still not arrived. Once written it is never recomputed (a later run would use a
different re-draw seed); later runs only retry a Notion mirror that has not succeeded yet
(notion_synced_at is still empty).

pds.experiment_reports is the source of truth. The Notion mirror ("Onyx Experiments", doc 10.1,
experiment_notion.py) is best-effort: it needs NOTION_API_KEY, and a failed or skipped mirror
never loses the Supabase row; it turns the heartbeat partial.

Guards (heartbeat `failed`, message starts with "GUARD <name>:", AGENTS.md):
  GUARD experiment_alignment  hrv_alignment.ALIGNMENT_VERSION differs from the registered one
  GUARD experiment_schedule   the stored schedule is not what the committed seed generates

Heartbeat: pds.sync_log experiments|report on EVERY run, success and failure. `partial` = the
Notion mirror failed or is not configured, 3 or more nights in a row without an outcome,
adherence below a threshold the protocol registered (adherence.min_pct), or an A/A check that did
not pass.

The Actions logs of this repository are public. This script prints the experiment id, dates and
which report was written. It never prints a seed, an arm, an HRV value, an adherence figure or
an estimate; those go to the service-role-only table and to Riley's Notion page only.
"""
from __future__ import annotations

import argparse
import math
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, time as clock, timedelta
from typing import Any

import numpy as np

import experiment_adherence as adherence
import experiment_admin as admin
import experiment_analysis as analysis
import experiment_design as design
import experiment_notion as notion

SOURCE, DATA_TYPE = "experiments", "report"
REPORTS_SQL = admin.REPORTS_SQL
FINAL_SETTLE_DAYS = 2        # first run that may write the final report: last day + 2
FINAL_MAX_WAIT_DAYS = 4      # stop waiting for the last night's HRV at last day + 4
TAIL_MISSING_ALERT = 3       # nights in a row without an outcome that turn the heartbeat partial
MIN_DAYS_FOR_ADHERENCE_ALERT = 7
COVARIATE_MIN_NIGHTS = 3     # nights needed inside the previous 7 for the 7-day mean covariate
ACTIVE = ("registered", "running", "paused")
AA_MIN_ANSWER_PCT = 90.0     # Phase 2 is done when adherence is captured on 90% or more of days (doc 12)
EXCLUSION_RULE = ("whole blocks are left out when any of their days is a flight day "
                  "(pds.flight_day_unified.flew = 1), a time-zone transition day (onyx_is_transition_day) "
                  "or a pause declared before the block started")
PER_PROTOCOL_RULE = "Days known to be non-adherent are left out; days with no adherence evidence are kept."


class GuardError(RuntimeError):
    """An assumption the report depends on does not hold. The message starts with 'GUARD <name>:'."""


class ReportsTableMissing(RuntimeError):
    """pds.experiment_reports does not exist: the SQL file was never applied."""


def _is_missing_table(exc: Exception) -> bool:
    return str(getattr(exc, "code", "")) in ("PGRST205", "42P01")


# ---------------------------------------------------------------------------
# Database access (one small surface; the tests stand in for it)
# ---------------------------------------------------------------------------

class Store(admin.Store):
    FIELDS = ("experiment_id,title,status,question,arm_a_instruction,arm_b_instruction,control_arm,"
              "outcome_primary,alignment_version,mid_ms,design_type,block_len,n_a_per_block,n_blocks,n_days,"
              "start_date,planned_end,alpha,n_redraws,adherence,protocol,protocol_path,protocol_sha256,"
              "git_commit,seed_sha256,stopped_on,stop_reason,notion_page_id")

    def locked_experiments(self) -> list[dict]:
        """Every registered protocol (anything past draft), oldest first."""
        return self._t("experiments").select(self.FIELDS).neq("status", "draft").order("start_date").execute().data or []

    def _paged(self, query_for_range) -> list[dict]:
        out: list[dict] = []
        while True:
            rows = query_for_range(len(out), len(out) + 999).execute().data or []
            out.extend(rows)
            if len(rows) < 1000:
                return out

    def final_report(self, experiment_id: str) -> dict | None:
        try:
            rows = self._t("experiment_reports").select("as_of_date,payload,notion_synced_at").eq(
                "experiment_id", experiment_id).eq("report_kind", "final").limit(1).execute().data
        except Exception as exc:  # noqa: BLE001
            if _is_missing_table(exc):
                raise ReportsTableMissing() from None
            raise
        return rows[0] if rows else None

    def upsert_report(self, experiment_id: str, kind: str, as_of: date, payload: dict) -> None:
        try:
            self._t("experiment_reports").upsert(
                {"experiment_id": experiment_id, "report_kind": kind, "as_of_date": as_of.isoformat(), "payload": payload},
                on_conflict="experiment_id,report_kind,as_of_date").execute()
        except Exception as exc:  # noqa: BLE001
            if _is_missing_table(exc):
                raise ReportsTableMissing() from None
            raise

    def mark_mirrored(self, experiment_id: str, kind: str, as_of: date) -> None:
        """Stamp a report row as mirrored to Notion (the only change a final row accepts)."""
        self._t("experiment_reports").update({"notion_synced_at": datetime.now(adherence.ET).isoformat()}).eq(
            "experiment_id", experiment_id).eq("report_kind", kind).eq("as_of_date", as_of.isoformat()).execute()

    def revealed_days(self, experiment_id: str) -> set[str]:
        """The behavioral days whose arm Today has shown (first_revealed_at is set). Dates only."""
        rows = self._paged(lambda lo, hi: self._t("experiment_schedule").select("behavioral_date").eq(
            "experiment_id", experiment_id).not_.is_("first_revealed_at", "null").order("day_index").range(lo, hi))
        return {str(r["behavioral_date"])[:10] for r in rows}

    def outcome_days(self, first: date, last: date) -> set[str]:
        """The behavioral days in the range that HAVE a WHOOP HRV. The values are not selected."""
        rows = self._paged(lambda lo, hi: self._t("daily_health_matrix_behavioral").select("calendar_date").gte(
            "calendar_date", first.isoformat()).lte("calendar_date", last.isoformat()).not_.is_(
            "whoop_hrv_rmssd", "null").order("calendar_date").range(lo, hi))
        return {str(r["calendar_date"])[:10] for r in rows}

    def matrix(self, first: date, last: date) -> list[dict]:
        """Outcome columns per behavioral day. Called for the FINAL report only."""
        return self._paged(lambda lo, hi: self._t("daily_health_matrix_behavioral").select(
            "calendar_date,whoop_hrv_rmssd,whoop_rhr,eight_sleep_hrv,onyx_is_transition_day").gte(
            "calendar_date", first.isoformat()).lte("calendar_date", last.isoformat()).order("calendar_date").range(lo, hi))

    def flight_days(self, first: date, last: date) -> set[str]:
        rows = self._paged(lambda lo, hi: self._t("flight_day_unified").select("calendar_date").eq("flew", 1).gte(
            "calendar_date", first.isoformat()).lte("calendar_date", last.isoformat()).order("calendar_date").range(lo, hi))
        return {str(r["calendar_date"])[:10] for r in rows}

    def day_rows(self, experiment_id: str) -> list[dict]:
        """The check-in answers ("Followed today's arm?") and declared pauses of the trial."""
        return self._paged(lambda lo, hi: self._t("experiment_days").select(
            "behavioral_date,self_report,excluded,exclusion_declared_at").eq(
            "experiment_id", experiment_id).order("behavioral_date").range(lo, hi))

    def screen_rows(self, first: date, last: date) -> list[dict]:
        return self._paged(lambda lo, hi: self._t("phone_usage_daily").select(
            "behavioral_date,sleep_start,synced_at,minutes_last_hour_before_sleep_est").gte(
            "behavioral_date", first.isoformat()).lte("behavioral_date", last.isoformat()).order("behavioral_date").range(lo, hi))

    def set_status(self, experiment_id: str, status: str) -> None:
        self._t("experiments").update({"status": status}).eq("experiment_id", experiment_id).execute()

    def set_notion_page(self, experiment_id: str, page_id: str) -> None:
        """One of the fields the protocol lock leaves open (experiments_guard)."""
        self._t("experiments").update({"notion_page_id": page_id}).eq("experiment_id", experiment_id).execute()


def get_store() -> Store:
    import os

    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    from supabase import create_client
    return Store(create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]))


# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------

def _day(value: Any) -> date:
    return value if isinstance(value, date) and not isinstance(value, datetime) else date.fromisoformat(str(value)[:10])


def _clean(value: Any) -> Any:
    """JSON-safe copy for a jsonb column: numpy scalars to Python, dates to text, NaN to null,
    an unbounded interval end to the text 'inf' / '-inf'."""
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_clean(v) for v in value]
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, (float, np.floating)):
        number = float(value)
        if math.isnan(number):
            return None
        if math.isinf(number):
            return "inf" if number > 0 else "-inf"
        return number
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def last_trial_day(exp: dict[str, Any]) -> date:
    """The last behavioral day that counts: the planned end, or the stop day if Riley stopped early."""
    end = _day(exp["planned_end"])
    return min(end, _day(exp["stopped_on"])) if exp.get("stopped_on") else end


def final_is_due(today: date, last_day: date, last_night_has_outcome: bool) -> bool:
    """May this run write the final report? Never before the settle days have passed."""
    if today < last_day + timedelta(days=FINAL_SETTLE_DAYS):
        return False
    return last_night_has_outcome or today >= last_day + timedelta(days=FINAL_MAX_WAIT_DAYS)


def check_alignment(exp: dict[str, Any], current: str) -> None:
    if exp.get("alignment_version") != current:
        raise GuardError(
            f"GUARD experiment_alignment: {exp['experiment_id']} was registered under alignment rule "
            f"{exp.get('alignment_version')!r} but hrv_alignment.ALIGNMENT_VERSION is now {current!r}; "
            "the report stops instead of mixing two rules")


def check_schedule(store: Store, exp: dict[str, Any]) -> tuple[list[str], str]:
    """Regenerate the schedule from the stored seed and compare it with the stored rows.
    Returns (arms for every scheduled day, the seed as hex). Neither is ever printed."""
    experiment_id = exp["experiment_id"]
    seed_hex = store.seed_hex(experiment_id)
    if not seed_hex or design.seed_commitment(bytes.fromhex(seed_hex)) != exp["seed_sha256"]:
        raise GuardError(f"GUARD experiment_schedule: the stored seed of {experiment_id} does not match its commitment")
    arms = design.generate_schedule(bytes.fromhex(seed_hex), exp["n_blocks"], exp["block_len"], exp["n_a_per_block"])
    stored = store.schedule(experiment_id)
    start = _day(exp["start_date"])
    mismatched = sum(
        1 for i, arm in enumerate(arms)
        if i >= len(stored) or stored[i]["day_index"] != i or stored[i]["arm"] != arm
        or _day(stored[i]["behavioral_date"]) != start + timedelta(days=i))
    if mismatched or len(stored) != len(arms):
        raise GuardError(f"GUARD experiment_schedule: {experiment_id} has {mismatched} day(s) that differ from the "
                         f"schedule its seed generates ({len(stored)} stored, {len(arms)} expected)")
    return arms, seed_hex


def resolve_adherence(exp: dict[str, Any], arms: list[str], n_days: int, day_rows: list[dict],
                      screen_rows: list[dict]) -> list[adherence.DayAdherence]:
    """Adherence of the first n_days trial days (all of them finished)."""
    start = _day(exp["start_date"])
    rule = adherence.objective_rule(exp.get("adherence"))
    reports = {str(r["behavioral_date"])[:10]: r.get("self_report") for r in day_rows}
    screens = {str(r["behavioral_date"])[:10]: r for r in screen_rows}
    out = []
    for i in range(n_days):
        day = start + timedelta(days=i)
        minutes = adherence.settled_screen_minutes(screens.get(day.isoformat()), day) if rule else None
        out.append(adherence.resolve_day(arms[i], rule, minutes, reports.get(day.isoformat())))
    return out


def excluded_blocks(exp: dict[str, Any], n_days: int, flights: set[str], transitions: set[str],
                    day_rows: list[dict]) -> dict[str, Any]:
    """Whole blocks to leave out (protocol 'exclusions'), decided from travel data and pauses
    declared ahead. HRV is not an input."""
    start, block_len = _day(exp["start_date"]), int(exp["block_len"])
    reasons: dict[int, str] = {}
    late = 0
    declared = {str(r["behavioral_date"])[:10]: r for r in day_rows if r.get("excluded")}
    for i in range(n_days):
        day, block = start + timedelta(days=i), i // block_len
        reason = None
        if day.isoformat() in flights:
            reason = "flight day"
        elif day.isoformat() in transitions:
            reason = "time-zone transition day"
        elif day.isoformat() in declared:
            block_start = datetime.combine(start + timedelta(days=block * block_len), clock(6, 0), tzinfo=adherence.ET)
            declared_at = adherence._instant(declared[day.isoformat()].get("exclusion_declared_at"))
            if declared_at is not None and declared_at < block_start:
                reason = "declared pause"
            else:
                late += 1
        if reason and block not in reasons:
            reasons[block] = reason
    counts: dict[str, int] = {}
    for reason in reasons.values():
        counts[reason] = counts.get(reason, 0) + 1
    return {
        "rule": EXCLUSION_RULE,
        "blocks": sorted(reasons),
        "by_reason": [{"reason": reason, "count": count} for reason, count in sorted(counts.items())],
        "late_declarations": late,
    }


def unrecognised_sensitivity(exp: dict[str, Any]) -> list[str]:
    """Sensitivity analyses the protocol registered that this job does not run (reported, not hidden)."""
    registered = ((exp.get("protocol") or {}).get("analysis") or {}).get("sensitivity") or []
    out = []
    for item in registered if isinstance(registered, list) else [registered]:
        text = str(item).lower()
        if "ln" in text.split() or "ln(" in text or "log" in text or "per-protocol" in text or "per protocol" in text:
            continue
        if "hrv_lag1" in text or "hrv_7d_mean" in text:
            continue
        if "travel" in text:
            out.append(f"{item}: flight and transition blocks are already left out of the primary analysis, "
                       "so there is no separate fit")
            continue
        out.append(str(item))
    return out


def aa_check(exp: dict[str, Any], report: dict[str, Any], n_done: int, revealed: set[str],
             answered: int) -> dict[str, Any] | None:
    """The verdict of an A/A check (protocol kind: aa), None for a treatment trial.

    Both arms carried the same instruction, so a significant difference can only be a false one.
    With identical arms Fisher's sharp null (the schedule changes no night) holds exactly, so the
    check reads its randomization p (p_value_no_effect): exact, and as sensitive as the design
    allows. The same-night p_value also allows for any carryover, which makes it conservative and,
    on a 4-week check, close to 1 (doc 8.1), so it is used only for a report stored before
    p_value_no_effect existed. `p_source` names the one used.
    That p counts only when the report marks it supported (inference.outputs[p_source].supported):
    missing nights caused by the arm invalidate Fisher's test too, so a non-significant p from an
    unsupported test is not a pass (`inference_supported`, with the failed checks' reasons in
    `unsupported_reasons`). A report stored before the inference block existed carries no mark.
    The last two items are the rest of Phase 2's "done when" (doc 12): every trial day was revealed
    on Today, and 90% or more of the days have a check-in answer. Report re-runs being idempotent is
    shown by the tests and by the final report being written once.
    """
    if design.trial_kind(exp.get("protocol")) != design.KIND_AA:
        return None
    start = _day(exp["start_date"])
    days = [(start + timedelta(days=i)).isoformat() for i in range(n_done)]
    days_revealed = sum(1 for d in days if d in revealed)

    def number(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool)

    p_source = "p_value_no_effect" if number(report.get("p_value_no_effect")) else "p_value"
    p_value = report.get(p_source)
    analysed = number(p_value) and not report.get("not_analysable")
    false_effect = bool(p_value < float(exp["alpha"])) if analysed else None
    answer_pct = round(100.0 * answered / n_done, 1) if n_done else None
    # Whether the test the check reads rests on assumptions that held (None = no inference block).
    inference = report.get("inference") if isinstance(report.get("inference"), dict) else {}
    outputs = inference.get("outputs") if isinstance(inference.get("outputs"), dict) else {}
    entry = outputs.get(p_source) if isinstance(outputs.get(p_source), dict) else {}
    supported = entry.get("supported") if isinstance(entry.get("supported"), bool) else None
    if supported is None and p_source in (inference.get("unsupported_outputs") or []):
        supported = False
    needs = set(entry.get("needs") or [])
    unsupported_reasons = [str(c.get("reason")) for c in inference.get("checks") or []
                           if isinstance(c, dict) and c.get("status") == "failed"
                           and (needs & set(c.get("covers") or []) or not needs)] if supported is False else []
    done = {
        "no_false_effect": false_effect is False,
        "inference_supported": supported is not False,
        "every_day_revealed": n_done > 0 and days_revealed == n_done,
        "answers_on_90pct_of_days": answer_pct is not None and answer_pct >= AA_MIN_ANSWER_PCT,
    }
    return {
        "expected": "no difference: both arms carried the same instruction",
        "p_source": p_source,
        "p_value": float(p_value) if analysed else None,
        "p_supported": supported,
        "unsupported_reasons": unsupported_reasons,
        "false_effect": false_effect,
        "days": n_done,
        "days_revealed": days_revealed,
        "days_answered": answered,
        "answer_pct": answer_pct,
        "phase2_done": done,
        "passed": all(done.values()),
    }


# ---------------------------------------------------------------------------
# The Notion mirror, best-effort (doc 10.3)
# ---------------------------------------------------------------------------

class Mirror:
    """Wraps experiment_notion so a Notion failure becomes a sentence for the heartbeat, never a
    crash, and never costs the Supabase row (which is always written first)."""

    def __init__(self, pages: notion.ExperimentPages | None = None, *, dry_run: bool = False):
        self._pages, self._resolved, self.dry_run = pages, pages is not None, dry_run

    def _get(self) -> notion.ExperimentPages | None:
        if not self._resolved:
            transport = notion.transport_from_env()
            self._pages, self._resolved = (notion.ExperimentPages(transport) if transport else None), True
        return self._pages

    def sync(self, store: Store, exp: dict[str, Any], out: "Outcome", *, kind: str | None = None,
             as_of: date | None = None, payload: dict[str, Any] | None = None) -> bool:
        """Write the experiment's page: the protocol fields (kind None), plus the counts (progress)
        or everything (final). A mirrored report row gets its notion_synced_at stamp."""
        if self.dry_run:
            return False
        experiment_id = exp["experiment_id"]
        pages = self._get()
        if pages is None:
            out.problems.append(f"{experiment_id}: the Notion mirror was skipped (NOTION_API_KEY is not set)")
            return False
        try:
            if kind == "final":
                page_id, created = pages.write_final(exp, payload or {})
            else:
                page_id, created = pages.write_progress(exp, payload if kind == "progress" else None)
        except notion.NotionError as exc:
            out.problems.append(f"{experiment_id}: the Notion mirror failed ({exc})")
            return False
        except Exception as exc:  # noqa: BLE001 - the mirror must never fail the run
            out.problems.append(f"{experiment_id}: the Notion mirror failed ({type(exc).__name__})")
            return False
        if page_id and page_id != exp.get("notion_page_id"):
            store.set_notion_page(experiment_id, page_id)
            exp["notion_page_id"] = page_id
        if kind and as_of is not None:
            store.mark_mirrored(experiment_id, kind, as_of)
        if created:
            out.lines.append(f"{experiment_id}: Notion page created in Onyx Experiments.")
        return True


# ---------------------------------------------------------------------------
# One experiment
# ---------------------------------------------------------------------------

@dataclass
class Outcome:
    status: str = "success"
    records: int = 0
    lines: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)     # reasons the run is partial

    @property
    def error(self) -> str | None:
        return "; ".join(self.problems)[:500] if self.problems else None


def _progress(exp: dict[str, Any], today: date, n_done: int, outcome_days: set[str],
              days: list[adherence.DayAdherence], awaiting_final: bool) -> dict[str, Any]:
    start = _day(exp["start_date"])
    have = [(start + timedelta(days=i)).isoformat() in outcome_days for i in range(n_done)]
    tail = 0
    for flag in reversed(have):
        if flag:
            break
        tail += 1
    summary = adherence.summarize(days)
    return {
        "report_kind": "progress",
        "experiment_id": exp["experiment_id"],
        "as_of": today.isoformat(),
        "status": exp["status"],
        "days_elapsed": n_done,
        "n_days": int(exp["n_days"]),
        "nights_with_outcome": sum(have),
        "missing_pct": round(100.0 * (1 - sum(have) / n_done), 1) if n_done else None,
        "tail_missing_nights": tail,
        "adherence_pct": summary["adherence_pct"],
        "adherence": summary,
        "awaiting_final": awaiting_final,
    }


def _final(store: Store, exp: dict[str, Any], today: date, arms: list[str], seed_hex: str, n_done: int,
           day_rows: list[dict], screen_rows: list[dict], alignment_version: str) -> dict[str, Any]:
    """Run the registered analysis. experiment_analysis.analyze_trial refuses before the end."""
    experiment_id, start, n_sched = exp["experiment_id"], _day(exp["start_date"]), int(exp["n_days"])
    # The registered protocol's declarations for the untestable parts of the model (doc 8.1).
    registered = (exp.get("protocol") or {}).get("analysis") if isinstance(exp.get("protocol"), dict) else None
    registered = registered if isinstance(registered, dict) else {}
    carryover_nights = registered.get("carryover_nights")
    justification = registered.get("model_justification")
    spec = analysis.TrialSpec(
        experiment_id=experiment_id, start=start, planned_end=_day(exp["planned_end"]), mid_ms=float(exp["mid_ms"]),
        block_len=int(exp["block_len"]), n_a=int(exp["n_a_per_block"]), alpha=float(exp["alpha"]),
        n_redraws=int(exp["n_redraws"]), control_arm=exp.get("control_arm") or "B",
        stopped_on=_day(exp["stopped_on"]) if exp.get("stopped_on") else None,
        kind=design.trial_kind(exp.get("protocol")),
        carryover_nights=carryover_nights if isinstance(carryover_nights, int) and not isinstance(carryover_nights, bool) else None,
        model_justification=justification if isinstance(justification, str) else None,
        inference_method=registered.get("inference_method") if isinstance(registered.get("inference_method"), str) else None)
    analysis.assert_reportable(spec, today)

    first, last = start - timedelta(days=7), start + timedelta(days=n_sched)
    rows = {str(r["calendar_date"])[:10]: r for r in store.matrix(first, last)}

    def series(column: str, offset: int = 0, length: int = n_sched, begin: date = start) -> np.ndarray:
        values = []
        for i in range(length):
            value = (rows.get((begin + timedelta(days=i + offset)).isoformat()) or {}).get(column)
            values.append(float(value) if value is not None else np.nan)
        return np.array(values, dtype=float)

    y = series("whoop_hrv_rmssd")
    history = series("whoop_hrv_rmssd", length=n_sched + 7, begin=first)      # index j = day (start - 7 + j)
    lag1 = history[6:6 + n_sched]                                              # the night before each day
    mean7 = np.full(n_sched, np.nan)
    for i in range(n_sched):
        window = history[i:i + 7]
        if (~np.isnan(window)).sum() >= COVARIATE_MIN_NIGHTS:
            mean7[i] = float(np.nanmean(window))

    days = resolve_adherence(exp, arms, n_done, day_rows, screen_rows)
    adherent = np.ones(n_sched, dtype=bool)
    for i, day in enumerate(days):
        adherent[i] = day.adherent is not False
    transitions = {d for d, r in rows.items() if r.get("onyx_is_transition_day")}
    exclusions = excluded_blocks(exp, n_done, store.flight_days(start, start + timedelta(days=max(n_done, 1) - 1)),
                                 transitions, day_rows)

    data = analysis.TrialData(
        arms=arms, outcome=y, excluded_blocks=set(exclusions["blocks"]), adherent=adherent,
        # Built from earlier nights, inside the trial too, so they depend on earlier arms: these fits'
        # p-value and interval are approximate, their no-effect p exact (analysis.output_semantics).
        covariates={"hrv_lag1": lag1, "hrv_7d_mean": mean7},
        # Eight Sleep keys a night by its wake-up day, so the sleep that closes day D is on row D + 1.
        secondary_outcomes={"eight_sleep_hrv": series("eight_sleep_hrv", offset=1), "whoop_rhr": series("whoop_rhr")})
    base = {
        "report_kind": "final", "experiment_id": experiment_id, "as_of": today.isoformat(),
        "status": exp["status"], "stopped_early": bool(exp.get("stopped_on")), "stop_reason": exp.get("stop_reason"),
        "days_elapsed": n_done, "n_days": n_sched, "mid_ms": float(exp["mid_ms"]), "alpha": float(exp["alpha"]),
        "nights_with_outcome": int((~np.isnan(y[:n_done])).sum()),
        "missing_pct": round(100.0 * float(np.isnan(y[:n_done]).mean()), 1) if n_done else None,
        "adherence": adherence.summarize(days), "exclusions": exclusions,
        "per_protocol_rule": PER_PROTOCOL_RULE, "not_run": unrecognised_sensitivity(exp),
        "allocation": {"seed_hex": seed_hex, "seed_sha256": exp["seed_sha256"], "generator": design.GENERATOR,
                       "days_verified": len(arms)},
        "protocol_path": exp.get("protocol_path"), "protocol_sha256": exp.get("protocol_sha256"),
        "git_commit": exp.get("git_commit"), "alignment_version": alignment_version,
    }
    base["adherence_pct"] = base["adherence"]["adherence_pct"]
    try:
        report = analysis.analyze_trial(spec, data, today)
    except ValueError as exc:
        # Too few nights to fit the model (a trial stopped in its first days). Still a final report.
        report = {"decision": None, "not_analysable": str(exc)}
    merged = {**report, **base}
    if design.trial_kind(exp.get("protocol")) == design.KIND_AA:
        answered = sum(1 for d in days if d.self_report is not None)
        merged["aa_check"] = aa_check(exp, merged, n_done, store.revealed_days(experiment_id), answered)
    return _clean(merged)


def process(store: Store, exp: dict[str, Any], today: date, dry_run: bool, alignment_version: str, out: Outcome,
            mirror: Mirror | None = None) -> None:
    experiment_id = exp["experiment_id"]
    mirror = mirror or Mirror(dry_run=dry_run)
    existing = store.final_report(experiment_id)
    if existing:
        if exp["status"] == "running" and not dry_run:
            store.set_status(experiment_id, "complete")
            exp["status"] = "complete"
        out.lines.append(f"{experiment_id}: the final report was written on {str(existing['as_of_date'])[:10]}; nothing to recompute.")
        if not existing.get("notion_synced_at") and not dry_run:
            # The page missed the final report (Notion was down, or the key was missing): retry it
            # from the stored payload, never from a new analysis.
            if mirror.sync(store, exp, out, kind="final", as_of=_day(existing["as_of_date"]), payload=existing["payload"]):
                out.lines.append(f"{experiment_id}: the final report is now on its Notion page.")
        return

    check_alignment(exp, alignment_version)
    arms, seed_hex = check_schedule(store, exp)

    start, last_day = _day(exp["start_date"]), last_trial_day(exp)
    if today <= start and exp["status"] in ACTIVE:
        out.lines.append(f"{experiment_id}: registered; the first day is {start}. No nights to count yet.")
        mirror.sync(store, exp, out)
        return

    # Finished behavioral days: before today, and not past the last trial day.
    n_done = max(0, min((min(last_day, today - timedelta(days=1)) - start).days + 1, int(exp["n_days"])))
    done_last = start + timedelta(days=max(n_done, 1) - 1)
    outcome_days = store.outcome_days(start, done_last) if n_done else set()
    day_rows = store.day_rows(experiment_id) if n_done else []
    screen_rows = store.screen_rows(start, done_last) if n_done and adherence.objective_rule(exp.get("adherence")) else []

    if final_is_due(today, last_day, last_day.isoformat() in outcome_days or n_done == 0):
        report = _final(store, exp, today, arms, seed_hex, n_done, day_rows, screen_rows, alignment_version)
        if dry_run:
            out.lines.append(f"{experiment_id}: the final report is due and was computed (dry run: nothing written).")
            return
        store.upsert_report(experiment_id, "final", today, report)
        if exp["status"] == "running":
            store.set_status(experiment_id, "complete")
            exp["status"] = "complete"
        elif exp["status"] in ("registered", "paused"):
            out.problems.append(f"{experiment_id}: the final report is written but the trial is still {exp['status']}; "
                                "its status can only be closed with experiment_admin.py stop")
        check = report.get("aa_check")
        if check and not check.get("passed"):
            # Which item failed is named; no number about Riley is (the log and the heartbeat are public).
            failed = [name for name, ok in (check.get("phase2_done") or {}).items() if not ok]
            out.problems.append(f"{experiment_id}: the A/A check did not pass ({', '.join(failed)}); "
                                "see the final report before registering a real trial")
        out.lines.append(f"{experiment_id}: FINAL report written ({'stopped early' if exp.get('stopped_on') else 'pre-registered end'} "
                         f"{last_day}). The result is in pds.experiment_reports and on the Notion page, not in this log.")
        mirror.sync(store, exp, out, kind="final", as_of=today, payload=report)
        return

    days = resolve_adherence(exp, arms, n_done, day_rows, screen_rows)
    awaiting = today > last_day
    progress = _clean(_progress(exp, today, n_done, outcome_days, days, awaiting))
    if not dry_run:
        store.upsert_report(experiment_id, "progress", today, progress)
    if not awaiting and progress["tail_missing_nights"] >= TAIL_MISSING_ALERT:
        out.problems.append(f"{experiment_id}: {progress['tail_missing_nights']} nights in a row without an HRV outcome "
                            "(wear the WHOOP every night during a trial)")
    threshold = (exp.get("adherence") or {}).get("min_pct")
    summary = progress["adherence"]
    if (isinstance(threshold, (int, float)) and not isinstance(threshold, bool) and summary["adherence_pct"] is not None
            and summary["days_with_evidence"] >= MIN_DAYS_FOR_ADHERENCE_ALERT and summary["adherence_pct"] < threshold):
        out.problems.append(f"{experiment_id}: adherence is below the threshold the protocol registered")
    out.lines.append(
        f"{experiment_id}: day {min(n_done + 1, int(exp['n_days']))} of {exp['n_days']}; progress counts "
        + ("computed (dry run: nothing written) " if dry_run else "written ")
        + ("(the trial has ended; the final report follows once the last night has settled)." if awaiting
           else f"(no effect is computed before {last_day})."))
    # The row is stored first; the mirror can only add a problem, never lose it.
    mirror.sync(store, exp, out, kind="progress", as_of=today, payload=progress)


def run(store: Store, *, today: date | None = None, dry_run: bool = False,
        alignment_version: str | None = None, pages: notion.ExperimentPages | None = None) -> Outcome:
    """`pages` is the Notion writer; None builds one from NOTION_API_KEY on first use (never when no
    trial is registered)."""
    out = Outcome()
    mirror = Mirror(pages, dry_run=dry_run)
    experiments = store.locked_experiments()
    if not experiments:
        out.lines.append("No trial is registered. Nothing to report.")
        return out
    today = today or store.behavioral_today()
    if alignment_version is None:
        import hrv_alignment
        alignment_version = hrv_alignment.ALIGNMENT_VERSION
    for exp in experiments:
        process(store, exp, today, dry_run, alignment_version, out, mirror)
        out.records += 1
    if out.problems:
        out.status = "partial"
    return out


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None, store: Store | None = None, today: date | None = None,
         pages: notion.ExperimentPages | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="read and compute, write nothing")
    args = ap.parse_args(argv)

    started = time.time()
    store = store or get_store()
    status, records, error, code = "success", 0, None, 0
    try:
        out = run(store, today=today, dry_run=args.dry_run, pages=pages)
        status, records, error = out.status, out.records, out.error
        print("\n".join(out.lines))
        if out.problems:
            print("PARTIAL:\n  - " + "\n  - ".join(out.problems))
    except GuardError as exc:
        print(str(exc), file=sys.stderr)
        status, error, code = "failed", str(exc)[:500], 1
    except ReportsTableMissing:
        error = f"pds.experiment_reports does not exist: apply {REPORTS_SQL}, then re-run the Experiment Report workflow"
        print(f"FAILED: {error}", file=sys.stderr)
        status, code = "failed", 1
    except Exception as exc:  # noqa: BLE001 - every run leaves a heartbeat
        # A database refusal carries its own sentence in .message; .details can quote a row, so it
        # is never printed. Anything else prints its type only.
        message = getattr(exc, "message", None)
        text = f"{type(exc).__name__}: {message}" if isinstance(message, str) and message else type(exc).__name__
        print(f"FAILED: {text}", file=sys.stderr)
        status, error, code = "failed", text[:500], 1
    if not args.dry_run:
        from sync_log_helper import log_sync
        log_sync(store.supa, SOURCE, DATA_TYPE, status, records=records, started_at=started, error=error)
    return code


if __name__ == "__main__":
    sys.exit(main())
