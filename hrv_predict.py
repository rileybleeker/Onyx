#!/usr/bin/env python3
"""
Onyx HRV Daily Prediction Script
==================================
Loads the trained XGBoost model, predicts the HRV of tonight's sleep (the one
Riley wakes up from tomorrow), backfills actuals for past predictions,
recomputes rolling metrics, and checks for model drift.

Alignment (hrv_alignment.py): the forecast predicts from behavioral today's
matrix row, and prediction_date = that row's date = the behavioral date of the
sleep. actual_hrv for prediction_date P is matrix row P's HRV.

Run after ETL:
    python hrv_predict.py --predict

Phase 5 of the HRV analysis pipeline.
"""

import argparse
import json
import logging
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

import hrv_model_artifact as model_artifact
from sync_log_helper import log_sync as _shared_log_sync

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("hrv_predict")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
supa = create_client(SUPABASE_URL, SUPABASE_KEY)

# ET is the canonical timezone for Onyx (see AGENTS.md). Using UTC date.today()
# on the GitHub runner would mis-tag any prediction fired between 00:00 UTC and
# ET midnight (~04:00-05:00 UTC) — the run would predict the day-after-next
# instead of tomorrow, silently skipping the ET day the user actually cares about.
ET_TZ = ZoneInfo("America/New_York")


def et_today() -> date:
    return datetime.now(ET_TZ).date()


MODEL_PATH = Path("analysis_output") / "xgboost_hrv_model.pkl"
MODEL_VERSION = f"{et_today().isoformat()}_v1"

# Drift threshold: alert if rolling 30-day MAE exceeds 1.5x backtest MAE
DRIFT_THRESHOLD = 1.5

# Canonical PI nominal level (kept in sync with hrv_analysis.CI_NOMINAL).
# Standardized to 80% to match Prophet's default — see hrv_analysis.py for the
# audit re-2026-05-26 rationale (deepseek F-001/F-002, gpt-5 F-003).
CI_NOMINAL = 0.80
CI_Z = 1.282
# Window for "rolling" metrics. Previously the function aggregated *all* history,
# desensitizing the metric over time. 30 days matches the function name.
ROLLING_WINDOW_DAYS = 30

# Live rolling metrics are stored under their own model label (e.g. 'xgboost_live_rolling').
# pds.hrv_model_metrics' primary key is (eval_date, model, horizon_days), so writing them under
# the plain model name replaced the retrain's walk-forward backtest h=1 row for the same
# eval_date (and left a hybrid row: live MAE / n next to the backtest's R2 / MAPE / CI).
# A separate label keeps both rows without changing the key. Readers: the /analytics/hrv
# page (frontend/src/lib/queries-hrv.ts LIVE_METRICS_SUFFIX) and check_drift() below.
LIVE_METRICS_SUFFIX = "_live_rolling"
# The first live forecast made by the same-night code (hrv_alignment.py, PR #5) was
# created 2026-11-11 01:06 ET; the last one made by the old code at 00:05 ET that day
# (prediction_date 2026-11-12, model_version '2026-11-11_v1', so the version date alone
# does not separate them). Rows created before this instant predicted another night.
ALIGNMENT_CUTOVER_AT = pd.Timestamp("2026-11-11T01:00:00", tz=ET_TZ)


# Heartbeat for a model pickle served with, or refused for, another sparse-feature fill than
# the current one (hrv_analysis.SPARSE_FILL_VERSION). That state repeats on every hourly run
# until the next retrain, so the same status + message is written at most once per
# PREPROCESSING_REPORT_EVERY_HOURS (the /status sync history reads the newest 100 sync_log
# rows; an hourly row would push other sources out of it). A model on the current fill writes
# one "success" row only when the newest row of this heartbeat is not already "success".
PREPROCESSING_HEARTBEAT = ("hrv_predict", "preprocessing")
PREPROCESSING_REPORT_EVERY_HOURS = 12
# Heartbeat for the model artifact a forecast is made with (audit PIPE-08, hrv_model_artifact.py):
# success = exactly the artifact the registry selected; partial = served without that check
# (registry table not applied yet, a pre-PIPE-08 pickle, the selected one missing from the cache,
# or the forecast stored without its artifact column); failed = refused before unpickling, or no
# forecast at all (registry unreadable, pinned artifact unservable by this code or gone from the
# cache). Same repeat rule as the preprocessing heartbeat.
MODEL_ARTIFACT_HEARTBEAT = ("hrv_predict", "model_artifact")


