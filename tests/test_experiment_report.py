"""Experiment framework (N-of-1 trials): adherence resolution and the daily report job.

Covers
  * experiment_adherence: Screen Time minutes count only once they are settled; the objective
    check decides, the check-in answer is the fallback and the confirmation; unknown stays unknown;
  * experiment_report against an in-memory store:
      - no trial registered is a healthy no-op (one read, a success heartbeat);
      - while a trial runs only PROGRESS is written: counts, no effect, and the job never loads an
        HRV value; nothing printed shows a seed, an arm or a number about Riley;
      - the final report is written once, only after the pre-registered end has settled, with the
        registered analysis, block exclusions decided from travel data, the covariate and
        second-sensor fits and the seed reveal; a re-run recomputes nothing;
      - a trial stopped early, and one with too few nights, still get a final report;
      - GUARD experiment_alignment / experiment_schedule, a missing report table and an unexpected
        error each leave a failed heartbeat;
      - there is no way to ask for an early analysis, and the job does not talk to Notion yet;
  * sql/experiment_adherence_reports_schema.sql is additive and service-role only, and its two
    check-in functions answer only for today / yesterday of a running trial whose arm was shown;
  * the scheduled workflow, once Riley has added it (.github/ is a protected path for agents).

Synthetic data only. No network, no credentials, no database.

Run: python tests/test_experiment_report.py
"""
import hashlib
import io
import json
import re
import sys
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

import experiment_adherence as ad  # noqa: E402
import experiment_admin as admin  # noqa: E402
import experiment_design as ed  # noqa: E402
import experiment_report as er  # noqa: E402

SEED = hashlib.sha256(b"onyx experiment report test seed (synthetic)").digest()
START = date(2030, 1, 7)
N_BLOCKS = 20
N_DAYS = N_BLOCKS * 4
END = START + timedelta(days=N_DAYS - 1)
ALIGNMENT = "same_night_v1"
EFFECT = 25.0
EFFECT_KEYS = {"estimate", "ci_low", "ci_high", "p_value", "carryover", "two_night_total", "decision",
               "sensitivity", "secondary_outcomes", "allocation"}
RULE = {"source": ad.SCREEN_SOURCE, "max": 5, "arm": "A"}
SQL_FILE = ROOT / admin.REPORTS_SQL


def _day(i):
    return START + timedelta(days=i)


class FakeSupa:
    """Only what sync_log_helper.log_sync touches."""

    def __init__(self):
        self.heartbeats = []

    def schema(self, _):
        return self

    def table(self, name):
        assert name == "sync_log"
        return self

    def insert(self, row):
        self.heartbeats.append(row)
        return self

    def execute(self):
        return self


