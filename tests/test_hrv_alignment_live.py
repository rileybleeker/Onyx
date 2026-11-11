"""HRV alignment test against the REAL matrix (replaces the synthetic
tests/test_phase2_alignment.py, 2026-11-10).

The old test built a pre-aligned synthetic frame in the April-2026 layout and never
read pds.daily_health_matrix_behavioral, so it kept passing for 5 months while every
behaviour was scored one night late. This one reads live data and fails if:

  1. any matrix row's HRV stops matching the recovery of the WHOOP cycle dated to that
     row (the dating every layer relies on);
  2. day-D events stop falling before the sleep dated D (real timestamps: WHOOP workouts
     and timed Cronometer servings dated D start after the sleep dated D-1 and before the
     sleep dated D);
  3. a re-keyed column (WHOOP strain, Eight Sleep, Garmin HRV) stops lining up best with
     the same row after hrv_alignment.realign_matrix;
  4. the descriptive outcome, the forecast target (prepare_ml_data) or the causal outcome
     stops being row D's own HRV;
  5. anyone re-introduces a negative shift of the HRV target in the pipeline sources;
  6. the alcohol canary reverses (same night must be hit harder than the next night).

Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (GitHub Actions has them; this PC has no
.env). Without them it SKIPS, unless ONYX_REQUIRE_LIVE=1 (set in CI), which makes a
missing credential a failure. With ONYX_ALIGNMENT_HEARTBEAT=1 a failure also writes a
failed hrv_analysis|retrain heartbeat ("GUARD alignment_test: ...") so /status shows it.

Run: python tests/test_hrv_alignment_live.py
"""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except Exception:  # noqa: BLE001
    pass