def report_preprocessing(status: str, message: str | None) -> bool:
    """Write the preprocessing heartbeat unless it would repeat (see above). Never raises.
    Returns True when a row was written."""
    return _report_deduped(PREPROCESSING_HEARTBEAT, status, message)


def report_model_artifact(status: str, message: str | None) -> bool:
    """Write the model-artifact heartbeat unless it would repeat. Never raises."""
    return _report_deduped(MODEL_ARTIFACT_HEARTBEAT, status, message)


def _report_deduped(heartbeat: tuple[str, str], status: str, message: str | None) -> bool:
    source, data_type = heartbeat
    last = None
    try:
        resp = (
            supa.schema("pds").from_("sync_log")
            .select("status,error_message,sync_start")
            .eq("source", source).eq("data_type", data_type)
            .order("sync_start", desc=True).limit(1).execute()
        )
        last = (resp.data or [None])[0]
    except Exception as e:  # noqa: BLE001 - the heartbeat must never stop a forecast
        log.warning(f"  {data_type} heartbeat lookup failed ({type(e).__name__}); writing it anyway")
    if status == "success":
        if last is None or last.get("status") == "success":
            return False
    elif last and last.get("status") == status and last.get("error_message") == message:
        try:
            age = pd.Timestamp.now(tz="UTC") - pd.to_datetime(last.get("sync_start"), utc=True)
            if age < timedelta(hours=PREPROCESSING_REPORT_EVERY_HOURS):
                return False
        except Exception:  # noqa: BLE001 - an unreadable time just means: write it
            pass
    try:
        _shared_log_sync(supa, source=source, data_type=data_type, status=status,
                         records=0, error=message)
    except Exception as e:  # noqa: BLE001
        log.warning(f"  {data_type} heartbeat write failed ({type(e).__name__})")
        return False
    return True


def live_metrics_model(model: str) -> str:
    return f"{model}{LIVE_METRICS_SUFFIX}"


def select_live_forecasts(preds: pd.DataFrame) -> pd.DataFrame:
    """One scored live h=1 forecast per (model, prediction_date), on the current alignment.

    Leaves out backtest rows (the retrain scores those itself), other horizons, forecasts
    created before the alignment cutover, and rows without an actual. Where a date has several live
    versions it keeps the row pds.hrv_predictions_latest serves: the hrv_predict path
    ('*_v1') before the retrain path ('*_behavioral_v1'), then the newest created_at.
    """
    if preds.empty:
        return preds
    p = preds.copy()
    ver = p["model_version"].fillna("").astype(str)
    created = pd.to_datetime(p["created_at"], utc=True, errors="coerce")
    p["actual_hrv"] = pd.to_numeric(p["actual_hrv"], errors="coerce")
    p["predicted_hrv"] = pd.to_numeric(p["predicted_hrv"], errors="coerce")
    keep = (
        ~ver.str.startswith("backtest")
        & (pd.to_numeric(p["horizon_days"], errors="coerce") == 1)
        & (created >= ALIGNMENT_CUTOVER_AT)
        & p["actual_hrv"].notna()
        & p["predicted_hrv"].notna()
    )
    p = p[keep].copy()
    if p.empty:
        return p
    p["_rank"] = ver[keep].str.contains("behavioral").astype(int)
    p["_created"] = created[keep]
    p = p.sort_values(["model", "prediction_date", "_rank", "_created"],
                      ascending=[True, True, True, False])
    p = p.drop_duplicates(["model", "prediction_date"], keep="first")
    return p.drop(columns=["_rank", "_created"]).sort_values(["model", "prediction_date"])


