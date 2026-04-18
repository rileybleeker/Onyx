#!/usr/bin/env python3
"""
Onyx HRV Daily Prediction Script
==================================
Loads the trained XGBoost model, generates tomorrow's HRV prediction,
backfills actuals for past predictions, recomputes rolling metrics,
and checks for model drift.

Run after ETL:
    python hrv_predict.py --predict

Phase 5 of the HRV analysis pipeline.
"""

import argparse
import json
import logging
import os
import pickle
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

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

# ET is the canonical timezone for Onyx (see CLAUDE.md). Using UTC date.today()
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
# Window for "rolling" metrics. Previously the function aggregated *all* history,
# desensitizing the metric over time. 30 days matches the function name.
ROLLING_WINDOW_DAYS = 30


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


def load_model() -> dict | None:
    if not MODEL_PATH.exists():
        log.error(f"Model not found at {MODEL_PATH}. Run hrv_analysis.py first.")
        return None
    with open(MODEL_PATH, "rb") as f:
        return pickle.load(f)


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


def predict_tomorrow(model_bundle: dict) -> dict | None:
    """Generate tomorrow's prediction using the loaded model."""
    from hrv_analysis import FEATURE_LABELS, compute_input_data_hash, TARGET

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

    # Predict on latest row
    latest_X = X.iloc[[-1]]
    pred_val = float(model.predict(latest_X)[0])
    lower = pred_val - 1.645 * pred_std
    upper = pred_val + 1.645 * pred_std

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
        "prediction_date": str(et_today() + timedelta(days=1)),
        "model": "xgboost",
        "predicted_hrv": round(pred_val, 2),
        "prediction_lower": round(lower, 2),
        "prediction_upper": round(upper, 2),
        "actual_hrv": None,
        "horizon_days": 1,
        "top_drivers": json.dumps(top_drivers_payload),
        "model_version": MODEL_VERSION,
        "training_window_start": model_bundle.get("model_version", "").split("_")[0],
        "training_window_end": train_end,
        "today_hrv": today_hrv,
        "input_data_hash": input_data_hash,
    }


def backfill_actuals() -> int:
    """Fill actual_hrv and residual for past predictions where actual is NULL.

    Only predictions whose prediction_date is strictly before today are eligible:
    today's WHOOP cycle is still in progress or unscored, so the actual is not
    yet observable.
    """
    log.info("Backfilling actuals…")

    past_preds = fetch_all(
        "hrv_predictions",
        select="prediction_date,model,horizon_days,predicted_hrv",
        filters=[("actual_hrv", "is_", "null")],
    )
    if past_preds.empty:
        log.info("  No predictions to backfill.")
        return 0

    today = str(et_today())
    past_preds = past_preds[past_preds["prediction_date"] < today]

    if past_preds.empty:
        log.info("  No observable predictions to backfill.")
        return 0

    min_date = past_preds["prediction_date"].min()
    actuals_raw = fetch_all(
        "daily_health_matrix",
        select="calendar_date,whoop_hrv_rmssd",
        filters=[("calendar_date", "gte", min_date)],
    )
    if actuals_raw.empty:
        return 0

    actuals_map = dict(zip(actuals_raw["calendar_date"], actuals_raw["whoop_hrv_rmssd"]))

    updates = []
    for _, row in past_preds.iterrows():
        actual = actuals_map.get(row["prediction_date"])
        if actual is None or pd.isna(actual):
            continue
        actual_f = float(actual)
        if actual_f != actual_f:  # NaN survivors
            continue
        pred_f = float(row["predicted_hrv"])
        updates.append({
            "prediction_date": str(row["prediction_date"]),
            "model": str(row["model"]),
            "horizon_days": int(row["horizon_days"]),
            "actual_hrv": actual_f,
            "residual": actual_f - pred_f,
        })

    if updates:
        supa.schema("pds").from_("hrv_predictions").upsert(
            _clean_for_json(updates), on_conflict="prediction_date,model,horizon_days"
        ).execute()
        log.info(f"  Backfilled actuals for {len(updates)} predictions.")

    return len(updates)


