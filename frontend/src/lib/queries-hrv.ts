// ---------------------------------------------------------------------------
// /analytics/hrv data layer (perf pass 2026-06-11)
//
// Extracted verbatim from HrvAnalysisClient.tsx so the SAME functions can run
// (a) server-side in page.tsx for the ISR prefetch and (b) client-side for the
// silent mount revalidation + range changes. Uses the module-level anon
// supabase-js client (lib/supabase), which works in both runtimes — RLS grants
// anon read-only.
//
// All forecast queries read from pds.hrv_predictions_latest — a DISTINCT ON
// view that returns one row per (prediction_date, model, horizon_days), always
// the freshest and excluding backtest rows. Readers do not reason about
// run-history or model_version freshness.
//
// loadHrvDashboard(days) is the ONE shared entry point: it performs the entire
// former mount-effect Promise.all (26 calls) plus the post-processing the
// effect's .then used to do (parseJsonb, slice(0,15)/slice(0,10)), returning a
// typed object whose fields map 1:1 onto the Client's state variables.
// Internally split into loadHrvStatic() (23 range-independent calls) +
// loadHrvRangeDependent(days) (the 3 calls that actually vary with the range
// filter) so the Client's range effect can revalidate narrowly.
// ---------------------------------------------------------------------------

import { supabase } from "@/lib/supabase";
import { getWorkoutSleepGap, type WorkoutSleepGap } from "@/lib/queries";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Behavioral today as YYYY-MM-DD: the ET clock minus 6 h (before ~6 AM it is
// still yesterday's behavioral day). The live forecast is stored under this
// date: prediction_date = behavioral date of the predicted sleep (tonight's),
// which Riley wakes up from the next calendar day (hrv_alignment.py, 2026-11-10).
function etBehavioralTodayStr(): string {
  const shifted = new Date(Date.now() - 6 * 3600 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(shifted);
  const y = parts.find(p => p.type === "year")!.value;
  const m = parts.find(p => p.type === "month")!.value;
  const d = parts.find(p => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

// Every fetch below MUST `if (error) throw error` (like lib/queries.ts): the
// fail-open prefetch in page.tsx and the seed-preserving .catch in the
// Client's silent revalidation both rely on failures REJECTING the load —
// supabase-js returns { data: null, error } without throwing, so a swallowed
// error would bake an empty-but-non-null snapshot into the ISR cache and let
// a transient failure wipe seeded charts to their empty states.

// Tonight's-sleep forecast (the HRV Riley wakes up to tomorrow). Name kept for
// the existing callers / ISR payload key.
export async function getTomorrowPrediction() {
  const tomorrow = etBehavioralTodayStr();
  const cols = "prediction_date,model,predicted_hrv,prediction_lower,prediction_upper,actual_hrv,horizon_days,top_drivers,model_version";
  const primary = await supabase
    .from("hrv_predictions_latest")
    .select(cols)
    .eq("model", "xgboost")
    .eq("horizon_days", 1)
    .eq("prediction_date", tomorrow)
    .is("actual_hrv", null)
    .limit(1);
  if (primary.error) throw primary.error;
  if (primary.data?.[0]) return primary.data[0];
  // Fallback: earliest unscored XGBoost h=1 on or after behavioral today.
  const fb = await supabase
    .from("hrv_predictions_latest")
    .select(cols)
    .eq("model", "xgboost")
    .eq("horizon_days", 1)
    .gte("prediction_date", tomorrow)
    .is("actual_hrv", null)
    .order("prediction_date", { ascending: true })
    .limit(1);
  if (fb.error) throw fb.error;
  return fb.data?.[0] ?? null;
}

export async function getHrvPredictionAccuracy(days: number = 60) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data, error } = await supabase
    .from("hrv_predictions_latest")
    .select("prediction_date,model,predicted_hrv,actual_hrv,residual,prediction_lower,prediction_upper")
    .eq("model", "xgboost")
    .eq("horizon_days", 1)
    .not("actual_hrv", "is", null)
    .gte("prediction_date", since.toISOString().split("T")[0])
    .order("prediction_date", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getHrvModelMetrics() {
  // Latest eval_date now writes ~36 rows (xgboost + 3 baselines + sarimax all at
  // h=1..7 = 35, plus prophet h=1 = 36). Limit must cover the full latest sweep
  // so the Accuracy-by-Forecast-Horizon chart sees every (model × horizon) cell.
  //
  // Secondary .order()s (perf round 3, 2026-06-11): eval_date alone is a
  // non-unique sort key, so Postgres was free to return the ~36 tied rows per
  // eval_date in ANY order — which (a) made the LIMIT 100 cut the boundary
  // eval_date's rows nondeterministically and (b) defeated the client's
  // sameJson revalidation bailout (identical data, different serialization).
  // model + horizon_days make the ordering fully deterministic.
  const { data, error } = await supabase
    .from("hrv_model_metrics")
    .select("*")
    .order("eval_date", { ascending: false })
    .order("model")
    .order("horizon_days")
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

export async function getHrvAnalysisResults(resultType: string, resultKey?: string) {
  let query = supabase
    .from("hrv_analysis_results")
    .select("result_type,result_key,result_json,computed_at")
    .eq("result_type", resultType);
  if (resultKey) query = query.eq("result_key", resultKey);
  const { data, error } = await query.order("computed_at", { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

// Three requests for the dashboard's analysis panels rather than 17 concurrent
// requests competing for browser connections and database capacity. Keep the
// type-only selectors bounded: they deliberately choose the newest key of that type.
export const HRV_ANALYSIS_PANELS: readonly (readonly [string, string?])[] = [
  ["correlation", "spearman_top50"], ["journal_impact"],
  ["feature_importance", "shap_mean_abs"], ["correlation", "spearman_journal"],
  ["feature_importance", "shap_journal"], ["supplement_impact", "yes_no"],
  ["supplement_impact", "dose_response"], ["nutrition_impact", "spearman"],
  ["habit_impact"], ["correlation", "spearman_habit"],
  ["feature_importance", "shap_habit"], ["causal", "binary_treatments"],
  ["causal", "continuous_treatments"], ["causal", "dag"],
  ["causal", "meta"], ["causal", "dropped_low_n"], ["model_diagnostics", "xgboost"],
];

export async function getHrvAnalysisBatch() {
  // These are fixed internal identifiers, never user-supplied filter strings.
  const exactPanels = HRV_ANALYSIS_PANELS.filter(([, key]) => key);
  const filter = exactPanels.map(([type, key]) =>
    `and(result_type.eq.${type},result_key.eq.${key})`).join(",");
  // The existing unique (result_type, result_key) constraint bounds this to
  // 15 rows. Type-only selectors retain their LIMIT 1 queries, so future keys
  // cannot turn one rendered panel into an unbounded download of JSON blobs.
  const [exact, journal, habits] = await Promise.all([
    supabase.from("hrv_analysis_results")
      .select("result_type,result_key,result_json,computed_at")
      .or(filter)
      .order("computed_at", { ascending: false })
      .order("result_type").order("result_key"),
    getHrvAnalysisResults("journal_impact"),
    getHrvAnalysisResults("habit_impact"),
  ]);
  if (exact.error) throw exact.error;
  const rows = [...(exact.data ?? []), ...[journal, habits].filter(Boolean)];
  return (type: string, key?: string) => rows.find(row =>
    row.result_type === type && (!key || row.result_key === key)) ?? null;
}

// hrv_analysis_results.result_json is a jsonb column, so supabase-js returns it
// already-parsed — calling JSON.parse() on the object throws (silently, via the
// bare catch blocks below) and the chart renders empty. Pre-2026-05-26 rows were
// double-encoded strings (the JSONB-audit bug), so still handle the string case.
export function parseJsonb(v: unknown): any {
  return typeof v === "string" ? JSON.parse(v) : (v ?? null);
}

export async function getHistoricalHrv(days = 180) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  // ADR-0001 Phase 3: HRV is the morning-after measurement that "belongs to"
  // the prior night's behaviors, so the trend line should sit on the
  // bedtime-day (onyx_behavioral_date), not the watch-local clock-day. The
  // difference is invisible most nights, but a pre-midnight bedtime shifts
  // calendar_date one day earlier than the behavioral attribution; charts
  // that key on calendar_date drift relative to the prediction/causal
  // panels which are already behavioral-day-keyed.
  //
  // Reads the 15-min-refreshed matview (created 2026-06-11) instead of the
  // live view — staleness is invisible to this historical chart.
  const { data, error } = await supabase
    .from("daily_health_matrix_behavioral_mat")
    .select("onyx_behavioral_date,whoop_hrv_rmssd")
    .gte("onyx_behavioral_date", since.toISOString().split("T")[0])
    .not("whoop_hrv_rmssd", "is", null)
    .order("onyx_behavioral_date", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// All-time pull (no date filter) of nights that have a temperature reading
// AND any of that night's outcomes. Powers the Environment Sweet Spot
// dose-response chart, which buckets nights by selected temperature and
// shows mean of the selected outcome per bucket. Filters at "any temp + HRV"
// so we don't drop nights where bed_temp is present but room_temp isn't.
// Per-row null-check happens client-side per selected axis pair.
export async function getEnvDoseResponseData() {
  // Pairs each night's bedroom / bed temperature with the HRV / recovery /
  // sleep of THAT SAME night. Eight Sleep rows are dated by the wake-up day,
  // so in the matrix the temperature on row D belongs to the sleep on row D-1
  // (live check 2026-11-10: Eight Sleep HRV on row D+1 vs WHOOP HRV on row D,
  // r = 0.84). The pipeline re-keys it in hrv_alignment.realign_matrix; this
  // chart reads the matview directly, so it does the same move here: the
  // outcome on row D is paired with the temperatures from row D+1.
  //
  // Reads the 15-min-refreshed matview (created 2026-06-11) instead of the
  // live view — staleness is invisible to this historical chart.
  // Paged: every HRV night is needed (not just temperature nights), which passes
  // PostgREST's 1000-row cap as history grows.
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("daily_health_matrix_behavioral_mat")
      .select(
        "onyx_behavioral_date,eight_sleep_room_temp,eight_sleep_bed_temp,whoop_hrv_rmssd," +
        "whoop_recovery_score,whoop_sleep_efficiency,whoop_deep_sleep_milli"
      )
      .or("eight_sleep_room_temp.not.is.null,eight_sleep_bed_temp.not.is.null,whoop_hrv_rmssd.not.is.null")
      .order("onyx_behavioral_date", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const temps = new Map<string, { room: any; bed: any }>();
  for (const r of rows) temps.set(r.onyx_behavioral_date, { room: r.eight_sleep_room_temp, bed: r.eight_sleep_bed_temp });
  const nextDay = (d: string) => {
    const t = new Date(d + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().split("T")[0];
  };
  return rows
    .filter(r => r.whoop_hrv_rmssd != null)
    .map(r => {
      const t = temps.get(nextDay(r.onyx_behavioral_date));
      return { ...r, eight_sleep_room_temp: t?.room ?? null, eight_sleep_bed_temp: t?.bed ?? null };
    })
    .filter(r => r.eight_sleep_room_temp != null || r.eight_sleep_bed_temp != null);
}

export async function getHrvResiduals() {
  // Reads pds.hrv_residuals_mat (perf round 3, 2026-06-11) — a 5-col narrow
  // matview (prediction_date, model, predicted_hrv, actual_hrv, residual)
  // over the h=1 *_eval rows, refreshed every 15 min. The matview has NO
  // horizon_days column (h=1 is baked in), so do not re-add that filter —
  // it would 400.
  //
  // Narrowed to xgboost only: the single consumer (HrvAnalysisClient's
  // 20-bin residual histogram) filters to model === "xgboost" client-side
  // anyway, so fetching the baselines was pure dead weight. With the column
  // list trimmed too, the payload drops from ~168kB to ~12kB. Bonus
  // correctness fix: the old wide query was silently capped at PostgREST's
  // 1000-row default (1,153 rows existed); the narrowed ~387-row result is
  // complete.
  const { data, error } = await supabase
    .from("hrv_residuals_mat")
    .select("prediction_date,model,residual")
    .eq("model", "xgboost")
    .not("residual", "is", null)
    .order("prediction_date", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getProphetForecast() {
  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("hrv_predictions_latest")
    .select("prediction_date,predicted_hrv,prediction_lower,prediction_upper,actual_hrv")
    .eq("model", "prophet")
    .gte("prediction_date", today)
    .order("prediction_date", { ascending: true })
    .limit(30);
  if (error) throw error;
  return data ?? [];
}

export async function getSarimaxForecast() {
  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("hrv_predictions_latest")
    .select("prediction_date,predicted_hrv,prediction_lower,prediction_upper")
    .eq("model", "sarimax")
    .gte("prediction_date", today)
    .order("prediction_date", { ascending: true })
    .limit(7);
  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Shared dashboard loaders
// ---------------------------------------------------------------------------

type AnalysisRow = { result_json: unknown } | null;

// Mirror the former effect's `if (row?.result_json) try { … } catch {}`
// semantics: a missing row or a parse failure yields the state default
// (empty array / null) instead of throwing — one bad payload must not blank
// the whole dashboard.
function parsedArray(row: AnalysisRow, sliceTo?: number): any[] {
  if (!row?.result_json) return [];
  try {
    const parsed = parseJsonb(row.result_json);
    return sliceTo != null ? parsed.slice(0, sliceTo) : parsed;
  } catch {
    return [];
  }
}

function parsedObject(row: AnalysisRow): any | null {
  if (!row?.result_json) return null;
  try {
    return parseJsonb(row.result_json);
  } catch {
    return null;
  }
}

/** The 3 series that actually depend on the page's range filter. */
export interface HrvRangeDependent {
  accuracy: any[];
  historicalHrv: any[];
  workoutGap: WorkoutSleepGap[];
}

/**
 * Everything loadHrvDashboard returns — fields map 1:1 onto the Client's
 * state variables (and onto the HrvInitial the server page serializes).
 */
export interface HrvDashboardData extends HrvRangeDependent {
  tomorrowPred: any | null;
  metrics: any[];
  correlations: any[];
  journalImpact: any[];
  featureImportance: any[];
  residuals: any[];
  prophetForecast: any[];
  sarimaxForecast: any[];
  journalCorrelations: any[];
  journalShap: any[];
  supplementImpact: any[];
  supplementDoseResponse: any[];
  nutritionImpact: any[];
  habitImpact: any[];
  habitCorrelations: any[];
  habitShap: any[];
  causalBinary: any[];
  causalContinuous: any[];
  causalDag: any | null;
  causalMeta: any | null;
  causalDropped: any[];
  envMatrix: any[];
  xgbDiagnostics: any | null;
}

/**
 * The 3 range-dependent fetches (per-call args exactly as the Client's
 * effect passed them: each receives the range-derived `days`). The Client's
 * range effect calls ONLY this, so changing the range no longer re-runs the
 * 23 static calls or flips the page-wide skeleton.
 */
export async function loadHrvRangeDependent(days: number): Promise<HrvRangeDependent> {
  const [accuracy, historicalHrv, workoutGap] = await Promise.all([
    getHrvPredictionAccuracy(days),
    getHistoricalHrv(days),
    getWorkoutSleepGap(days),
  ]);
  return { accuracy, historicalHrv, workoutGap };
}

/**
 * The 23 range-independent fetches + the post-processing the mount effect's
 * .then used to apply (parseJsonb + slice caps). Args per call are preserved
 * exactly as the effect passed them (explicit keys; no-arg where the effect
 * passed nothing).
 */
async function loadHrvStatic(): Promise<Omit<HrvDashboardData, keyof HrvRangeDependent>> {
  const analysis = getHrvAnalysisBatch();
  const panel = (type: string, key?: string) => analysis.then(select => select(type, key));
  const [
    tomorrow, m, corr, ji, fi, res, prophet, jCorr, jShap, sarimax,
    suppImp, suppDose, nutImp, hi, hCorr, hShap,
    cBin, cCont, cDag, cMeta, cDrop, envM, xgbDiag,
  ] = await Promise.all([
    getTomorrowPrediction(),
    getHrvModelMetrics(),
    panel("correlation", "spearman_top50"),
    panel("journal_impact"),
    panel("feature_importance", "shap_mean_abs"),
    getHrvResiduals(),
    getProphetForecast(),
    panel("correlation", "spearman_journal"),
    panel("feature_importance", "shap_journal"),
    getSarimaxForecast(),
    panel("supplement_impact", "yes_no"),
    panel("supplement_impact", "dose_response"),
    panel("nutrition_impact", "spearman"),
    panel("habit_impact"),
    panel("correlation", "spearman_habit"),
    panel("feature_importance", "shap_habit"),
    panel("causal", "binary_treatments"),
    panel("causal", "continuous_treatments"),
    panel("causal", "dag"),
    panel("causal", "meta"),
    panel("causal", "dropped_low_n"),
    getEnvDoseResponseData(),
    panel("model_diagnostics", "xgboost"),
  ]);
  return {
    tomorrowPred: tomorrow,
    metrics: m,
    correlations: parsedArray(corr, 15),
    journalImpact: parsedArray(ji, 15),
    featureImportance: parsedArray(fi, 10),
    residuals: res,
    prophetForecast: prophet,
    sarimaxForecast: sarimax,
    journalCorrelations: parsedArray(jCorr),
    journalShap: parsedArray(jShap),
    supplementImpact: parsedArray(suppImp),
    supplementDoseResponse: parsedArray(suppDose),
    nutritionImpact: parsedArray(nutImp),
    habitImpact: parsedArray(hi),
    habitCorrelations: parsedArray(hCorr),
    habitShap: parsedArray(hShap),
    causalBinary: parsedArray(cBin),
    causalContinuous: parsedArray(cCont),
    causalDag: parsedObject(cDag),
    causalMeta: parsedObject(cMeta),
    // Project dropped_low_n rows to ONLY the 5 keys the client reads
    // (HrvAnalysisClient: supplements-coverage callout ~1563-1569/1606-1619 +
    // DAG card dropped-treatments list ~2062-2099 — treatment is the React
    // key, label/family render, n_treated/n_control sort + display). The raw
    // rows carry verbose reason/diagnostic fields that cost ~48kB of ISR
    // payload; the projection is ~9kB. (perf round 3, 2026-06-11)
    causalDropped: parsedArray(cDrop).map((d: any) => ({
      treatment: d.treatment,
      label: d.label,
      family: d.family,
      n_treated: d.n_treated,
      n_control: d.n_control,
    })),
    envMatrix: envM,
    // model_diagnostics/xgboost row carries feature_condition_number +
    // shap_unstable from the latest train_xgboost run; the banner above
    // Prediction Drivers reads it to flag SHAP attributions as unreliable
    // when the training matrix is heavily collinear.
    xgbDiagnostics: parsedObject(xgbDiag),
  };
}

/**
 * Full dashboard load — exactly what the Client's mount effect produced on
 * its first run pre-split. Called by BOTH the server page (ISR prefetch,
 * days = rangeDays("30d") — the Client's default range) and the Client's
 * mount effect (silent revalidation when seeded), so the two can never
 * diverge on args.
 */
export async function loadHrvDashboard(days: number): Promise<HrvDashboardData> {
  const [staticData, rangeData] = await Promise.all([
    loadHrvStatic(),
    loadHrvRangeDependent(days),
  ]);
  return { ...staticData, ...rangeData };
}