def live_metrics_row(sub: pd.DataFrame, model: str, eval_date: str) -> dict:
    """Accuracy of one model's scored live forecasts (one row per date, date order)."""
    actuals = sub["actual_hrv"].to_numpy(dtype=float)
    preds_arr = sub["predicted_hrv"].to_numpy(dtype=float)
    err = actuals - preds_arr
    row = {
        "eval_date": eval_date,
        "model": live_metrics_model(model),
        "horizon_days": 1,
        "mae": float(np.mean(np.abs(err))),
        "rmse": float(np.sqrt(np.mean(err ** 2))),
        "mape": float(np.mean(np.abs(err / np.where(actuals != 0, actuals, 1))) * 100),
        "r_squared": None,
        "n_predictions": int(len(sub)),
        "directional_accuracy": None,
        "directional_accuracy_legacy": None,
        "ci_coverage": None,
        "ci_avg_width": None,
        "model_version": MODEL_VERSION,
    }
    ss_tot = float(np.sum((actuals - actuals.mean()) ** 2))
    if ss_tot > 0:
        row["r_squared"] = 1 - float(np.sum(err ** 2)) / ss_tot
    # Standard directional accuracy: did the forecast for day t, relative to *yesterday's
    # actual*, point in the same direction as the actual change from yesterday to today?
    # The legacy variant compares diff(predictions) vs diff(actuals).
    if len(actuals) > 1:
        actual_change = np.diff(actuals)
        row["directional_accuracy"] = float(
            np.mean(np.sign(actual_change) == np.sign(preds_arr[1:] - actuals[:-1])) * 100)
        row["directional_accuracy_legacy"] = float(
            np.mean(np.sign(actual_change) == np.sign(np.diff(preds_arr))) * 100)
    if {"prediction_lower", "prediction_upper"} <= set(sub.columns):
        lo = pd.to_numeric(sub["prediction_lower"], errors="coerce")
        hi = pd.to_numeric(sub["prediction_upper"], errors="coerce")
        has_pi = (lo.notna() & hi.notna()).to_numpy()
        if has_pi.any():
            a, l_, h_ = actuals[has_pi], lo.to_numpy()[has_pi], hi.to_numpy()[has_pi]
            row["ci_coverage"] = float(np.mean((a >= l_) & (a <= h_)) * 100)
            row["ci_avg_width"] = float(np.mean(h_ - l_))
    return row


def _clean_for_json(obj):
    """Recursively replace NaN / NaT / numpy scalars with JSON-safe Python types.

    Applied at the Supabase boundary so no code downstream of this function can
    crash httpx.json_dumps with non-compliant floats.
    """
    if isinstance(obj, dict):
        return {k: _clean_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean_for_json(v) for v in obj]
    if obj is None:
        return None
    try:
        if pd.isna(obj):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        v = float(obj)
        return None if v != v else v
    if isinstance(obj, (pd.Timestamp, np.datetime64, date, datetime)):
        return str(obj)
    return obj


def fetch_all(table: str, select: str = "*", filters: list | None = None,
              chunk: int = 1000) -> pd.DataFrame:
    rows = []
    offset = 0
    while True:
        q = supa.schema("pds").from_(table).select(select)
        if filters:
            for col, op, val in filters:
                if op == "eq":
                    q = q.eq(col, val)
                elif op == "gte":
                    q = q.gte(col, val)
                elif op == "lte":
                    q = q.lte(col, val)
                elif op == "is_":
                    q = q.is_(col, val)
        resp = q.range(offset, offset + chunk - 1).execute()
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < chunk:
            break
        offset += chunk
    return pd.DataFrame(rows) if rows else pd.DataFrame()


