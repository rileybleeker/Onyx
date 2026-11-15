"""N-of-1 experiment framework: per-day adherence (pure, no I/O).

Design: docs/experiment-framework.md 4.5 and 9. A trial day has up to two pieces of evidence
about whether Riley followed the arm:

  * objective   what a device measured, when the protocol names a source Onyx can read
                (adherence.objective = {source, max, arm}). It applies to the days of the named
                arm only: the other arm is "usual behaviour", so there is nothing to check.
  * self-report the check-in answer "Followed the arm?" (yes / partly / no), stored in
                pds.experiment_days by POST /api/experiments/adherence.

The objective check decides when it exists; the self-report is the fallback when it does not,
and a confirmation when it does (a disagreement is counted, never resolved by hand). A day with
neither is "unknown": it is never guessed.

The only objective source so far is Screen Time's estimate of phone minutes in the hour before
WHOOP sleep onset. That number reads 0, not NULL, as soon as the sleep is scored, even when the
phone has not sent the hours around bedtime yet, so it counts only once it is SETTLED: the same
readiness rule as frontend/src/lib/screen-time.ts (bedtimeReady) and
hrv_analysis.py:merge_screen_time_features. The database view pds.experiment_day_status does not
apply that rule, which is why the report job resolves adherence here and not from the view.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any, Iterable
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
SCREEN_SOURCE = "pds.phone_usage_daily.minutes_last_hour_before_sleep_est"
SELF_REPORTS = ("yes", "partly", "no")


def _instant(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=ZoneInfo("UTC"))
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=ZoneInfo("UTC"))
    return None


def settled_screen_minutes(row: dict[str, Any] | None, day: date) -> float | None:
    """Phone minutes in the hour before sleep onset for behavioral day `day`, or None until the
    number can be trusted:

      * a sync happened after the day ended (synced_at >= day + 1 at 06:00 ET),
      * the WHOOP sleep that closes the day is scored (sleep_start is set),
      * that sync is at least an hour past sleep onset.
    """
    if not row or str(row.get("behavioral_date"))[:10] != day.isoformat():
        return None
    synced, sleep_start = _instant(row.get("synced_at")), _instant(row.get("sleep_start"))
    minutes = row.get("minutes_last_hour_before_sleep_est")
    if synced is None or sleep_start is None or minutes is None:
        return None
    day_end = datetime.combine(day + timedelta(days=1), time(6, 0), tzinfo=ET)
    if synced < day_end or synced < sleep_start + timedelta(hours=1):
        return None
    try:
        return float(minutes)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class DayAdherence:
    adherent: bool | None        # None = no evidence either way
    basis: str                   # 'objective' | 'self_report' | 'none'
    objective: bool | None       # the objective check alone (None = not applicable or not settled)
    self_report: str | None      # 'yes' | 'partly' | 'no' | None
    conflict: bool               # both exist and disagree


def objective_rule(adherence: dict[str, Any] | None) -> dict[str, Any] | None:
    """The protocol's objective rule if it is one this module can check, else None."""
    rule = (adherence or {}).get("objective")
    if not isinstance(rule, dict) or rule.get("source") != SCREEN_SOURCE or rule.get("arm") not in ("A", "B"):
        return None
    limit = rule.get("max")
    if isinstance(limit, bool) or not isinstance(limit, (int, float)):
        return None
    return {"source": SCREEN_SOURCE, "max": float(limit), "arm": rule["arm"]}


def resolve_day(arm: str, rule: dict[str, Any] | None, settled_minutes: float | None,
                self_report: str | None) -> DayAdherence:
    """Adherence of one finished trial day. "partly" counts as not adherent."""
    report = self_report if self_report in SELF_REPORTS else None
    objective = None
    if rule is not None and arm == rule["arm"] and settled_minutes is not None:
        objective = settled_minutes <= rule["max"]
    if objective is not None:
        return DayAdherence(objective, "objective", objective, report,
                            report is not None and (report == "yes") != objective)
    if report is not None:
        return DayAdherence(report == "yes", "self_report", None, report, False)
    return DayAdherence(None, "none", None, None, False)


def summarize(days: Iterable[DayAdherence]) -> dict[str, Any]:
    """Counts for the progress and final reports. The percentage is over days with evidence."""
    days = list(days)
    known = [d for d in days if d.adherent is not None]
    adherent = sum(1 for d in known if d.adherent)
    return {
        "days": len(days),
        "days_with_evidence": len(known),
        "days_adherent": adherent,
        "adherence_pct": round(100.0 * adherent / len(known), 1) if known else None,
        "days_objective": sum(1 for d in days if d.basis == "objective"),
        "days_self_report_only": sum(1 for d in days if d.basis == "self_report"),
        "days_unknown": len(days) - len(known),
        "conflicts": sum(1 for d in days if d.conflict),
    }