class FakeStore:
    """In-memory stand-in for experiment_report.Store. It enforces the two report guards of
    the SQL file so a job that broke them would fail here too."""

    def __init__(self, today, status="running", missing=(), planted=EFFECT):
        self.supa = FakeSupa()
        self.today = today
        self.calls = []
        self.arms = ed.generate_schedule(SEED, N_BLOCKS)
        self.exp = {
            "experiment_id": "EXP-901", "title": "A synthetic evening routine", "status": status,
            "question": "Does the synthetic routine change the synthetic outcome?",
            "arm_a_instruction": "Synthetic instruction for arm A.", "arm_b_instruction": "Synthetic instruction for arm B.",
            "control_arm": "B", "outcome_primary": "synthetic HRV", "alignment_version": ALIGNMENT, "mid_ms": 8,
            "design_type": ed.DESIGN_DAILY_BLOCKS, "block_len": 4, "n_a_per_block": 2, "n_blocks": N_BLOCKS,
            "n_days": N_DAYS, "start_date": START.isoformat(), "planned_end": END.isoformat(), "alpha": 0.05,
            "n_redraws": 999, "adherence": {"objective": dict(RULE)},
            "protocol": {"analysis": {"sensitivity": ["ln HRV", "per-protocol", "plus hrv_lag1 covariate",
                                                       "excluding travel blocks", "a synthetic unbuilt analysis"]}},
            "protocol_path": "docs/experiments/EXP-901.md", "protocol_sha256": "a" * 64, "git_commit": "c0ffee",
            "seed_sha256": ed.seed_commitment(SEED), "stopped_on": None, "stop_reason": None, "notion_page_id": None,
        }
        self.exps = [self.exp]
        self.seed = SEED.hex()
        self.sched = [{"day_index": i, "behavioral_date": _day(i).isoformat(), "arm": arm} for i, arm in enumerate(self.arms)]
        rng = np.random.default_rng(7)
        self.rows = {}
        for i in range(-7, N_DAYS + 1):
            arm_a = 0 <= i < N_DAYS and self.arms[i] == "A"
            hrv = 70 + rng.normal(0, 5) + (planted if arm_a else 0.0)
            self.rows[_day(i).isoformat()] = {
                "calendar_date": _day(i).isoformat(), "whoop_hrv_rmssd": None if i in missing else round(float(hrv), 2),
                "whoop_rhr": round(55 + float(rng.normal(0, 2)), 1),
                "eight_sleep_hrv": round(68 + float(rng.normal(0, 5)), 1), "onyx_is_transition_day": False}
        self.flights, self.days, self.screens, self.reports = set(), [], [], {}
        self.reports_missing = False

    # -- reads --------------------------------------------------------------------------
    def locked_experiments(self):
        self.calls.append("locked_experiments")
        return [dict(e) for e in self.exps if e["status"] != "draft"]

    def behavioral_today(self):
        self.calls.append("behavioral_today")
        return self.today

    def seed_hex(self, _id):
        return self.seed

    def schedule(self, _id):
        return [dict(r) for r in self.sched]

    def final_report(self, experiment_id):
        self.calls.append("final_report")
        if self.reports_missing:
            raise er.ReportsTableMissing()
        for (eid, kind, _), row in self.reports.items():
            if eid == experiment_id and kind == "final":
                return dict(row)
        return None

    def outcome_days(self, first, last):
        self.calls.append("outcome_days")
        return {d for d, r in self.rows.items() if first.isoformat() <= d <= last.isoformat() and r["whoop_hrv_rmssd"] is not None}

    def matrix(self, first, last):
        self.calls.append("matrix")
        return [dict(r) for d, r in sorted(self.rows.items()) if first.isoformat() <= d <= last.isoformat()]

    def flight_days(self, first, last):
        return {d for d in self.flights if first.isoformat() <= d <= last.isoformat()}

    def day_rows(self, _id):
        return [dict(r) for r in self.days]

    def screen_rows(self, first, last):
        self.calls.append("screen_rows")
        return [dict(r) for r in self.screens if first.isoformat() <= r["behavioral_date"] <= last.isoformat()]

    # -- writes -------------------------------------------------------------------------
    def upsert_report(self, experiment_id, kind, as_of, payload):
        self.calls.append(f"upsert_report:{kind}")
        if self.reports_missing:
            raise er.ReportsTableMissing()
        json.dumps(payload, allow_nan=False)                      # a jsonb column takes neither NaN nor inf
        assert payload["report_kind"] == kind
        last = er.last_trial_day(self.exp)
        if kind == "progress":
            assert not (EFFECT_KEYS & set(payload)), "guard 2b: a progress report cannot carry an effect"
        else:
            assert as_of > last, "guard 2a: a final report only after the last trial day"
            assert not any(e == experiment_id and k == "final" and d != as_of.isoformat() for e, k, d in self.reports), "one final report"
        key = (experiment_id, kind, as_of.isoformat())
        old = self.reports.get(key)
        assert not (old and kind == "final" and old["payload"] != payload), "a final report never changes"
        self.reports[key] = {"as_of_date": as_of.isoformat(), "payload": payload}

    def set_status(self, _id, status):
        self.calls.append(f"set_status:{status}")
        assert (self.exp["status"], status) == ("running", "complete"), "the only status this job moves"
        self.exp["status"] = status

    # -- helpers for the tests ----------------------------------------------------------
    def final(self):
        rows = [r for (e, k, _), r in self.reports.items() if k == "final"]
        return rows[0]["payload"] if rows else None

    def progress(self, as_of):
        return self.reports[("EXP-901", "progress", as_of.isoformat())]["payload"]

    def add_screen(self, i, minutes, settled=True):
        day = _day(i)
        synced = datetime(day.year, day.month, day.day, 14, tzinfo=timezone.utc) + timedelta(days=1 if settled else 0)
        sleep = datetime(day.year, day.month, day.day, 4, tzinfo=timezone.utc) + timedelta(days=1)
        self.screens.append({"behavioral_date": day.isoformat(), "sleep_start": sleep.isoformat(),
                             "synced_at": synced.isoformat(), "minutes_last_hour_before_sleep_est": minutes})