def load_model() -> tuple[dict | None, dict]:
    """The model bundle to serve and the report for its artifact heartbeat (audit PIPE-08).

    The workflow restores the artifact the registry selected and passes its checksum
    (HRV_MODEL_SELECTED_SHA256, HRV_MODEL_RESTORED = exact-key hit): the file must be exactly that
    artifact, and its manifest must match the pickle and this code, before anything is unpickled.
    An unreadable registry, or a pinned artifact that this code cannot serve or that is gone from
    the cache, refuses outright.
    report = {"sha256", "status", "message"}; the bundle is None when it must not be served."""
    from hrv_analysis import SPARSE_FILL_VERSIONS
    import hrv_alignment as al

    refusal = model_artifact.serving_refusal(os.environ)     # registry unreadable / pin unservable or lost
    if refusal:
        log.error(refusal)
        return None, {"sha256": None, "status": "failed", "message": refusal}
    selected = os.environ.get("HRV_MODEL_SELECTED_SHA256", "")
    restored = os.environ.get("HRV_MODEL_RESTORED", "") == "true"
    try:
        loaded = model_artifact.load_artifact(
            MODEL_PATH, expected_sha=selected if (selected and restored) else None,
            alignment_version=al.ALIGNMENT_VERSION, preprocessing_versions=SPARSE_FILL_VERSIONS,
            runtime_deps=model_artifact.dependency_versions())
    except model_artifact.ArtifactError as e:
        log.error(str(e))
        return None, {"sha256": None, "status": "failed", "message": str(e)}
    status, message = model_artifact.serving_report(loaded)
    trained = (loaded.manifest or {}).get("provenance", {})
    log.info(f"Model artifact {loaded.sha256[:12]} (trained {trained.get('trained_at', 'unknown')}, "
             f"data through {trained.get('data_cutoff', 'unknown')}): {status}")
    return loaded.bundle, {"sha256": loaded.sha256, "status": status, "message": message}


def _store_forecast(rows: list[dict]) -> None:
    # Audit P1 (G1): on_conflict targets the 4-tuple so retrain versions accumulate as separate
    # rows; same-day reruns with the same version upsert in place.
    supa.schema("pds").from_("hrv_predictions").upsert(
        _clean_for_json(rows),
        on_conflict="prediction_date,model,horizon_days,model_version",
    ).execute()


def get_latest_features(feat_cols: list) -> pd.DataFrame | None:
    """Fetch and rebuild features for the most recent available day."""
    # Import the feature building functions from hrv_analysis
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from hrv_analysis import load_all_data, build_feature_matrix
    except ImportError as e:
        log.error(f"Cannot import hrv_analysis: {e}")
        return None

    try:
        log.info("Loading data for latest prediction…")
        data = load_all_data()
        df = build_feature_matrix(data)

        # Align to feat_cols (add missing as NaN, drop extras)
        for c in feat_cols:
            if c not in df.columns:
                df[c] = np.nan
        X = df[feat_cols].copy()
        for c in X.columns:
            X[c] = pd.to_numeric(X[c], errors="coerce")
        return df, X
    except Exception as e:
        log.error(f"Feature building failed: {e}")
        return None, None