if not (os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY")):
    if os.environ.get("ONYX_REQUIRE_LIVE") == "1":
        print("FAIL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing and ONYX_REQUIRE_LIVE=1")
        sys.exit(1)
    print("SKIP: no Supabase credentials (this test reads the live matrix; it runs in CI)")
    sys.exit(0)

from supabase import create_client  # noqa: E402

import hrv_alignment as al  # noqa: E402

SUPA = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def fetch(table: str, select: str, filters: list | None = None) -> pd.DataFrame:
    rows, off = [], 0
    while True:
        q = SUPA.schema("pds").from_(table).select(select)
        for col, op, val in filters or []:
            q = getattr(q, op)(col, val)
        batch = q.range(off, off + 999).execute().data or []
        rows += batch
        if len(batch) < 1000:
            break
        off += 1000
    return pd.DataFrame(rows)


MATRIX_COLS = ("calendar_date,whoop_hrv_rmssd,whoop_day_strain,whoop_kilojoule,"
               "whoop_cycle_avg_hr,whoop_cycle_max_hr,whoop_workout_strain,"
               "eight_sleep_hrv,garmin_hrv_last_night")


def load():
    m = fetch("daily_health_matrix_behavioral", MATRIX_COLS)
    m["calendar_date"] = m["calendar_date"].astype(str)
    for c in m.columns:
        if c != "calendar_date":
            m[c] = pd.to_numeric(m[c], errors="coerce")
    m = m.sort_values("calendar_date").reset_index(drop=True)
    cycles = fetch("whoop_cycles", "cycle_id,start_time,end_time,onyx_behavioral_date")
    rec = fetch("whoop_recovery", "cycle_id,hrv_rmssd_milli,score_state")
    sleep = fetch("whoop_sleep", "cycle_id,start_time,is_nap,score_state",
                  [("is_nap", "eq", False)])
    return m, cycles, rec, sleep


def test_row_hrv_is_the_cycle_dated_to_the_row(m, cycles, rec):
    problems = al.check_matrix_hrv(m, cycles, rec)
    assert not problems, problems
    print(f"PASS: all {int(m['whoop_hrv_rmssd'].notna().sum())} matrix rows with HRV == recovery "
          f"of the WHOOP cycle dated to that row")


def _sleep_onset_by_day(cycles, sleep) -> pd.Series:
    mc = al.main_cycle_per_day(cycles)[["cycle_id", "onyx_behavioral_date"]]
    s = sleep.merge(mc, on="cycle_id")
    s["onset"] = pd.to_datetime(s["start_time"], utc=True, format="ISO8601")
    return s.groupby("onyx_behavioral_date")["onset"].min()


def test_day_d_events_precede_the_sleep_dated_d(cycles, sleep):
    onset = _sleep_onset_by_day(cycles, sleep)
    onset.index = pd.to_datetime(onset.index)
    events = []
    wk = fetch("whoop_workouts", "start_time,onyx_behavioral_date", [("score_state", "eq", "SCORED")])
    events.append(("whoop_workouts", wk.rename(columns={"start_time": "t"})))
    cs = fetch("cronometer_servings", "event_time,onyx_behavioral_date")
    if not cs.empty:
        events.append(("cronometer_servings", cs.rename(columns={"event_time": "t"})))
    for name, ev in events:
        ev = ev.dropna(subset=["t", "onyx_behavioral_date"]).copy()
        ev["t"] = pd.to_datetime(ev["t"], utc=True, format="ISO8601")
        d = pd.to_datetime(ev["onyx_behavioral_date"])
        own = d.map(onset)
        prev = (d - pd.Timedelta(days=1)).map(onset)
        ok = own.notna() & prev.notna()
        frac = float(((ev["t"] < own) & (ev["t"] >= prev))[ok].mean())
        n = int(ok.sum())
        assert n >= 30, f"{name}: only {n} dated events with both sleeps — cannot check"
        assert frac >= 0.95, (f"{name}: only {frac:.1%} of day-D events fall between the sleep "
                              f"dated D-1 and the sleep dated D (n={n})")
        print(f"PASS: {frac:.1%} of {n} {name} dated D happen after sleep D-1 and before sleep D")


def test_rekeyed_columns_line_up_with_the_same_row(m):
    realigned = al.realign_matrix(m)
    problems = al.check_rekey_directions(realigned)
    assert not problems, problems
    print("PASS: after realign_matrix, strain / Eight Sleep / Garmin HRV match the same row best")


def test_every_layer_scores_against_row_d(m):
    import hrv_analysis as ha
    import causal_inference as ci

    df = al.realign_matrix(m)
    df["hrv_lag1"] = df["whoop_hrv_rmssd"].shift(1)
    df["dummy_feature"] = 1.0
    own = df.set_index("calendar_date")["whoop_hrv_rmssd"]

    # descriptive layer + Prophet use al.add_outcome / al.outcome_series
    stat = al.add_outcome(df, 1).set_index("calendar_date")[al.outcome_col(1)]
    # forecast target
    model_df, feat_cols, _, y = ha.prepare_ml_data(df, horizon=1)
    fc = pd.Series(y.to_numpy(), index=model_df["calendar_date"].to_numpy())
    # causal outcome
    co = ci._build_outcome_frame(df).set_index("calendar_date")[ci.OUTCOME_COL]

    for name, s in (("descriptive", stat), ("forecast", fc), ("causal", co)):
        s = s.dropna()
        assert len(s) > 300, f"{name}: only {len(s)} outcome rows"
        diff = (s - own.reindex(s.index)).abs()
        assert diff.max() < 1e-9, f"{name} outcome is not row D's own HRV (max diff {diff.max()})"
    assert "whoop_hrv_rmssd" not in feat_cols, "the forecast uses the target as a feature"
    # horizon 2 = the sleep one night later
    y2 = al.outcome_series(df, 2).to_numpy()
    nxt = df["whoop_hrv_rmssd"].shift(-1).to_numpy()  # contiguous HRV era: next row = next day
    both = ~np.isnan(y2) & ~np.isnan(nxt)
    assert np.allclose(y2[both], nxt[both])
    print("PASS: descriptive, forecast and causal outcomes are all row D's own HRV")


def test_no_negative_shift_of_the_target_in_the_pipeline():
    pat = re.compile(r"(TARGET|whoop_hrv_rmssd|target_col)\"?\]?\s*\]?\.shift\(\s*-")
    hits = []
    for f in ("hrv_analysis.py", "causal_inference.py", "hrv_predict.py"):
        for i, line in enumerate((ROOT / f).read_text(encoding="utf-8").splitlines(), 1):
            if pat.search(line) and not line.lstrip().startswith("#"):
                hits.append(f"{f}:{i}: {line.strip()}")
    assert not hits, "outcome built outside hrv_alignment:\n" + "\n".join(hits)
    print("PASS: no pipeline file shifts the HRV target itself (outcomes come from hrv_alignment)")


def test_alcohol_canary():
    import hrv_analysis as ha
    j = fetch("journal", "cycle_date,behaviors_date,question,answer,source")
    pj = ha.pivot_journal(j)
    m = fetch("daily_health_matrix_behavioral", "calendar_date,whoop_hrv_rmssd")
    m["calendar_date"] = m["calendar_date"].astype(str)
    m["whoop_hrv_rmssd"] = pd.to_numeric(m["whoop_hrv_rmssd"], errors="coerce")
    df = m.merge(pj, on="calendar_date", how="left").sort_values("calendar_date")
    res = al.alcohol_canary(df)
    print(f"  alcohol canary: {res}")
    assert res.get("ok") is not False, f"alcohol canary reversed: {res}"
    print("PASS: alcohol hits the same night's HRV harder than the next night's")


def _heartbeat(msg: str) -> None:
    if os.environ.get("ONYX_ALIGNMENT_HEARTBEAT") != "1":
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        SUPA.schema("pds").table("sync_log").insert({
            "source": "hrv_analysis", "data_type": "retrain", "status": "failed",
            "records_synced": 0, "error_message": f"GUARD alignment_test: {msg}"[:1000],
            "sync_start": now, "sync_end": now,
        }).execute()
    except Exception as e:  # noqa: BLE001
        print(f"  (could not write heartbeat: {e})")


def main() -> int:
    m, cycles, rec, sleep = load()
    tests = [
        lambda: test_row_hrv_is_the_cycle_dated_to_the_row(m, cycles, rec),
        lambda: test_day_d_events_precede_the_sleep_dated_d(cycles, sleep),
        lambda: test_rekeyed_columns_line_up_with_the_same_row(m),
        lambda: test_every_layer_scores_against_row_d(m),
        test_no_negative_shift_of_the_target_in_the_pipeline,
        test_alcohol_canary,
    ]
    failures = []
    for t in tests:
        try:
            t()
        except AssertionError as e:
            failures.append(str(e))
            print(f"FAIL: {e}")
    if failures:
        _heartbeat(" | ".join(failures))
        return 1
    print("OK - HRV alignment holds on the live matrix")
    return 0


if __name__ == "__main__":
    sys.exit(main())