def recompute_rolling_metrics() -> None:
    """Recompute rolling N-day metrics and upsert into hrv_model_metrics.

    The function name promises a rolling window; the previous implementation read
    every historical row, which desensitized the metric as the dataset grew. We
    now restrict to predictions whose prediction_date is within the last
    ROLLING_WINDOW_DAYS days, so a recent regression actually moves the number.
    """
    log.info(f"Recomputing rolling {ROLLING_WINDOW_DAYS}-day metrics…")
    today_str = str(et_today())
    window_start = (et_today() - timedelta(days=ROLLING_WINDOW_DAYS)).isoformat()

    preds = fetch_all(
        "hrv_predictions",
        select="prediction_date,model,horizon_days,predicted_hrv,actual_hrv,"
               "prediction_lower,prediction_upper",
        filters=[("prediction_date", "gte", window_start)],
    )
    if preds.empty:
        return

    preds = preds.dropna(subset=["actual_hrv", "predicted_hrv"])
    preds["actual_hrv"] = pd.to_numeric(preds["actual_hrv"], errors="coerce")
    preds["predicted_hrv"] = pd.to_numeric(preds["predicted_hrv"], errors="coerce")
    preds = preds.dropna(subset=["actual_hrv", "predicted_hrv"])
    if preds.empty:
        return

    rows = []
    for model_name in preds["model"].unique():
        sub = preds[preds["model"] == model_name].copy()
        sub = sub.sort_values("prediction_date")
        sub["abs_err"] = (sub["actual_hrv"] - sub["predicted_hrv"]).abs()

        if len(sub) >= 5:
            mae = float(sub["abs_err"].mean())
            rmse = float(np.sqrt((sub["actual_hrv"] - sub["predicted_hrv"]).pow(2).mean()))
            # Standard directional accuracy: did the forecast for day t, relative
            # to *yesterday's actual*, point in the same direction as the actual
            # change from yesterday to today? Compares pred(t) - actual(t-1)
            # against actual(t) - actual(t-1). The previous version compared
            # diff(predictions) vs diff(actuals), which understates accuracy when
            # successive predictions are both close to the mean.
            actuals = sub["actual_hrv"].values
            preds_arr = sub["predicted_hrv"].values
            if len(actuals) > 1:
                actual_change = np.diff(actuals)
                pred_change_from_prev_actual = preds_arr[1:] - actuals[:-1]
                dir_acc = float(np.mean(np.sign(actual_change) == np.sign(pred_change_from_prev_actual)) * 100)
                dir_acc_legacy = float(np.mean(np.sign(actual_change) == np.sign(np.diff(preds_arr))) * 100)
            else:
                dir_acc = None
                dir_acc_legacy = None
            rows.append({
                "eval_date": today_str,
                "model": model_name,
                "horizon_days": 1,
                "mae": mae,
                "rmse": rmse,
                "n_predictions": len(sub),
                "directional_accuracy": dir_acc,
                "directional_accuracy_legacy": dir_acc_legacy,
                "model_version": MODEL_VERSION,
            })

    if rows:
        supa.schema("pds").from_("hrv_model_metrics").upsert(
            _clean_for_json(rows), on_conflict="eval_date,model,horizon_days"
        ).execute()
        log.info(f"  Updated metrics for {len(rows)} models (last {ROLLING_WINDOW_DAYS} days).")


def check_drift(current_mae: float | None) -> None:
    """Compare current 30-day MAE against backtest MAE; log warning if drifting."""
    if current_mae is None:
        return
    # Fetch backtest baseline MAE. Order by eval_date ASC + horizon_days ASC so we
    # always anchor against the *first* recorded backtest at horizon=1, rather
    # than whichever row happens to come back first from the unordered query.
    baseline_rows = (
        supa.schema("pds")
        .from_("hrv_model_metrics")
        .select("mae,eval_date,horizon_days")
        .eq("model", "xgboost")
        .eq("model_version", "backtest_initial")
        .eq("horizon_days", 1)
        .order("eval_date", desc=False)
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
        supa.schema("pds").from_("sync_log").insert(_clean_for_json({
            "source": "hrv_predict",
            "data_type": "drift_alert",
            "status": "warning",
            "records_synced": 0,
            "error_message": f"HRV model drift: current MAE={current_mae:.1f}ms vs backtest {baseline_mae:.1f}ms",
        })).execute()


def main() -> None:
    parser = argparse.ArgumentParser(description="Onyx HRV Daily Prediction")
    parser.add_argument("--predict", action="store_true", help="Generate tomorrow's prediction")
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
        try:
            model_bundle = load_model()
            if model_bundle is None:
                stage_errors.append("load_model")
            else:
                prediction = predict_tomorrow(model_bundle)
                if prediction is None:
                    stage_errors.append("predict_tomorrow")
                    log.error("Failed to generate prediction.")
                else:
                    today_hrv = prediction.pop("today_hrv", None)

                    payload = [{k: v for k, v in prediction.items() if v is not None}]
                    supa.schema("pds").from_("hrv_predictions").upsert(
                        _clean_for_json(payload),
                        on_conflict="prediction_date,model,horizon_days",
                    ).execute()

                    log.info(
                        f"Tomorrow ({prediction['prediction_date']}): "
                        f"predicted HRV = {prediction['predicted_hrv']} ms  "
                        f"(90% CI: {prediction['prediction_lower']} - {prediction['prediction_upper']})"
                    )
                    if today_hrv:
                        log.info(f"Today's actual HRV: {today_hrv:.1f} ms")

                    try:
                        metrics = supa.schema("pds").from_("hrv_model_metrics").select("mae").eq(
                            "model", "xgboost"
                        ).order("eval_date", desc=True).limit(1).execute()
                        current_mae = float(metrics.data[0]["mae"]) if metrics.data else None
                        check_drift(current_mae)
                    except Exception as e:
                        stage_errors.append("check_drift")
                        log.exception(f"check_drift failed: {e}")
        except Exception as e:
            stage_errors.append("predict")
            log.exception(f"predict stage failed: {e}")

    if stage_errors:
        log.error(f"{len(stage_errors)} stage(s) failed: {', '.join(stage_errors)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