def predict_tomorrow(model_bundle: dict, artifact_sha256: str | None = None) -> dict | None:
    """Predict tonight's sleep (wake-up tomorrow) using the loaded model. `artifact_sha256` is the
    checksum of the artifact the bundle came from; the forecast row records it."""
    from hrv_analysis import (FEATURE_LABELS, compute_input_data_hash, TARGET, serve_features,
                              model_preprocessing, SPARSE_FILL_VERSION, SPARSE_FILL_VERSIONS)
    import hrv_alignment as al

    # A model trained under another alignment rule predicts a different night; never
    # serve it (the next retrain writes a compatible pickle).
    if model_bundle.get("alignment") != al.ALIGNMENT_VERSION:
        log.error(f"Model pickle alignment={model_bundle.get('alignment')!r}, expected "
                  f"{al.ALIGNMENT_VERSION!r} — retrain (hrv-retrain-on-backfill.yml) before predicting.")
        return None

    # A model stamped with the current fill is served with that same fill, so training and
    # serving match. A pickle from before the field keeps the old serving behaviour (7-row fill
    # on the full frame, which never matched how it was trained) until the next retrain writes
    # one on the current fill; a fill this code does not know (a newer pickle after a code
    # rollback) is refused.
    fill_version = model_preprocessing(model_bundle)
    if fill_version not in SPARSE_FILL_VERSIONS:
        msg = (f"GUARD model_preprocessing: model pickle preprocessing={fill_version!r}, this code "
               f"knows {', '.join(SPARSE_FILL_VERSIONS)}. Forecast skipped; retrain "
               "(gh workflow run hrv-retrain-on-backfill.yml) so the model and its feature fill match.")
        log.error(msg)
        report_preprocessing("failed", msg)
        return None
    if fill_version != SPARSE_FILL_VERSION:
        msg = (f"Model pickle predates the calendar-day sparse-feature fill ({SPARSE_FILL_VERSION}); "
               f"forecasting with the old serving fill ({fill_version}), which does not match how this "
               "model was trained, until the next retrain (hrv-retrain-on-backfill.yml, daily at 12:00 UTC).")
        log.warning(msg)
        report_preprocessing("partial", msg)
    else:
        report_preprocessing("success", None)

    model = model_bundle["model"]
    feat_cols = model_bundle["feat_cols"]
    pred_std = model_bundle.get("pred_std", 15.0)

    result = get_latest_features(feat_cols)
    if result is None or result[0] is None:
        return None
    df, X = result

    # Stamp this prediction with a hash of the input data it was derived from so
    # backfill-driven retrains can detect when a stored row went stale.
    try:
        y_for_hash = pd.to_numeric(df.get(TARGET, pd.Series(dtype=float)), errors="coerce")
        input_data_hash = compute_input_data_hash(X.fillna(0), y_for_hash.fillna(0))
    except Exception as e:
        log.warning(f"  input_data_hash compute failed: {e}")
        input_data_hash = None

    # Predict from behavioral today's row: tonight's sleep.
    latest_X, serve_date = serve_features(df, feat_cols, fill_version)
    if latest_X is None:
        log.error("No matrix row for behavioral today — cannot predict tonight's sleep.")
        return None
    pred_val = float(model.predict(latest_X)[0])
    lower = pred_val - CI_Z * pred_std
    upper = pred_val + CI_Z * pred_std

    # SHAP top drivers if available
    top_drivers_payload: dict | list = []
    try:
        import shap
        explainer = shap.TreeExplainer(model)
        shap_vals = explainer(latest_X)
        drivers = [
            {"feature": f, "label": FEATURE_LABELS.get(f, f),
             "shap_value": float(shap_vals.values[0, i])}
            for i, f in enumerate(feat_cols)
            if not np.isnan(shap_vals.values[0, i])
        ]
        drivers_sorted = sorted(drivers, key=lambda x: abs(x["shap_value"]), reverse=True)
        journal_drivers = sorted(
            [d for d in drivers if d["feature"].startswith("journal_")],
            key=lambda x: abs(x["shap_value"]),
            reverse=True,
        )
        top_drivers_payload = {
            "top": drivers_sorted[:15],
            "journal": journal_drivers,
        }
    except Exception:
        pass

    today_hrv = float(df["whoop_hrv_rmssd"].dropna().iloc[-1]) if df["whoop_hrv_rmssd"].dropna().shape[0] > 0 else None
    train_end = str(df["calendar_date"].iloc[-1])

    return {
        # Behavioral date of the predicted sleep; the page shows the wake-up date (+1).
        "prediction_date": serve_date,
        "model": "xgboost",
        "predicted_hrv": round(pred_val, 2),
        "prediction_lower": round(lower, 2),
        "prediction_upper": round(upper, 2),
        "actual_hrv": None,
        "horizon_days": 1,
        "top_drivers": top_drivers_payload,
        "model_version": MODEL_VERSION,
        "training_window_start": model_bundle.get("model_version", "").split("_")[0],
        "training_window_end": train_end,
        "today_hrv": today_hrv,
        "input_data_hash": input_data_hash,
        # Which artifact produced this forecast (pds.hrv_model_artifacts, PIPE-08).
        model_artifact.LINK_COLUMN: artifact_sha256,
    }


