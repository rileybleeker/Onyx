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

MODEL_PATH = Path("analysis_output") / "xgboost_hrv_model.pkl"
MODEL_VERSION = f"{date.today().isoformat()}_v1"

# Drift threshold: alert if rolling 30-day MAE exceeds 1.5x backtest MAE
DRIFT_THRESHOLD = 1.5


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
    from hrv_analysis import FEATURE_LABELS

    model = model_bundle["model"]
    feat_cols = model_bundle["feat_cols"]
    pred_std = model_bundle.get("pred_std", 15.0)

    result = get_latest_features(feat_cols)
    if result is None or result[0] is None:
        return None
    df, X = result

    # Predict on latest row
    latest_X = X.iloc[[-1]]
    pred_val = float(model.predict(latest_X)[0])
    lower = pred_val - 1.645 * pred_std
    upper = pred_val + 1.645 * pred_std

    # SHAP top drivers if available
    top_drivers = []
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
        top_drivers = sorted(drivers, key=lambda x: abs(x["shap_value"]), reverse=True)[:10]
    except Exception:
        pass

    today_hrv = float(df["whoop_hrv_rmssd"].dropna().iloc[-1]) if df["whoop_hrv_rmssd"].dropna().shape[0] > 0 else None
    train_end = str(df["calendar_date"].iloc[-1])

    return {
        "prediction_date": str(date.today() + timedelta(days=1)),
        "model": "xgboost",
        "predicted_hrv": round(pred_val, 2),
        "prediction_lower": round(lower, 2),
        "prediction_upper": round(upper, 2),
        "actual_hrv": None,
        "horizon_days": 1,
        "top_drivers": json.dumps(top_drivers),
        "model_version": MODEL_VERSION,
        "training_window_start": model_bundle.get("model_version", "").split("_")[0],
        "training_window_end": train_end,
        "today_hrv": today_hrv,
    }


def backfill_actuals() -> int:
    """Fill actual_hrv and residual for past predictions where actual is NULL."""
    log.info("Backfilling actuals…")

    # Fetch predictions missing actuals
    past_preds = fetch_all(
        "hrv_predictions",
        select="prediction_date,model,horizon_days,predicted_hrv",
        filters=[("actual_hrv", "is_", "null")],
    )
    if past_preds.empty:
        log.info("  No predictions to backfill.")
        return 0

    today = str(date.today())
    past_preds = past_preds[past_preds["prediction_date"] <= today]

    if past_preds.empty:
        return 0

    # Fetch actual HRV for those dates from daily_health_matrix
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
        if actual is None or str(actual).lower() == "none":
            continue
        actual_f = float(actual)
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
            updates, on_conflict="prediction_date,model,horizon_days"
        ).execute()
        log.info(f"  Backfilled actuals for {len(updates)} predictions.")

    return len(updates)


def recompute_rolling_metrics() -> None:
    """Recompute rolling 30-day metrics and upsert into hrv_model_metrics."""
    log.info("Recomputing rolling metrics…")
    today_str = str(date.today())

    preds = fetch_all(
        "hrv_predictions",
        select="prediction_date,model,horizon_days,predicted_hrv,actual_hrv,"
               "prediction_lower,prediction_upper",
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
            dir_changes = np.sign(np.diff(sub["actual_hrv"].values))
            pred_changes = np.sign(np.diff(sub["predicted_hrv"].values))
            dir_acc = float(np.mean(dir_changes == pred_changes) * 100) if len(dir_changes) > 0 else None
            rows.append({
                "eval_date": today_str,
                "model": model_name,
                "horizon_days": 1,
                "mae": mae,
                "rmse": rmse,
                "n_predictions": len(sub),
                "directional_accuracy": dir_acc,
                "model_version": MODEL_VERSION,
            })

    if rows:
        supa.schema("pds").from_("hrv_model_metrics").upsert(
            rows, on_conflict="eval_date,model,horizon_days"
        ).execute()
        log.info(f"  Updated metrics for {len(rows)} models.")


def check_drift(current_mae: float | None) -> None:
    """Compare current 30-day MAE against backtest MAE; log warning if drifting."""
    if current_mae is None:
        return
    # Fetch backtest baseline MAE
    baseline_rows = supa.schema("pds").from_("hrv_model_metrics").select("mae").eq(
        "model", "xgboost"
    ).eq("model_version", "backtest_initial").execute()
    if not baseline_rows.data:
        return
    baseline_mae = float(baseline_rows.data[0].get("mae", 999))
    if current_mae > DRIFT_THRESHOLD * baseline_mae:
        log.warning(
            f"MODEL DRIFT DETECTED: current 30d MAE={current_mae:.1f}ms, "
            f"backtest MAE={baseline_mae:.1f}ms (threshold ×{DRIFT_THRESHOLD}). "
            "Consider retraining."
        )
        supa.schema("pds").from_("sync_log").insert({
            "source": "hrv_predict",
            "data_type": "drift_alert",
            "status": "warning",
            "records_synced": 0,
            "error_message": f"HRV model drift: current MAE={current_mae:.1f}ms vs backtest {baseline_mae:.1f}ms",
        }).execute()


def main() -> None:
    parser = argparse.ArgumentParser(description="Onyx HRV Daily Prediction")
    parser.add_argument("--predict", action="store_true", help="Generate tomorrow's prediction")
    parser.add_argument("--backfill-only", action="store_true", help="Only backfill actuals")
    args = parser.parse_args()

    if not (args.predict or args.backfill_only):
        parser.print_help()
        sys.exit(0)

    # Always backfill actuals first
    backfill_actuals()
    recompute_rolling_metrics()

    if args.predict:
        model_bundle = load_model()
        if model_bundle is None:
            sys.exit(1)

        prediction = predict_tomorrow(model_bundle)
        if prediction is None:
            log.error("Failed to generate prediction.")
            sys.exit(1)

        today_hrv = prediction.pop("today_hrv", None)

        # Upsert tomorrow's prediction
        supa.schema("pds").from_("hrv_predictions").upsert(
            [{k: v for k, v in prediction.items() if v is not None}],
            on_conflict="prediction_date,model,horizon_days",
        ).execute()

        log.info(
            f"Tomorrow ({prediction['prediction_date']}): "
            f"predicted HRV = {prediction['predicted_hrv']} ms  "
            f"(90% CI: {prediction['prediction_lower']} – {prediction['prediction_upper']})"
        )
        if today_hrv:
            log.info(f"Today's actual HRV: {today_hrv:.1f} ms")

        # Drift check
        metrics = supa.schema("pds").from_("hrv_model_metrics").select("mae").eq(
            "model", "xgboost"
        ).order("eval_date", desc=True).limit(1).execute()
        current_mae = float(metrics.data[0]["mae"]) if metrics.data else None
        check_drift(current_mae)


if __name__ == "__main__":
    main()