def _run_main(store, argv=()):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = er.main(list(argv), store=store)
    return code, out.getvalue() + err.getvalue()


def _no_leak(text, store, report=None):
    assert store.seed not in text, "a seed was printed"
    assert not re.search(r"\b[AB]{4,}\b", text), "arms were printed"
    for row in store.rows.values():
        if row["whoop_hrv_rmssd"] is not None:
            assert str(row["whoop_hrv_rmssd"]) not in text, "an outcome value was printed"
    if report and report.get("estimate") is not None:
        assert f"{report['estimate']:.1f}" not in text and f"{report['p_value']:.3f}" not in text, "a result was printed"


# ---------------------------------------------------------------------------
# Adherence
# ---------------------------------------------------------------------------

def test_screen_minutes_count_only_once_settled():
    day = _day(3)
    store = FakeStore(END)
    store.add_screen(3, 2.5)
    row = store.screens[0]
    assert ad.settled_screen_minutes(row, day) == 2.5
    assert ad.settled_screen_minutes(row, _day(4)) is None, "a row for another day"
    assert ad.settled_screen_minutes(None, day) is None
    assert ad.settled_screen_minutes({**row, "sleep_start": None}, day) is None, "the sleep is not scored yet"
    assert ad.settled_screen_minutes({**row, "minutes_last_hour_before_sleep_est": None}, day) is None
    # Synced during the day itself: the estimate reads 0 from hours that were never sent.
    early = {**row, "synced_at": datetime(day.year, day.month, day.day, 20, tzinfo=timezone.utc).isoformat(),
             "minutes_last_hour_before_sleep_est": 0}
    assert ad.settled_screen_minutes(early, day) is None
    # Synced after 06:00 ET the next day but less than an hour after a very late sleep onset.
    late_sleep = {**row, "sleep_start": (ad._instant(row["synced_at"]) - timedelta(minutes=30)).isoformat()}
    assert ad.settled_screen_minutes(late_sleep, day) is None
    # 06:00 ET is 11:00 UTC in January: 10:59 is too early, 11:00 counts.
    for hour_minute, expected in (((10, 59), None), ((11, 0), 2.5)):
        stamp = datetime(day.year, day.month, day.day, *hour_minute, tzinfo=timezone.utc) + timedelta(days=1)
        assert ad.settled_screen_minutes({**row, "synced_at": stamp.isoformat()}, day) == expected


def test_objective_decides_and_the_answer_is_fallback_or_confirmation():
    rule = ad.objective_rule({"objective": RULE})
    assert rule == {"source": ad.SCREEN_SOURCE, "max": 5.0, "arm": "A"}
    assert ad.objective_rule({}) is None and ad.objective_rule(None) is None
    assert ad.objective_rule({"objective": {**RULE, "source": "pds.habit_journal.answer"}}) is None
    assert ad.objective_rule({"objective": {**RULE, "max": "5"}}) is None

    d = ad.resolve_day("A", rule, 3.0, None)
    assert (d.adherent, d.basis, d.objective, d.conflict) == (True, "objective", True, False)
    d = ad.resolve_day("A", rule, 5.0, "yes")
    assert d.adherent is True and not d.conflict, "the limit itself is within the rule"
    d = ad.resolve_day("A", rule, 22.0, "yes")
    assert (d.adherent, d.basis, d.conflict) == (False, "objective", True), "the device decides; the disagreement is counted"
    d = ad.resolve_day("A", rule, 1.0, "no")
    assert (d.adherent, d.conflict) == (True, True)
    # Not settled yet: the answer is the fallback. "partly" is not adherent.
    assert ad.resolve_day("A", rule, None, "yes") == ad.DayAdherence(True, "self_report", None, "yes", False)
    assert ad.resolve_day("A", rule, None, "partly").adherent is False
    assert ad.resolve_day("A", rule, None, None) == ad.DayAdherence(None, "none", None, None, False)
    # The control arm is "usual behaviour": nothing to check, whatever the phone did.
    assert ad.resolve_day("B", rule, 55.0, None).adherent is None
    assert ad.resolve_day("B", rule, 55.0, "yes") == ad.DayAdherence(True, "self_report", None, "yes", False)
    assert ad.resolve_day("A", None, 55.0, "no").basis == "self_report", "no registered rule, no objective check"
    assert ad.resolve_day("A", rule, 1.0, "maybe").self_report is None, "an unknown answer is ignored"

    summary = ad.summarize([ad.resolve_day("A", rule, 3.0, None), ad.resolve_day("A", rule, 22.0, "yes"),
                            ad.resolve_day("B", rule, None, "yes"), ad.resolve_day("B", rule, None, None)])
    assert summary == {"days": 4, "days_with_evidence": 3, "days_adherent": 2, "adherence_pct": 66.7, "days_objective": 2,
                       "days_self_report_only": 1, "days_unknown": 1, "conflicts": 1}
    assert ad.summarize([])["adherence_pct"] is None