# Stored actuals are checked against the matrix again for this many days (audit PIPE-09): a
# corrected or rescored WHOOP recovery then updates actual_hrv and residual of every forecast for
# that night. 35 days covers the 30-day live metric window plus the days its eval_date can lag.
# Older rows are left as they are (bounded work per hourly run).
RESCORE_WINDOW_DAYS = 35
# The matrix holds HRV to 4 decimals; a difference below this is the same value.
ACTUAL_TOLERANCE = 1e-3
# A stored actual is cleared only when the matrix has had no HRV for that night for this many
# days: a recent night can lose its HRV for a while (WHOOP re-scoring it, a sync gap), and clearing
# then would drop it from the live metric until the next run fills it again.
CLEAR_AFTER_DAYS = 3
_PRED_KEY = ("prediction_date", "model", "horizon_days", "model_version")


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def plan_actual_updates(preds: pd.DataFrame, matrix_hrv: dict, today: str,
                        rescore_from: str) -> tuple[list[dict], dict]:
    """The actual_hrv / residual writes that bring stored forecasts in line with the matrix.

    preds: forecast rows (prediction_date, model, horizon_days, model_version, predicted_hrv,
    actual_hrv, residual). matrix_hrv: {calendar_date: HRV or None} for every matrix row read; a
    date missing from it is not judged. Only dates before `today` are eligible.
      * actual missing, matrix has it                -> fill  (any date, as before)
      * actual stored, matrix differs (rescored)     -> rescore (date >= rescore_from)
      * actual stored, matrix row has no HRV now     -> clear (date >= rescore_from, and at least
                                                        CLEAR_AFTER_DAYS old; a newer night keeps it)
      * actual unchanged but residual inconsistent   -> rescore the residual only
    Each write carries exactly the key + actual_hrv + residual: the issued forecast (predicted value,
    interval, created_at, model version, artifact) is never sent, so it never changes. Running it
    twice writes nothing the second time. Returns (updates, counts)."""
    counts = {"filled": 0, "rescored": 0, "cleared": 0}
    updates: list[dict] = []
    if preds is None or preds.empty:
        return updates, counts
    seen: set = set()
    clear_before = (date.fromisoformat(str(today)[:10]) - timedelta(days=CLEAR_AFTER_DAYS - 1)).isoformat()
    for _, row in preds.iterrows():
        d = str(row["prediction_date"])
        key = (d, str(row["model"]), int(row["horizon_days"]), row.get("model_version"))
        if d >= today or key in seen or d not in matrix_hrv:
            continue
        seen.add(key)
        stored = _num(row.get("actual_hrv"))
        current = _num(matrix_hrv[d])
        pred = _num(row.get("predicted_hrv"))
        if stored is None:
            if current is None:
                continue
            kind, actual = "filled", current
        elif d < rescore_from:
            continue
        elif current is None:
            if d >= clear_before:
                continue        # possibly a passing gap: keep the stored actual for now
            kind, actual = "cleared", None
        elif abs(current - stored) > ACTUAL_TOLERANCE:
            kind, actual = "rescored", current
        else:
            want = None if pred is None else stored - pred
            have = _num(row.get("residual"))
            same = (want is None and have is None) or (
                want is not None and have is not None and abs(want - have) <= ACTUAL_TOLERANCE)
            if same:
                continue
            kind, actual = "rescored", stored
        counts[kind] += 1
        updates.append({
            "prediction_date": d,
            "model": key[1],
            "horizon_days": key[2],
            "model_version": key[3],
            "actual_hrv": actual,
            "residual": None if (actual is None or pred is None) else actual - pred,
        })
    return updates, counts


