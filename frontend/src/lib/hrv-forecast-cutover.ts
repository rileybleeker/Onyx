// Which forecast rows (pds.hrv_predictions_latest / pds.hrv_predictions_eval) are comparable
// under the same-night pairing.
//
// Since the alignment fix (hrv_alignment.py, shipped 2026-11-11) a forecast's
// prediction_date is the behavioral date of the sleep it predicts: the night that begins at
// the end of that date, scored against the same matrix row. Live forecasts written before
// the fix used the old, one-night-late pairing, so their "misses" compare a forecast with
// the wrong night and say nothing about the model. The walk-forward backtest rows are
// rewritten by every retrain (upsert on date/model/horizon/model_version), so the ones the
// retrain still produces follow the current rule whatever date they carry. A few backtest
// rows for dates the retrain no longer produces keep their pre-fix values (14 on
// 2026-11-11, an older input_data_hash); nothing in the row says so, so they stay counted.
//
// Pure module (no Supabase, no React) so node:test can cover it directly.

// First prediction_date made by the same-night code: the live forecast for behavioral night
// 2026-11-10 (created 2026-11-11 01:06 ET). Live forecasts on earlier dates are old pairing.
export const SAME_NIGHT_FIRST_PREDICTION_DATE = "2026-11-10";

export type ForecastRowLike = {
  prediction_date?: unknown;
  model_version?: unknown;
};

export type ForecastSource =
  | "walk-forward backtest"
  | "live forecast"
  | "live forecast, old pairing (before the fix)";

export function isBacktestRow(row: ForecastRowLike): boolean {
  return String(row.model_version ?? "").startsWith("backtest");
}

export function forecastSource(row: ForecastRowLike): ForecastSource {
  if (isBacktestRow(row)) return "walk-forward backtest";
  return String(row.prediction_date ?? "") >= SAME_NIGHT_FIRST_PREDICTION_DATE
    ? "live forecast"
    : "live forecast, old pairing (before the fix)";
}

// True when the row's miss (actual - predicted) measures the model under the current rule.
export function isSameNightComparable(row: ForecastRowLike): boolean {
  return forecastSource(row) !== "live forecast, old pairing (before the fix)";
}

// Split rows into the ones accuracy numbers may use and the old-pairing ones left out.
export function splitComparable<T extends ForecastRowLike>(rows: T[]): { used: T[]; excluded: T[] } {
  const used: T[] = [];
  const excluded: T[] = [];
  for (const r of rows) (isSameNightComparable(r) ? used : excluded).push(r);
  return { used, excluded };
}