def test_check_in_answers_are_the_values_the_database_accepts():
    # The check-in writes 'yes' / 'partly' / 'no' (frontend/src/lib/experiments.ts ADHERENCE_ANSWERS);
    # pds.experiment_days and the record function accept exactly these; the report reads them.
    assert ad.SELF_REPORTS == ("yes", "partly", "no")
    schema = (ROOT / "sql" / "experiment_framework_schema.sql").read_text(encoding="utf-8")
    assert "self_report           TEXT CHECK (self_report IN ('yes', 'partly', 'no'))" in schema
    assert "p_answer NOT IN ('yes', 'partly', 'no')" in SQL_FILE.read_text(encoding="utf-8")
    frontend = (ROOT / "frontend" / "src" / "lib" / "experiments.ts").read_text(encoding="utf-8")
    assert re.search(r'ADHERENCE_ANSWERS = \["yes", "partly", "no"\] as const', frontend)


# ---------------------------------------------------------------------------
# The report job
# ---------------------------------------------------------------------------

def test_no_trial_is_a_healthy_no_op():
    store = FakeStore(_day(10))
    store.exps = []
    code, text = _run_main(store)
    assert code == 0 and "No trial is registered" in text
    assert store.calls == ["locked_experiments"], "one read and nothing else"
    assert [(h["source"], h["data_type"], h["status"], h["records_synced"], h["error_message"]) for h in store.supa.heartbeats] == \
        [("experiments", "report", "success", 0, None)]
    assert store.reports == {}

    # A draft (seeded, not registered) is not a trial either.
    store = FakeStore(_day(10), status="draft")
    code, _ = _run_main(store)
    assert code == 0 and store.calls == ["locked_experiments"]


def test_before_the_first_day_nothing_is_counted():
    store = FakeStore(START - timedelta(days=2), status="registered")
    out = er.run(store, alignment_version=ALIGNMENT)
    assert out.status == "success" and out.records == 1 and store.reports == {}
    assert "outcome_days" not in store.calls and "matrix" not in store.calls
    assert "No nights to count yet" in out.lines[0]


def test_while_running_only_progress_is_written_and_nothing_leaks():
    today = _day(30)                                              # 30 finished days: indices 0..29
    store = FakeStore(today, missing={5, 27, 28, 29})
    a_days = [i for i in range(30) if store.arms[i] == "A"]
    b_days = [i for i in range(30) if store.arms[i] == "B"]
    store.add_screen(a_days[0], 2.0)                              # within the limit
    store.add_screen(a_days[1], 31.0)                             # over it, and Riley answered yes
    store.add_screen(a_days[2], 0.0, settled=False)               # not settled: falls back to the answer
    store.add_screen(b_days[0], 44.0)                             # control arm: not checked
    store.days = [{"behavioral_date": _day(a_days[1]).isoformat(), "self_report": "yes", "excluded": False},
                  {"behavioral_date": _day(a_days[2]).isoformat(), "self_report": "partly", "excluded": False},
                  {"behavioral_date": _day(b_days[1]).isoformat(), "self_report": "yes", "excluded": False}]

    code, text = _run_main(store)
    assert code == 0
    assert "matrix" not in store.calls, "before the end the job must not load a single HRV value"
    _no_leak(text, store)
    assert "day 31 of 80" in text and f"no effect is computed before {END}" in text

    progress = store.progress(today)
    assert set(store.reports) == {("EXP-901", "progress", today.isoformat())}
    assert not EFFECT_KEYS & set(progress)
    assert (progress["days_elapsed"], progress["nights_with_outcome"], progress["tail_missing_nights"]) == (30, 26, 3)
    assert progress["missing_pct"] == 13.3 and progress["awaiting_final"] is False
    assert progress["adherence"] == {"days": 30, "days_with_evidence": 4, "days_adherent": 2, "adherence_pct": 50.0,
                                     "days_objective": 2, "days_self_report_only": 2, "days_unknown": 26, "conflicts": 1}
    for value in json.dumps(progress).replace('"', " ").split():
        assert value not in ("A", "B"), "no arm in a progress report"

    # Heartbeat: partial because of the three missing nights; the text names no number about adherence.
    beat = store.supa.heartbeats[-1]
    assert (beat["status"], beat["records_synced"]) == ("partial", 1)
    assert "3 nights in a row without an HRV outcome" in beat["error_message"]

    # A second run on the same day rewrites the same row.
    code, _ = _run_main(store)
    assert code == 0 and len(store.reports) == 1 and store.progress(today) == progress