def backfill_actuals() -> int:
    """Fill, and keep correct, actual_hrv and residual of past forecasts.

    Fills every forecast whose actual is NULL (as before) and, for the last RESCORE_WINDOW_DAYS,
    rescores forecasts whose stored actual no longer matches the matrix (a corrected source: WHOOP
    rescored the recovery, or the cycle was removed). Only forecasts dated strictly before today are
    eligible: today's WHOOP cycle is still in progress or unscored. See plan_actual_updates.
    """
    log.info("Backfilling actuals…")
    today = str(et_today())
    rescore_from = (et_today() - timedelta(days=RESCORE_WINDOW_DAYS)).isoformat()
    cols = "prediction_date,model,horizon_days,model_version,predicted_hrv,actual_hrv,residual"

    missing = fetch_all("hrv_predictions", select=cols, filters=[("actual_hrv", "is_", "null")])
    recent = fetch_all("hrv_predictions", select=cols, filters=[("prediction_date", "gte", rescore_from)])
    frames = [f for f in (missing, recent) if not f.empty]
    if not frames:
        log.info("  No predictions to backfill.")
        return 0
    preds = pd.concat(frames, ignore_index=True)
    preds = preds[preds["prediction_date"].astype(str) < today]
    if preds.empty:
        log.info("  No observable predictions to backfill.")
        return 0

    min_date = str(preds["prediction_date"].astype(str).min())
    actuals_raw = fetch_all(
        "daily_health_matrix_behavioral",
        select="calendar_date,whoop_hrv_rmssd",
        filters=[("calendar_date", "gte", min_date)],
    )
    if actuals_raw.empty:
        return 0
    matrix_hrv = dict(zip(actuals_raw["calendar_date"].astype(str), actuals_raw["whoop_hrv_rmssd"]))

    updates, counts = plan_actual_updates(preds, matrix_hrv, today, rescore_from)
    if updates:
        # Audit P1 (G1): on_conflict targets the (date,model,horizon,version) unique index so each
        # retrain run preserves history. NULL versions are handled via NULLS NOT DISTINCT on the
        # underlying index. Every row carries the same keys (one key set per bulk upsert).
        supa.schema("pds").from_("hrv_predictions").upsert(
            _clean_for_json(updates),
            on_conflict=",".join(_PRED_KEY),
        ).execute()
        log.info(f"  Actuals: {counts['filled']} filled, {counts['rescored']} rescored after a source "
                 f"correction, {counts['cleared']} cleared (source no longer has that night).")
    return len(updates)


def recompute_rolling_metrics() -> list[dict]:
    """Recompute the live rolling N-day accuracy and upsert it into hrv_model_metrics.

    Scores real forecasts only: one live h=1 forecast per (model, prediction_date) made
    since the alignment cutover (select_live_forecasts), over the last ROLLING_WINDOW_DAYS
    days. Until 2026-11-11 this also counted backtest rows of every horizon (so the "live"
    MAE was mostly backtest) and several forecasts per date, and it wrote under the plain
    model name, which overwrote the retrain's backtest h=1 row. Rows are written as
    '<model>_live_rolling' (LIVE_METRICS_SUFFIX). Returns the rows written.
    """
    log.info(f"Recomputing rolling {ROLLING_WINDOW_DAYS}-day live metrics…")
    today_str = str(et_today())
    window_start = (et_today() - timedelta(days=ROLLING_WINDOW_DAYS)).isoformat()

    preds = fetch_all(
        "hrv_predictions",
        select="prediction_date,model,horizon_days,predicted_hrv,actual_hrv,"
               "prediction_lower,prediction_upper,model_version,created_at",
        filters=[("prediction_date", "gte", window_start), ("horizon_days", "eq", 1)],
    )
    live = select_live_forecasts(preds)
    if live.empty:
        log.info("  No scored live forecasts since the alignment cutover yet.")
        return []

    rows = []
    for model_name, sub in live.groupby("model", sort=True):
        if len(sub) >= 5:
            rows.append(live_metrics_row(sub, str(model_name), today_str))
        else:
            log.info(f"  {model_name}: {len(sub)} scored live forecast(s), need 5 — skipped")

    if rows:
        supa.schema("pds").from_("hrv_model_metrics").upsert(
            _clean_for_json(rows), on_conflict="eval_date,model,horizon_days"
        ).execute()
        log.info(f"  Updated live metrics for {len(rows)} models (last {ROLLING_WINDOW_DAYS} days).")
    return rows


def latest_live_mae(model: str = "xgboost") -> float | None:
    """MAE of the newest live rolling-metrics row for `model` (h=1), or None."""
    resp = (
        supa.schema("pds")
        .from_("hrv_model_metrics")
        .select("mae,eval_date")
        .eq("model", live_metrics_model(model))
        .eq("horizon_days", 1)
        .order("eval_date", desc=True)
        .limit(1)
        .execute()
    )
    return float(resp.data[0]["mae"]) if resp.data else None