def test_adherence_floor_from_the_protocol_turns_the_heartbeat_partial():
    store = FakeStore(_day(20))
    store.exp["adherence"] = {"objective": dict(RULE), "min_pct": 80}
    for n, i in enumerate(i for i in range(20) if store.arms[i] == "A"):
        store.add_screen(i, 2.0 if n < 4 else 40.0)
    out = er.run(store, alignment_version=ALIGNMENT)
    assert out.status == "partial" and "adherence is below the threshold the protocol registered" in out.error
    assert "%" not in out.error and not re.search(r"\d\d\.\d", out.error), "the heartbeat carries no adherence figure"
    store.exp["adherence"]["min_pct"] = 30
    assert er.run(store, alignment_version=ALIGNMENT).status == "success"


def test_final_report_waits_for_the_end_to_settle():
    assert not er.final_is_due(END, END, True) and not er.final_is_due(END + timedelta(days=1), END, True)
    assert er.final_is_due(END + timedelta(days=2), END, True)
    assert not er.final_is_due(END + timedelta(days=3), END, False), "still waiting for the last night's HRV"
    assert er.final_is_due(END + timedelta(days=4), END, False)

    store = FakeStore(END + timedelta(days=1))
    out = er.run(store, alignment_version=ALIGNMENT)
    assert out.status == "success" and store.final() is None and "matrix" not in store.calls
    progress = store.progress(END + timedelta(days=1))
    assert progress["days_elapsed"] == N_DAYS and progress["awaiting_final"] is True
    assert "the final report follows" in out.lines[0]

    late = FakeStore(END + timedelta(days=3), missing={N_DAYS - 1})
    er.run(late, alignment_version=ALIGNMENT)
    assert late.final() is None, "the last night's HRV may still arrive"
    late.today = END + timedelta(days=4)
    er.run(late, alignment_version=ALIGNMENT)
    assert late.final() is not None and late.final()["nights_with_outcome"] == N_DAYS - 1