def check_drift(current_mae: float | None) -> None:
    """Compare the live 30-day MAE against the backtest MAE; log warning if drifting."""
    if current_mae is None:
        return
    # Anchor on the NEWEST walk-forward backtest at h=1: the retrain that produced the
    # deployed model, on the current alignment rule. (The first-ever backtest row predates
    # the 2026-11-10 alignment fix and scored another night.)
    baseline_rows = (
        supa.schema("pds")
        .from_("hrv_model_metrics")
        .select("mae,eval_date,horizon_days")
        .eq("model", "xgboost")
        .eq("model_version", "backtest_initial")
        .eq("horizon_days", 1)
        .order("eval_date", desc=True)
        .limit(1)
        .execute()
    )
    if not baseline_rows.data:
        return
    baseline_mae = float(baseline_rows.data[0].get("mae", 999))
    if current_mae > DRIFT_THRESHOLD * baseline_mae:
        log.warning(
            f"MODEL DRIFT DETECTED: current 30d MAE={current_mae:.1f}ms, "
            f"backtest MAE={baseline_mae:.1f}ms (threshold ×{DRIFT_THRESHOLD}). "
            "Consider retraining."
        )
        _shared_log_sync(
            supa, source="hrv_predict", data_type="drift_alert",
            status="warning", records=0,
            error=f"HRV model drift: current MAE={current_mae:.1f}ms vs backtest {baseline_mae:.1f}ms",
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Onyx HRV Daily Prediction")
    parser.add_argument("--predict", action="store_true", help="Predict tonight's sleep (wake-up tomorrow)")
    parser.add_argument("--backfill-only", action="store_true", help="Only backfill actuals")
    args = parser.parse_args()

    if not (args.predict or args.backfill_only):
        parser.print_help()
        sys.exit(0)

    # Each stage runs independently — a failure in one must not block the others.
    # Historically, a NaN in backfill killed the whole script and stalled predictions
    # for 9 days before anyone noticed.
    stage_errors: list[str] = []

    try:
        backfill_actuals()
    except Exception as e:
        stage_errors.append("backfill_actuals")
        log.exception(f"backfill_actuals failed: {e}")

    try:
        recompute_rolling_metrics()
    except Exception as e:
        stage_errors.append("recompute_rolling_metrics")
        log.exception(f"recompute_rolling_metrics failed: {e}")

    if args.predict:
        artifact = None
        try:
            model_bundle, artifact = load_model()
            if model_bundle is None:
                stage_errors.append("load_model")
            else:
                prediction = predict_tomorrow(model_bundle, artifact_sha256=artifact["sha256"])
                if prediction is None:
                    stage_errors.append("predict_tomorrow")
                    log.error("Failed to generate prediction.")
                else:
                    today_hrv = prediction.pop("today_hrv", None)

                    payload = [{k: v for k, v in prediction.items() if v is not None}]
                    if not model_artifact.upsert_with_artifact_link(_store_forecast, payload):
                        artifact = model_artifact.with_unlinked_forecast(artifact)
                        log.warning(artifact["message"])

                    log.info(
                        f"Tonight's sleep (night of {prediction['prediction_date']}): "
                        f"predicted HRV = {prediction['predicted_hrv']} ms  "
                        f"({int(CI_NOMINAL * 100)}% CI: {prediction['prediction_lower']} - {prediction['prediction_upper']})"
                    )
                    if today_hrv:
                        log.info(f"Last night's HRV: {today_hrv:.1f} ms")

                    try:
                        check_drift(latest_live_mae("xgboost"))
                    except Exception as e:
                        stage_errors.append("check_drift")
                        log.exception(f"check_drift failed: {e}")
        except Exception as e:
            stage_errors.append("predict")
            log.exception(f"predict stage failed: {e}")
        if artifact is not None:
            report_model_artifact(artifact["status"], artifact["message"])

    if stage_errors:
        log.error(f"{len(stage_errors)} stage(s) failed: {', '.join(stage_errors)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