def test_final_report_at_the_end_is_written_once():
    today = END + timedelta(days=2)
    store = FakeStore(today, missing={11})
    for i in range(N_DAYS):
        if store.arms[i] == "A":
            store.add_screen(i, 40.0 if i % 16 == 0 or i % 16 == 1 else 1.0)
    store.flights = {_day(13).isoformat()}                                   # block 3
    store.rows[_day(22).isoformat()]["onyx_is_transition_day"] = True        # block 5
    block_32_start = datetime(2030, 2, 8, 11, tzinfo=timezone.utc)           # day 32 at 06:00 ET
    store.days = [
        {"behavioral_date": _day(33).isoformat(), "self_report": None, "excluded": True,   # block 8, declared ahead
         "exclusion_declared_at": (block_32_start - timedelta(hours=5)).isoformat()},
        {"behavioral_date": _day(41).isoformat(), "self_report": None, "excluded": True,   # block 10, declared too late
         "exclusion_declared_at": (block_32_start + timedelta(days=9)).isoformat()},
    ]

    code, text = _run_main(store)
    report = store.final()
    assert code == 0 and report is not None
    _no_leak(text, store, report)
    assert "FINAL report written" in text and "not in this log" in text
    assert store.exp["status"] == "complete" and store.calls.count("matrix") == 1

    # The registered analysis found the planted effect.
    assert abs(report["estimate"] - EFFECT) < 4 and report["p_value"] < 0.01 and report["decision"] == "adopt_A"
    assert report["ci_low"] < EFFECT < report["ci_high"] and report["n_redraws"] == 999
    assert report["report_kind"] == "final" and report["as_of"] == today.isoformat() and report["stopped_early"] is False
    assert report["excluded_blocks"] == [3, 5, 8]
    assert report["exclusions"]["by_reason"] == [{"reason": "declared pause", "count": 1}, {"reason": "flight day", "count": 1},
                                                 {"reason": "time-zone transition day", "count": 1}]
    assert report["exclusions"]["late_declarations"] == 1, "a pause declared after its block started is not honoured"
    assert report["days_in_scope"] == N_DAYS - 12 and report["n_nights"] == N_DAYS - 12 - 1
    assert report["nights_with_outcome"] == N_DAYS - 1 and report["missing_pct"] == 1.2

    # Sensitivity and secondary fits (doc 8).
    sens = report["sensitivity"]
    assert sens["ln_outcome"]["estimate_pct"] > 0
    assert sens["per_protocol"]["n_nights"] < report["n_nights"], "days the device showed as non-adherent are left out"
    for name in ("covariate_hrv_lag1", "covariate_hrv_7d_mean"):
        assert abs(sens[name]["estimate"] - EFFECT) < 5 and sens[name]["p_value"] < 0.01
    assert sens["covariate_hrv_lag1"]["n_nights"] <= report["n_nights"]
    assert set(report["secondary_outcomes"]) == {"eight_sleep_hrv", "whoop_rhr"}
    assert abs(report["secondary_outcomes"]["whoop_rhr"]["estimate"]) < 3, "no effect was planted on the other series"
    assert report["not_run"][0].startswith("excluding travel blocks: flight and transition blocks are already left out")
    assert report["not_run"][1:] == ["a synthetic unbuilt analysis"], "a registered analysis this job cannot run is reported"
    over = sum(1 for i in range(N_DAYS) if store.arms[i] == "A" and i % 16 in (0, 1))
    assert over > 0 and report["adherence"]["days_objective"] == N_DAYS // 2 and report["adherence"]["days_unknown"] == N_DAYS // 2
    assert report["adherence"]["adherence_pct"] == round(100.0 * (N_DAYS // 2 - over) / (N_DAYS // 2), 1)

    # The allocation audit: the seed is published now, in the store, never in the log.
    assert report["allocation"] == {"seed_hex": SEED.hex(), "seed_sha256": ed.seed_commitment(SEED),
                                    "generator": ed.GENERATOR, "days_verified": N_DAYS}
    beat = store.supa.heartbeats[-1]
    assert (beat["status"], beat["error_message"]) == ("success", None)

    # Later runs recompute nothing: same payload, no second matrix read, no second analysis.
    store.today = today + timedelta(days=5)
    code, text = _run_main(store)
    assert code == 0 and "nothing to recompute" in text
    assert store.calls.count("matrix") == 1 and store.final() == report
    assert [k for k in store.reports if k[1] == "final"] == [("EXP-901", "final", today.isoformat())]

    # Same inputs, same day: byte-identical numbers.
    again = FakeStore(today, missing={11})
    again.screens, again.flights, again.days = store.screens, store.flights, store.days
    again.rows[_day(22).isoformat()]["onyx_is_transition_day"] = True
    er.run(again, alignment_version=ALIGNMENT)
    assert json.dumps(again.final(), sort_keys=True) == json.dumps(report, sort_keys=True)


def test_stopped_early_and_too_few_nights_still_get_a_final_report():
    stop = _day(47)
    store = FakeStore(stop + timedelta(days=1), status="stopped_early")
    store.exp.update(stopped_on=stop.isoformat(), stop_reason="synthetic reason")
    er.run(store, alignment_version=ALIGNMENT)
    assert store.final() is None, "the stop day's night has not settled"
    store.today = stop + timedelta(days=2)
    er.run(store, alignment_version=ALIGNMENT)
    report = store.final()
    assert report["stopped_early"] is True and report["last_day_analysed"] == stop.isoformat()
    assert report["days_elapsed"] == 48 and report["n_nights"] == 48 and report["stop_reason"] == "synthetic reason"
    assert store.exp["status"] == "stopped_early", "a stopped trial keeps its status"

    # Stopped on day 6: the model cannot be fitted. The final report says so and carries no estimate.
    tiny = FakeStore(_day(8), status="stopped_early")
    tiny.exp.update(stopped_on=_day(5).isoformat(), stop_reason="synthetic")
    out = er.run(tiny, alignment_version=ALIGNMENT)
    report = tiny.final()
    assert out.status == "success" and report["decision"] is None and "too few" in report["not_analysable"]
    assert "estimate" not in report and report["allocation"]["seed_hex"] == SEED.hex()

    # Stopped before the first day: nothing to count, still closed with a report.
    never = FakeStore(START + timedelta(days=1), status="stopped_early")
    never.exp.update(stopped_on=(START - timedelta(days=1)).isoformat(), stop_reason="synthetic")
    er.run(never, alignment_version=ALIGNMENT)
    assert never.final()["days_elapsed"] == 0 and never.final()["decision"] is None


def test_guards_leave_a_failed_heartbeat_with_the_guard_prefix():
    store = FakeStore(_day(12))
    store.exp["alignment_version"] = "wake_day_v0"
    code, text = _run_main(store)
    beat = store.supa.heartbeats[-1]
    assert code == 1 and beat["status"] == "failed" and beat["error_message"].startswith("GUARD experiment_alignment:")
    assert store.reports == {} and text.startswith("GUARD experiment_alignment:")

    store = FakeStore(_day(12))
    store.sched[50]["arm"] = "A" if store.sched[50]["arm"] == "B" else "B"      # a FUTURE day was edited
    code, text = _run_main(store)
    beat = store.supa.heartbeats[-1]
    assert code == 1 and beat["error_message"].startswith("GUARD experiment_schedule: EXP-901 has 1 day(s) that differ")
    assert store.reports == {}
    _no_leak(text, store)

    store = FakeStore(_day(12))
    store.seed = hashlib.sha256(b"another synthetic seed").hexdigest()
    code, _ = _run_main(store)
    assert code == 1 and "does not match its commitment" in store.supa.heartbeats[-1]["error_message"]

    store = FakeStore(_day(12))
    store.sched[3]["behavioral_date"] = _day(4).isoformat()
    assert _run_main(store)[0] == 1 and store.supa.heartbeats[-1]["error_message"].startswith("GUARD experiment_schedule:")


def test_every_failure_leaves_a_heartbeat():
    store = FakeStore(_day(12))
    store.reports_missing = True
    code, text = _run_main(store)
    beat = store.supa.heartbeats[-1]
    assert code == 1 and beat["status"] == "failed"
    assert admin.REPORTS_SQL in beat["error_message"] and admin.REPORTS_SQL in text

    class Boom(Exception):
        message = "permission denied for table experiments"
        details = "a row that must not be printed"

    store = FakeStore(_day(12))
    store.outcome_days = lambda *_: (_ for _ in ()).throw(Boom())
    code, text = _run_main(store)
    beat = store.supa.heartbeats[-1]
    assert code == 1 and beat["status"] == "failed" and beat["error_message"] == "Boom: permission denied for table experiments"
    assert "must not be printed" not in text + beat["error_message"]

    store = FakeStore(_day(12))
    store.locked_experiments = lambda: (_ for _ in ()).throw(KeyError("x"))
    assert _run_main(store)[0] == 1 and store.supa.heartbeats[-1]["error_message"] == "KeyError"


def test_dry_run_writes_nothing():
    for today in (_day(12), END + timedelta(days=2)):
        store = FakeStore(today)
        code, text = _run_main(store, argv=["--dry-run"])
        assert code == 0 and store.reports == {} and store.supa.heartbeats == []
        assert store.exp["status"] == "running" and not any(c.startswith(("upsert", "set_")) for c in store.calls)
        _no_leak(text, store)
        assert "dry run: nothing written" in text


def test_there_is_no_way_to_ask_for_an_early_analysis():
    source = (ROOT / "experiment_report.py").read_text(encoding="utf-8")
    assert re.findall(r"add_argument\(\"(--[a-z-]+)\"", source) == ["--dry-run"], "the only option is --dry-run"
    for flag in ("--as-of", "--force", "--today"):
        try:
            with redirect_stderr(io.StringIO()):
                er.main([flag, "2030-01-01"], store=FakeStore(_day(12)))
        except SystemExit:
            continue
        raise AssertionError(f"{flag} must not exist")
    # Even with the store's clock inside the trial, the analysis library itself refuses.
    store = FakeStore(_day(40))
    arms, seed_hex = er.check_schedule(store, store.exp)
    try:
        er._final(store, store.exp, _day(40), arms, seed_hex, 40, [], [], ALIGNMENT)
    except er.analysis.AnalysisNotAllowed:
        pass
    else:
        raise AssertionError("the final analysis ran before the pre-registered end")
    assert "matrix" not in store.calls, "it refuses before reading any outcome"


def test_the_report_job_does_not_talk_to_notion_yet():
    # The Notion mirror is the next build step (docs/experiment-framework.md 12.1); until it exists the
    # job must not half-write a page or need NOTION_API_KEY.
    source = (ROOT / "experiment_report.py").read_text(encoding="utf-8")
    assert not re.search(r"(?m)^\s*import experiment_notion|NOTION_API_KEY|api\.notion\.com", source)


# ---------------------------------------------------------------------------
# The SQL file and the workflow
# ---------------------------------------------------------------------------

def test_sql_is_additive_and_service_role_only():
    sql = SQL_FILE.read_text(encoding="utf-8")
    banned = re.findall(r"(?i)\b(?:drop|truncate|delete)\w*", sql)
    assert banned == [], f"the migration must be additive (found {banned})"
    assert "ALTER TABLE pds.experiment_reports ENABLE ROW LEVEL SECURITY" in sql
    assert "REVOKE ALL ON pds.experiment_reports FROM PUBLIC, anon, authenticated, service_role" in sql
    grants = re.findall(r"(?im)^GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\s+(\S+?);", sql)
    assert grants == [("SELECT, INSERT, UPDATE", "pds.experiment_reports", "service_role")], grants
    assert "CREATE POLICY" not in sql.upper()
    assert "PRIMARY KEY (experiment_id, report_kind, as_of_date)" in sql
    # The guard's list of effect keys is the one the job's progress payload must avoid.
    listed = set(re.findall(r"'([a-z_]+)'", re.search(r"effect_keys text\[\] := ARRAY\[(.*?)\];", sql, re.S).group(1)))
    assert listed == EFFECT_KEYS

    # Every function the file creates is executable by the service role only.
    created = re.findall(r"CREATE OR REPLACE FUNCTION (pds\.\w+)\(", sql)
    assert created == ["pds.experiment_reports_guard", "pds.experiment_adherence_day", "pds.experiment_record_adherence"]
    for name, signature in (("pds.experiment_adherence_day", "(date)"), ("pds.experiment_record_adherence", "(date, text, text)")):
        assert re.search(rf"REVOKE ALL ON FUNCTION {re.escape(name + signature)}\s+FROM PUBLIC, anon, authenticated;", sql), name
        executes = re.findall(rf"GRANT EXECUTE ON FUNCTION {re.escape(name + signature)}\s+TO (\w+);", sql)
        assert executes == ["service_role"], (name, executes)
    assert "SECURITY DEFINER" not in sql.upper(), "the functions run with the caller's (service role) rights"


def test_check_in_functions_answer_only_for_a_shown_arm_today_or_yesterday():
    sql = SQL_FILE.read_text(encoding="utf-8")
    body = re.search(r"FUNCTION pds\.experiment_adherence_day\(.*?END \$\$;", sql, re.S).group(0)
    assert "IF v_day > v_today OR v_day < v_today - 1 THEN" in body, "today or the day before only"
    assert "status IN ('registered', 'running')" in body, "a paused, stopped or complete trial takes no answers"
    assert "s.first_revealed_at IS NULL" in body and "'not_revealed'" in body, "only an arm Today has shown"
    assert "UPDATE" not in body and "INSERT" not in body, "reading the question state writes and stamps nothing"
    record = re.search(r"FUNCTION pds\.experiment_record_adherence\(.*?END \$\$;", sql, re.S).group(0)
    assert record.index("pds.experiment_adherence_day(p_date)") < record.index("INSERT INTO pds.experiment_days"), \
        "the day's state is checked before anything is written"
    assert "IS DISTINCT FROM 'open' THEN\n        RETURN state;" in record, "a day that is not open is left untouched"
    assert "first_revealed_at" not in record, "recording an answer never stamps a reveal"
    assert "length(v_note) > 500" in record


def test_workflow_runs_the_job_daily_from_master_only():
    path = ROOT / ".github" / "workflows" / "experiment-report.yml"
    if not path.exists():
        # .github/ is a protected path for agents: Riley adds this file (YAML in the roadmap row's Notes).
        print("skip: .github/workflows/experiment-report.yml is not added yet")
        return
    text = path.read_text(encoding="utf-8")
    assert re.search(r"(?m)^\s*- cron: '0 15 \* \* \*'", text) and "workflow_dispatch:" in text
    assert "if: github.ref == 'refs/heads/master'" in text
    assert "python experiment_report.py" in text and "persist-credentials: false" in text
    assert "--as-of" not in text and "--force" not in text


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
