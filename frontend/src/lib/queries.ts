import { supabase } from "./supabase";
import { whoopSleepDay, kjToKcal } from "./format";

// Re-audit 2026-06-07 (units/deepseek/F-003): promoted the workout→sleep gap
// window from a function-local literal to a named module-level const. The pairing
// only considers a workout "before" a sleep if it ended within this many ms.
const WORKOUT_SLEEP_GAP_MAX_MS = 18 * 60 * 60 * 1000; // 18 hours

/**
 * Duration unit convention across this module:
 *   - Garmin daily summary / sleep / activities → SECONDS (`*_seconds`,
 *     `duration_seconds`, etc.)
 *   - Eight Sleep trends + sessions → SECONDS (`*_seconds`)
 *   - WHOOP sleep / workouts / recovery → MILLISECONDS (`*_milli`)
 *
 * For chart layer:
 *   - `formatDuration(sec)` expects seconds. Pass Garmin/Eight Sleep fields
 *     directly.
 *   - `formatDurationMs(ms)` accepts milliseconds. Pass WHOOP `*_milli`
 *     fields directly instead of dividing by 1000 in the call site.
 *
 * The asymmetry comes from the upstream APIs (WHOOP's v2 API returns ms,
 * everyone else returns seconds). We preserve the unit in the field name
 * rather than normalizing at the query layer so the units stay obvious in
 * every consumer.
 */

// Explicit column lists = every scalar column EXCEPT the raw jsonb blobs
// (raw_json / raw_hr_values / raw_stress_values / raw_hrv_readings /
// load_focus). The Garmin tables ship the full API response as jsonb —
// garmin_sleep is ~19 kB/row, garmin_stress carries minute-level samples —
// and no chart reads any of it, so select("*") wasted most of the transfer.
// "All scalars" rather than minimal per-consumer lists so future chart
// additions don't silently read undefined; if the ETL adds a scalar column,
// append it here too. (Same convention as the WHOOP_*_COLS lists below.)
const GARMIN_DAILY_COLS =
  "ts, calendar_date, total_steps, daily_step_goal, total_distance_meters, floors_ascended, floors_descended, total_kilocalories, active_kilocalories, bmr_kilocalories, resting_heart_rate, min_heart_rate, max_heart_rate, last_seven_days_avg_rhr, avg_stress_level, max_stress_level, stress_duration_minutes, rest_stress_duration_min, low_stress_duration_min, medium_stress_duration_min, high_stress_duration_min, stress_qualifier, body_battery_charged, body_battery_drained, body_battery_highest, body_battery_lowest, body_battery_most_recent, avg_spo2, lowest_spo2, avg_waking_respiration, highest_respiration, lowest_respiration, moderate_intensity_minutes, vigorous_intensity_minutes, intensity_minutes_goal, highly_active_seconds, active_seconds, sedentary_seconds, sleeping_seconds, abnormal_hr_count, min_avg_heart_rate, max_avg_heart_rate, source, synced_at";
const GARMIN_SLEEP_COLS =
  "ts, calendar_date, sleep_id, sleep_start, sleep_end, sleep_duration_seconds, unmeasurable_seconds, deep_sleep_seconds, light_sleep_seconds, rem_sleep_seconds, awake_seconds, overall_sleep_score, quality_score, duration_score, recovery_score, rem_score, light_score, deep_score, restlessness_score, avg_sleep_heart_rate, avg_respiration_rate, avg_spo2, lowest_spo2, avg_hrv, hrv_status, avg_sleep_stress, sleep_need_seconds, sleep_debt_seconds, is_nap, auto_detected, sleep_result_type, source, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source";
const GARMIN_HR_COLS =
  "ts, calendar_date, resting_heart_rate, min_heart_rate, max_heart_rate, last_seven_days_avg_rhr, zone_1_seconds, zone_2_seconds, zone_3_seconds, zone_4_seconds, zone_5_seconds, source, synced_at";
const GARMIN_HRV_COLS =
  "ts, calendar_date, weekly_avg_ms, last_night_avg_ms, last_night_5min_high_ms, baseline_low_upper_ms, baseline_balanced_low_ms, baseline_balanced_upper_ms, baseline_marker_upper_ms, hrv_status, start_timestamp, end_timestamp, create_timestamp, source, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source";
// garmin_activities: scalars + ONLY the raw_json subfield the UI reads
// (raw_json->workoutId pairs an execution with its planned-workout targets).
const GARMIN_ACTIVITY_COLS =
  "ts, activity_id, activity_type, activity_type_id, activity_name, sport_type, start_time_local, start_time_gmt, duration_seconds, elapsed_duration_seconds, moving_duration_seconds, distance_meters, avg_speed_mps, max_speed_mps, avg_heart_rate, max_heart_rate, avg_running_cadence, max_running_cadence, avg_pace_min_per_km, avg_cycling_cadence, max_cycling_cadence, avg_power_watts, max_power_watts, normalized_power, elevation_gain_meters, elevation_loss_meters, min_elevation_meters, max_elevation_meters, calories, avg_stress, aerobic_training_effect, anaerobic_training_effect, training_effect_label, training_load, vo2_max, avg_temperature_c, max_temperature_c, min_temperature_c, start_latitude, start_longitude, performance_condition, total_sets, total_reps, avg_strokes_per_length, pool_length_meters, total_lengths, manual_activity, has_splits, has_polyline, source, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source, is_excluded, split_label, split_labels, muscle_groups, planned_workout_id:raw_json->workoutId";
const GARMIN_STRESS_COLS =
  "ts, calendar_date, overall_stress_level, rest_stress_duration_sec, low_stress_duration_sec, medium_stress_duration_sec, high_stress_duration_sec, stress_qualifier, source, synced_at";
const GARMIN_TRAINING_COLS =
  "ts, calendar_date, training_readiness_score, training_readiness_level, sleep_score_factor, recovery_time_factor, hrv_factor, sleep_history_factor, stress_history_factor, training_load_factor, training_status, training_status_message, acute_training_load, chronic_training_load, training_load_balance, vo2_max_running, vo2_max_cycling, fitness_age, recovery_time_hours, recovery_heart_rate, source, synced_at";
const EIGHT_SLEEP_TRENDS_COLS =
  "calendar_date, bed_side, sleep_score, sleep_fitness_score, sleep_quality_score, sleep_duration_score, latency_asleep_score, latency_out_score, wakeup_consistency_score, sleep_routine_score, avg_heart_rate, avg_hrv, avg_breath_rate, median_bed_temp, median_room_temp, time_slept_seconds, awake_seconds, light_sleep_seconds, deep_sleep_seconds, rem_sleep_seconds, toss_and_turns, session_date, synced_at, latency_asleep_seconds, snore_duration_seconds, heavy_snore_duration_seconds, time_slept_main_session_seconds, awake_main_session_seconds, light_sleep_main_session_seconds, deep_sleep_main_session_seconds, rem_sleep_main_session_seconds, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source";

export async function getDailySummaries(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("garmin_daily_summary")
    .select(GARMIN_DAILY_COLS)
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;

  // TDEE guard: CLAUDE.md is explicit that WHOOP `kilojoule / 4.184` is the
  // canonical "calories burnt" — Garmin's `total_kilocalories` must not be
  // substituted. Rename on the way out so any chart that destructures
  // `total_kilocalories` as TDEE silently breaks instead of silently
  // misreporting. Use getWhoopCaloriesBurnt() in queries.ts for TDEE.
  return (data ?? []).map((row) => {
    if (row && typeof row === "object" && "total_kilocalories" in row) {
      const { total_kilocalories, ...rest } = row as Record<string, unknown>;
      return { ...rest, garmin_total_kcal_NOT_TDEE: total_kilocalories };
    }
    return row;
  });
}

export async function getSleepData(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // ADR-0001 Phase 3: sleep is "the night of behavior X", so filter on
  // onyx_behavioral_date (bedtime-day) rather than garmin's watch-local
  // calendar_date. The two diverge on pre-midnight bedtimes and TZ shifts.
  // Each row still carries calendar_date for any display that wants the
  // watch's labeling.
  const { data, error } = await supabase
    .from("garmin_sleep")
    .select(GARMIN_SLEEP_COLS)
    .gte("onyx_behavioral_date", since.toISOString().split("T")[0])
    .order("onyx_behavioral_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getHeartRateData(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("garmin_heart_rate")
    .select(GARMIN_HR_COLS)
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getHrvData(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("garmin_hrv")
    .select(GARMIN_HRV_COLS)
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getActivities(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Audit P1 fix (3-of-3 consensus): filter/sort by start_time_gmt (true UTC)
  // instead of start_time_local. Garmin stores start_time_local as wall-clock
  // labeled +00 — comparing it against a true-UTC since cutoff produces
  // off-by-TZ-offset boundaries. Display can still use start_time_local for
  // wall-clock rendering; the API contract here is "activities in the last N
  // calendar days UTC", which start_time_gmt provides cleanly.
  const { data, error } = await supabase
    .from("garmin_activities")
    .select(GARMIN_ACTIVITY_COLS)
    .gte("start_time_gmt", since.toISOString())
    .eq("is_excluded", false)
    .order("start_time_gmt", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function getWorkouts() {
  const { data, error } = await supabase
    .from("garmin_workouts")
    .select("workout_id,workout_name,interval_target_pace_low_mps,interval_target_pace_high_mps");

  if (error) throw error;
  return data ?? [];
}

export async function getStressData(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("garmin_stress")
    .select(GARMIN_STRESS_COLS)
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getTrainingStatus(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("garmin_training_status")
    .select(GARMIN_TRAINING_COLS)
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// WHOOP
// ---------------------------------------------------------------------------

// Explicit column lists = every scalar column EXCEPT raw_json. The WHOOP
// tables carry the full API response as jsonb (whoop_cycles is 42 MB for
// ~600 rows — ~70 kB/row, ~99% of it raw_json), so select("*") shipped
// megabytes per page load that no chart reads. "All scalars" rather than a
// minimal per-consumer list so future chart additions don't silently get
// undefined; if the ETL adds a new scalar column, append it here too.
const WHOOP_CYCLE_COLS =
  "cycle_id, user_id, created_at, updated_at, start_time, end_time, timezone_offset, score_state, strain, kilojoule, average_heart_rate, max_heart_rate, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source, onyx_is_transition_day";
const WHOOP_RECOVERY_COLS =
  "cycle_id, sleep_id, user_id, created_at, updated_at, score_state, recovery_score, resting_heart_rate, hrv_rmssd_milli, spo2_percentage, skin_temp_celsius, user_calibrating, synced_at";
const WHOOP_SLEEP_COLS =
  "sleep_id, cycle_id, user_id, created_at, updated_at, start_time, end_time, timezone_offset, is_nap, score_state, total_in_bed_time_milli, total_awake_time_milli, total_no_data_time_milli, total_light_sleep_time_milli, total_slow_wave_sleep_time_milli, total_rem_sleep_time_milli, sleep_cycle_count, disturbance_count, baseline_milli, need_from_sleep_debt_milli, need_from_recent_strain_milli, need_from_recent_nap_milli, respiratory_rate, sleep_performance_percentage, sleep_consistency_percentage, sleep_efficiency_percentage, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source";
const WHOOP_WORKOUT_COLS =
  "workout_id, user_id, created_at, updated_at, start_time, end_time, timezone_offset, sport_id, sport_name, score_state, strain, average_heart_rate, max_heart_rate, kilojoule, percent_recorded, distance_meter, altitude_gain_meter, altitude_change_meter, zone_zero_milli, zone_one_milli, zone_two_milli, zone_three_milli, zone_four_milli, zone_five_milli, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source, is_excluded, split_label, split_labels, muscle_groups";

export async function getWhoopCycles(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("whoop_cycles")
    .select(WHOOP_CYCLE_COLS)
    .gte("start_time", since.toISOString())
    .order("start_time", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getWhoopRecovery(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("whoop_recovery")
    .select(WHOOP_RECOVERY_COLS)
    .gte("created_at", since.toISOString())
    .eq("score_state", "SCORED")
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getWhoopSleep(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("whoop_sleep")
    .select(WHOOP_SLEEP_COLS)
    .gte("start_time", since.toISOString())
    .eq("is_nap", false)
    .eq("score_state", "SCORED")
    .order("start_time", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// Same as getWhoopSleep but INCLUDES naps. Used for Sleep Debt chart so
// nap-only days (travel, jet lag) still surface the WHOOP-recorded debt value.
export async function getWhoopSleepAll(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("whoop_sleep")
    .select(WHOOP_SLEEP_COLS)
    .gte("start_time", since.toISOString())
    .eq("score_state", "SCORED")
    .order("start_time", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getWhoopWorkouts(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("whoop_workouts")
    .select(WHOOP_WORKOUT_COLS)
    .gte("start_time", since.toISOString())
    .eq("is_excluded", false)
    .order("start_time", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

// Workout-to-sleep gap chart data (added 2026-04-16). Joins each WHOOP sleep
// onset to the latest workout (WHOOP or Garmin) ending within 18h before it,
// and pairs the gap with the HRV scored from that sleep so we can see whether
// late-evening exercise depresses next-morning HRV.
export interface WorkoutSleepGap {
  pred_date: string;
  sleep_onset_utc: string;
  last_workout_end_utc: string | null;
  gap_minutes: number | null;
  whoop_strain: number | null;
  next_morning_hrv: number | null;
}

export async function getWorkoutSleepGap(days: number = 60): Promise<WorkoutSleepGap[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceISO = since.toISOString();
  // Perf round 3: the recovery sub-query was unbounded (all-time, growing —
  // ~589 rows today) and would silently truncate at PostgREST's 1000-row cap.
  // Bound it on created_at like getWhoopRecovery, padded a few days before
  // sinceISO to cover scoring lag. Semantics preserved: the recovery map is
  // only consulted for sleeps already window-filtered.
  const recSince = new Date(since);
  recSince.setDate(recSince.getDate() - 3);
  const recSinceISO = recSince.toISOString();

  // Fetch WHOOP sleep starts + cycles + recovery + workouts, plus Garmin
  // activities. Compute the join client-side so we don't add a server view
  // for a single chart.
  const [sleepRes, cyclesRes, recRes, wkRes, gactRes] = await Promise.all([
    supabase.from("whoop_sleep").select("cycle_id,start_time")
      .eq("is_nap", false).eq("score_state", "SCORED")
      .gte("start_time", sinceISO).order("start_time", { ascending: true }),
    supabase.from("whoop_cycles").select("cycle_id,start_time").gte("start_time", sinceISO),
    supabase.from("whoop_recovery").select("cycle_id,hrv_rmssd_milli")
      .eq("score_state", "SCORED").gte("created_at", recSinceISO),
    supabase.from("whoop_workouts").select("end_time,strain")
      .eq("score_state", "SCORED").eq("is_excluded", false).gte("end_time", sinceISO),
    supabase.from("garmin_activities").select("start_time_gmt,duration_seconds,training_load")
      .eq("is_excluded", false).gte("start_time_gmt", sinceISO),
  ]);

  if (sleepRes.error) throw sleepRes.error;
  const sleeps = (sleepRes.data ?? []).filter((s) => s.start_time);
  const cycleHrv = new Map<number, number>();
  for (const r of recRes.data ?? []) {
    if (r.hrv_rmssd_milli != null) cycleHrv.set(r.cycle_id as number, Number(r.hrv_rmssd_milli));
  }
  const cycleStartByCycle = new Map<number, string>();
  for (const c of cyclesRes.data ?? []) cycleStartByCycle.set(c.cycle_id as number, c.start_time as string);

  // Combined workout list with end-time and source-tagged strain
  type W = { end: number; whoop_strain: number | null };
  const workouts: W[] = [];
  for (const w of wkRes.data ?? []) {
    if (w.end_time) workouts.push({
      end: new Date(w.end_time as string).getTime(),
      whoop_strain: w.strain != null ? Number(w.strain) : null,
    });
  }
  for (const g of gactRes.data ?? []) {
    if (g.start_time_gmt && g.duration_seconds != null) {
      const start = new Date(g.start_time_gmt as string).getTime();
      const end = start + Number(g.duration_seconds) * 1000;
      workouts.push({ end, whoop_strain: null });
    }
  }
  workouts.sort((a, b) => a.end - b.end);

  const out: WorkoutSleepGap[] = [];
  for (const s of sleeps) {
    const sleepMs = new Date(s.start_time as string).getTime();
    // Binary-search-ish: find the latest workout with end <= sleepMs
    let last: W | null = null;
    for (let i = workouts.length - 1; i >= 0; i--) {
      if (workouts[i].end <= sleepMs && sleepMs - workouts[i].end <= WORKOUT_SLEEP_GAP_MAX_MS) {
        last = workouts[i]; break;
      }
      if (workouts[i].end < sleepMs - WORKOUT_SLEEP_GAP_MAX_MS) break;
    }
    // pred_date = behavioral date (day the workout/strain "belongs to" for the
    // following sleep). Use whoopSleepDay() — `(cycle_start − 6h)::ET date` —
    // matching the canonical pipeline attribution (ADR-0001, see CLAUDE.md
    // behavioral-day rule). The previous naive (cycle_start − 24h) math pushed
    // pre-midnight bedtimes back TWO calendar days instead of one, mis-pairing
    // workouts with the wrong day's sleep on every pre-midnight night.
    const cycleStart = cycleStartByCycle.get(s.cycle_id as number);
    const cycleStartISO = cycleStart ?? (s.start_time as string);
    const predDate = whoopSleepDay(cycleStartISO);
    out.push({
      pred_date: predDate,
      sleep_onset_utc: s.start_time as string,
      last_workout_end_utc: last ? new Date(last.end).toISOString() : null,
      gap_minutes: last ? (sleepMs - last.end) / 60000 : null,
      whoop_strain: last?.whoop_strain ?? null,
      next_morning_hrv: cycleHrv.get(s.cycle_id as number) ?? null,
    });
  }
  return out;
}

export async function getWhoopJournal(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // 2026-06-11 merge: WHOOP journal history + ongoing WHOOP-derived habit
  // logs live in pds.habit_journal, exposed through the pds.journal view.
  // source='whoop' selects exactly the WHOOP-question variable family
  // (historical export rows AND new habit-channel taps for those questions).
  // Ordered DESCENDING so PostgREST's 1000-row cap drops the OLDEST rows at
  // large ranges (365d ≈ 3.9k rows), then re-sorted ascending for consumers.
  // Perf round 3: explicit column list — consumers (/sleep heatmap, /whoop)
  // read only these five fields; select("*") shipped ~179 kB for 30d. The
  // secondary .order("question") makes within-day row order deterministic,
  // which is load-bearing: the silent revalidation's sameJson guard compares
  // serialized state, so nondeterministic ordering would defeat the bailout.
  const { data, error } = await supabase
    .from("journal")
    .select("cycle_date, behaviors_date, question, category, answer")
    .eq("source", "whoop")
    .gte("cycle_date", since.toISOString().split("T")[0])
    .order("cycle_date", { ascending: false })
    .order("question");

  if (error) throw error;
  return (data ?? []).reverse();
}

// ---------------------------------------------------------------------------
// Eight Sleep
// ---------------------------------------------------------------------------

export async function getEightSleepTrends(days: number = 30, side: string = "left") {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // ADR-0001 Phase 3: filter on the canonical behavioral date (bedtime-day)
  // rather than Eight Sleep's session date. These usually match but diverge
  // on pre-midnight bedtimes and TZ-shift days. The /sleep page still
  // formats display labels off the row's own calendar_date.
  const { data, error } = await supabase
    .from("eight_sleep_trends")
    .select(EIGHT_SLEEP_TRENDS_COLS)
    .eq("bed_side", side)
    .gte("onyx_behavioral_date", since.toISOString().split("T")[0])
    .order("onyx_behavioral_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Nutrition (Cronometer → MFP COALESCE; cutover 2026-05-31)
// ---------------------------------------------------------------------------

/**
 * Daily macros, COALESCE'd Cronometer-over-MFP via the behavioral matrix's
 * nutrition_* columns. Aliased back to the legacy macro keys (calories,
 * protein_g, …) so existing chart consumers are drop-in. `nutrition_source`
 * carries provenance ('cronometer' | 'mfp') per day. Reads only days that have
 * nutrition logged (nutrition_calories not null).
 */
export async function getNutrition(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Matview read (15-min refresh): Cronometer data lands via the manual local
  // importer, not in-app writes, so the only staleness case is opening
  // /nutrition within ~15 min of running an import. (The Today's Meals widget
  // reads the LIVE cronometer_servings table and stays instant.)
  const { data, error } = await supabase
    .from("daily_health_matrix_behavioral_mat")
    .select(
      "calendar_date, nutrition_source, " +
        "calories:nutrition_calories, protein_g:nutrition_protein_g, " +
        "carbs_g:nutrition_carbs_g, fat_g:nutrition_fat_g, fiber_g:nutrition_fiber_g, " +
        "sugar_g:nutrition_sugar_g, sodium_mg:nutrition_sodium_mg, water_ml:nutrition_water_ml"
    )
    .gte("calendar_date", since.toISOString().split("T")[0])
    .not("nutrition_calories", "is", null)
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Raw pre-cutover MFP rows, untouched, for a future "historical archive" view.
 * Reads pds.myfitnesspal_nutrition directly (NOT the COALESCE'd matrix).
 */
export async function getMfpNutritionHistorical(days: number = 365) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("myfitnesspal_nutrition")
    .select("*")
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Per-entry Cronometer food log (newest first). Optional `date` (ET behavioral
 * day, YYYY-MM-DD) narrows to a single day for the "Today's meals" widget.
 * The single-day filter keys on onyx_behavioral_date (not the diary calendar
 * day) so a post-midnight pre-bed entry shows under the behavioral day it
 * belongs to — matching the matrix / HRV attribution.
 */
export async function getCronometerServings(days: number = 14, date?: string) {
  let q = supabase
    .from("cronometer_servings")
    .select(
      "serving_id, calendar_date, onyx_behavioral_date, event_time, food_name, " +
        "amount_raw, unit, meal_group, food_category, calories, protein_g, carbs_g, fat_g"
    )
    .order("calendar_date", { ascending: false })
    .order("serving_id", { ascending: false });

  if (date) {
    q = q.eq("onyx_behavioral_date", date);
  } else {
    const since = new Date();
    since.setDate(since.getDate() - days);
    q = q.gte("calendar_date", since.toISOString().split("T")[0]);
  }

  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/**
 * Unified dietary (Cronometer) + supplemental (Onyx UNII rollup) + total
 * micronutrient intake per behavioral day, from pds.daily_micronutrient_totals.
 * Powers the "Vitamins & Minerals" card group with the dietary-vs-supplement split.
 */
export async function getDailyVitamins(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("daily_micronutrient_totals")
    .select("*")
    .gte("onyx_behavioral_date", since.toISOString().split("T")[0])
    .order("onyx_behavioral_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * The FULL Cronometer daily nutrient set (all ~62 columns incl. amino acids and
 * fat fractions) for the "All tracked nutrients" table. Dietary-only (no
 * supplement merge) — use getDailyVitamins for the dietary+supplement split.
 * Reads the behavioral-day rollup (servings summed by onyx_behavioral_date) so
 * post-midnight pre-bed meals count toward the day they behaviorally belong to.
 */
export async function getDailyNutrientsFull(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("cronometer_nutrition_behavioral_daily")
    .select("*")
    .gte("onyx_behavioral_date", since.toISOString().split("T")[0])
    .order("onyx_behavioral_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * WHOOP daily energy expenditure ("calories burnt") for the same window.
 *
 * Source of record on Onyx — NOT Garmin. Reads `pds.whoop_cycles.kilojoule`
 * and converts to kcal via /4.184. Each cycle is tagged to its ET cycle date
 * via the +12h rule (a bedtime-start cycle lands on the wake day), matching
 * the canonical timezone convention in CLAUDE.md.
 */
export async function getWhoopCaloriesBurnt(days: number = 30) {
  const since = new Date();
  // Pad by 1 day so the boundary cycle (whose start might be the night before
  // the requested window) is included before we re-tag to its ET cycle date.
  since.setDate(since.getDate() - (days + 1));

  const { data, error } = await supabase
    .from("whoop_cycles")
    .select("cycle_id, start_time, kilojoule")
    .gte("start_time", since.toISOString())
    .order("start_time", { ascending: true });

  if (error) throw error;

  const byDate = new Map<
    string,
    { calendar_date: string; kilojoule: number; calories_burnt: number; kcal_exact: number }
  >();
  for (const c of data ?? []) {
    if (!c.start_time || c.kilojoule == null) continue;
    const start = new Date(c.start_time);
    const midday = new Date(start.getTime() + 12 * 3600 * 1000);
    const calendar_date = midday.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const kj = Number(c.kilojoule);
    // Re-audit 2026-06-07 (units/deepseek/F-005): the `kilojoule == null` check
    // above doesn't catch a non-numeric string (e.g. ""), which Number() turns
    // into NaN and would poison kcal_exact / averages downstream. Skip it.
    if (isNaN(kj)) continue;
    const kcalExact = kjToKcal(kj);
    // `kcal_exact` carries precision for downstream weekly/monthly averaging;
    // `calories_burnt` keeps the rounded value for backwards-compat with
    // existing chart consumers.
    // Ascending order means last-write-wins picks the later cycle on the rare
    // day with two; in practice there's one cycle per ET date.
    // Re-audit 2026-06-07 (units/deepseek/F-006): surface the rare two-cycles-on-
    // one-ET-date case so a silent overwrite is at least observable. Selection
    // logic (last-write-wins, later cycle) is unchanged.
    if (byDate.has(calendar_date)) {
      console.warn(
        `getWhoopCaloriesBurnt: two WHOOP cycles map to ${calendar_date}; ` +
          `overwriting cycle ${byDate.get(calendar_date)?.kilojoule}kJ with ${kj}kJ (last-write-wins).`,
      );
    }
    byDate.set(calendar_date, {
      calendar_date,
      kilojoule: kj,
      calories_burnt: Math.round(kcalExact),
      kcal_exact: kcalExact,
    });
  }
  return Array.from(byDate.values()).sort((a, b) => (a.calendar_date < b.calendar_date ? -1 : 1));
}


// ---------------------------------------------------------------------------
// Caffeine (pds.caffeine_timing_daily + behavioral matrix)
// ---------------------------------------------------------------------------

export interface CaffeineDailyRow {
  calendar_date: string;
  /** ET decimal hours; from trusted-timestamp events only (null if none). */
  first_caffeine_hour: number | null;
  last_caffeine_hour: number | null;
  /** Null on single-dose days (no window to measure). */
  caffeine_window_hours: number | null;
  /** ALL events, both channels (timed or not). */
  caffeine_intake_count: number | null;
  last_caffeine_to_bedtime_minutes: number | null;
  total_caffeine_mg: number | null;
  dietary_caffeine_mg: number | null;
  supplement_caffeine_mg: number | null;
  /** 5h half-life residual at sleep onset; NULL unless every event that day had a trusted timestamp. */
  caffeine_mg_at_bedtime: number | null;
  timed_event_count: number | null;
}

/**
 * One row per behavioral day with caffeine, from pds.caffeine_timing_daily.
 * Timing fields (first/last hour, window, bedtime gap, mg-at-bedtime) come from
 * trusted-timestamp events only; mg totals and intake_count cover all events.
 */
export async function getCaffeineDaily(days: number = 60): Promise<CaffeineDailyRow[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("caffeine_timing_daily")
    .select(
      "calendar_date,first_caffeine_hour,last_caffeine_hour,caffeine_window_hours,caffeine_intake_count,last_caffeine_to_bedtime_minutes,total_caffeine_mg,dietary_caffeine_mg,supplement_caffeine_mg,caffeine_mg_at_bedtime,timed_event_count"
    )
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return (data ?? []) as CaffeineDailyRow[];
}

export interface CaffeineHrvPair {
  calendar_date: string;
  caffeine_total_mg: number;
  caffeine_to_bedtime_min: number | null;
  whoop_hrv_rmssd: number;
}

/**
 * Caffeine (behavioral day N) paired with the recovery of the WHOOP cycle that
 * STARTS at the bedtime closing day N — i.e. the same-row whoop_hrv_rmssd is
 * the NEXT-NIGHT HRV relative to that day's caffeine (see CLAUDE.md matrix
 * semantics). Same-row pairing IS the correct "caffeine day → following
 * night's HRV" comparison; label it "next-night HRV" in any UI. Only rows
 * where both sides are non-null.
 */
export async function getCaffeineHrvPairs(days: number = 90): Promise<CaffeineHrvPair[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    // Matview read (15-min refresh): the whoop_hrv_rmssd NOT NULL filter
    // already excludes today's row until tomorrow's ETL scores the night, so
    // matview staleness is invisible here even though caffeine columns are
    // write-coupled. (The /caffeine KPI tiles read the LIVE caffeine views.)
    .from("daily_health_matrix_behavioral_mat")
    .select("calendar_date,caffeine_total_mg,caffeine_to_bedtime_min,whoop_hrv_rmssd")
    .gte("onyx_behavioral_date", since.toISOString().split("T")[0])
    .not("caffeine_total_mg", "is", null)
    .not("whoop_hrv_rmssd", "is", null)
    .order("onyx_behavioral_date", { ascending: true });

  if (error) throw error;
  return (data ?? []) as CaffeineHrvPair[];
}

export interface CaffeineQualityFlag {
  behavioral_date: string;
  // Journal-comparison flags removed 2026-06-10 — the WHOOP caffeine checkbox
  // is disregarded by policy; the logged record is the only caffeine source.
  flag: "untrusted_timestamps" | "possible_double_log" | string;
  detail: string;
}

/**
 * QA flags for the caffeine record from pds.caffeine_data_quality — days where
 * retro-logged timestamps were quarantined, or a dietary serving name-matches
 * a same-day supplement (possible double-count). Long format, one row per
 * (day, flag).
 */
export async function getCaffeineDataQuality(days: number = 45): Promise<CaffeineQualityFlag[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("caffeine_data_quality")
    .select("behavioral_date,flag,detail")
    .gte("behavioral_date", since.toISOString().split("T")[0])
    .order("behavioral_date", { ascending: false });

  if (error) throw error;
  return (data ?? []) as CaffeineQualityFlag[];
}

// ---------------------------------------------------------------------------
// Recovery context for running activities (merged into /activities row cards)
// ---------------------------------------------------------------------------

export async function getRunningRecoveryContext(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Matview read (15-min refresh, 2026-06-11): is_excluded toggles reach this
  // recovery overlay at the next refresh (the activity list itself reads base
  // tables live, so exclusions disappear from the list immediately).
  const { data, error } = await supabase
    .from("recovery_vs_pace_mat")
    .select("activity_id, whoop_recovery, whoop_hrv_rmssd_ms, whoop_sleep_performance, pace_delta_pct, segment_targets, segment_target_count")
    .gte("activity_date", since.toISOString().split("T")[0]);

  if (error) throw error;
  return data ?? [];
}

export async function getActivityLaps(activityIds: number[]) {
  if (activityIds.length === 0) return [];

  const { data, error } = await supabase
    .from("garmin_activity_laps")
    .select("activity_id, lap_index, distance_meters, duration_seconds, avg_speed_mps, avg_heart_rate, intensity, wkt_step_index, wkt_index")
    .in("activity_id", activityIds)
    .order("activity_id", { ascending: true })
    .order("lap_index", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Unified Health Matrix view
// ---------------------------------------------------------------------------

// Columns the Bland-Altman device-comparison page actually plots (+ both date
// keys). The matrix has 200+ columns at ~5 kB/row serialized — select("*")
// cost ~170 kB for 30d and ~4.8 MB at the ALL range. The eight_sleep_*_main_*
// columns are the MAIN-SESSION values (nap-inclusion convention: cross-device
// comparison must exclude naps); they were appended to the view 2026-06-11 —
// before that the page referenced them against select("*") and silently got
// undefined, leaving three Eight Sleep comparisons empty.
const HEALTH_MATRIX_COLS =
  "calendar_date, onyx_behavioral_date, garmin_sleep_score, whoop_sleep_performance, eight_sleep_score, garmin_hrv_last_night, whoop_hrv_rmssd, eight_sleep_hrv, garmin_rhr, whoop_rhr, eight_sleep_hr, garmin_sleep_respiration, whoop_respiratory_rate, eight_sleep_breath_rate, garmin_sleep_duration_sec, whoop_sleep_duration_milli, eight_sleep_duration_main_sec, garmin_deep_sleep_sec, whoop_deep_sleep_milli, eight_sleep_deep_main_sec, garmin_rem_sleep_sec, whoop_rem_sleep_milli, eight_sleep_rem_main_sec";

export async function getHealthMatrix(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  // ADR-0001 Phase 3: filter/order by onyx_behavioral_date so the window and
  // ordering use the bedtime-day attribution the HRV pipeline assumes.
  // Reads the 15-min-refreshed matview (perf migration 2026-06-11), not the
  // live view — this page is pure ETL history, staleness is invisible.
  // Paged via .range(): the matrix is at 850+ rows (one/day) and the ALL
  // range would silently truncate at PostgREST's 1000-row cap in ~5 months.
  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let fromIdx = 0; ; fromIdx += PAGE) {
    const { data, error } = await supabase
      .from("daily_health_matrix_behavioral_mat")
      .select(HEALTH_MATRIX_COLS)
      .gte("onyx_behavioral_date", sinceStr)
      .order("onyx_behavioral_date", { ascending: true })
      .range(fromIdx, fromIdx + PAGE - 1);

    if (error) throw error;
    rows.push(...((data ?? []) as Record<string, unknown>[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Habits (stored in habit_journal, same schema as whoop_journal)
// ---------------------------------------------------------------------------

export async function getHabitJournal(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Post-merge (2026-06-11) habit_journal also holds the 12k-row frozen WHOOP
  // journal history (source='whoop', explicit Yes/No answers). Tri-state UI
  // (2026-06-11): fetch BOTH Yes and No rows — the page renders explicit No
  // distinctly from "not logged" (row absence = null). Explicit columns,
  // paged via .range() — an unpaged select would silently truncate at
  // PostgREST's 1000-row cap (365d of merged rows is well past it) and,
  // ordered ascending, drop the most RECENT completions first. The first
  // request carries count:"exact" so the remaining pages are known up front
  // and fetched in PARALLEL — 365d is ~9-10 pages, and serial paging cost
  // ~1-3s of stacked roundtrips on /habits load.
  type HabitJournalRow = {
    cycle_date: string;
    question: string;
    category: string | null;
    answer: string | null;
    notes: string | null;
  };
  const PAGE = 1000;
  const sinceStr = since.toISOString().split("T")[0];
  const pageQuery = (fromIdx: number, withCount: boolean) =>
    supabase
      .from("habit_journal")
      .select("cycle_date,question,category,answer,notes", withCount ? { count: "exact" } : undefined)
      .in("answer", ["Yes", "No"])
      .gte("cycle_date", sinceStr)
      .order("cycle_date", { ascending: true })
      .range(fromIdx, fromIdx + PAGE - 1);

  const { data: first, error, count } = await pageQuery(0, true);
  if (error) throw error;
  const rows: HabitJournalRow[] = [...((first ?? []) as HabitJournalRow[])];

  const total = count ?? rows.length;
  if (total > PAGE) {
    const restIdx = Array.from({ length: Math.ceil(total / PAGE) - 1 }, (_, i) => (i + 1) * PAGE);
    const rest = await Promise.all(restIdx.map((fromIdx) => pageQuery(fromIdx, false)));
    for (const { data, error: pageErr } of rest) {
      if (pageErr) throw pageErr;
      rows.push(...((data ?? []) as HabitJournalRow[]));
    }
  }
  return rows;
}

export interface HabitMetadataInterval {
  notion_page_id: string;
  valid_from: string;   // YYYY-MM-DD
  valid_to: string | null;   // YYYY-MM-DD or null = open interval
  frequency: string;
  category: string | null;
}

export async function getHabitMetadataHistory(): Promise<HabitMetadataInterval[]> {
  const { data, error } = await supabase
    .from("habit_metadata_history")
    .select("notion_page_id,valid_from,valid_to,frequency,category")
    .order("notion_page_id")
    .order("valid_from", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Unified Journal (WHOOP + Habits via view)
// ---------------------------------------------------------------------------

export async function getJournal(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("journal")
    .select("*")
    .gte("cycle_date", since.toISOString().split("T")[0])
    .order("cycle_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Spotify (separate domain — no joins to health tables; see CLAUDE.md)
// ---------------------------------------------------------------------------

export interface SpotifyPlayRow {
  played_at: string;
  played_date_et: string;
  track_id: string;
  track_name: string | null;
  artist_id: string | null;
  artist_name: string | null;
  duration_ms: number | null;
}

export interface SpotifyDailySignatureRow {
  calendar_date: string;
  play_count: number;
  unique_tracks: number;
  unique_artists: number;
  total_minutes: number | null;
  avg_valence: number | null;
  avg_energy: number | null;
  avg_tempo: number | null;
  avg_danceability: number | null;
  avg_acousticness: number | null;
  avg_instrumentalness: number | null;
  avg_liveness: number | null;
  avg_speechiness: number | null;
  featurized_plays: number;
}

function dateNDaysAgo(days: number): string {
  const since = new Date();
  since.setDate(since.getDate() - days);
  return since.toISOString().split("T")[0];
}

export type Range = "all" | "1d" | "7d" | "30d" | "60d" | "90d" | "365d";

/** @deprecated Use Range. Kept as an alias for older Spotify-specific call sites. */
export type SpotifyRange = Range;

const ALL_TIME_DAYS = 36500;

export function rangeToDays(range: Range): number | null {
  switch (range) {
    case "all": return null;
    case "1d": return 1;
    case "7d": return 7;
    case "30d": return 30;
    case "60d": return 60;
    case "90d": return 90;
    case "365d": return 365;
  }
}

/** Like rangeToDays but maps "all" to a very large window so it can feed `days: number` query signatures. */
export function rangeDays(range: Range): number {
  return rangeToDays(range) ?? ALL_TIME_DAYS;
}

export function rangeLabel(range: Range): string {
  switch (range) {
    case "all": return "all time";
    case "1d": return "last 24h";
    case "7d": return "last 7 days";
    case "30d": return "last 30 days";
    case "60d": return "last 60 days";
    case "90d": return "last 90 days";
    case "365d": return "last year";
  }
}

function sinceFor(range: Range): string | null {
  const days = rangeToDays(range);
  return days == null ? null : dateNDaysAgo(days);
}

// ---------------------------------------------------------------------------
// Shared Spotify fetch layer (perf pass 2026-06-10).
//
// The /spotify dashboard previously fired ~8 independent scans of
// spotify_plays (one per aggregate), each silently capped at PostgREST's
// 1000-row default, plus two separate sequential chunk-loops over
// spotify_artists. Everything below fetches each dataset ONCE — plays are
// paged past the 1000-row cap with the pages requested in parallel — and the
// aggregates are computed from the shared rows by pure functions. The
// per-aggregate exports (getSpotifyKpis, getSpotifyTopArtists, …) keep their
// signatures and return shapes as thin wrappers; getSpotifyDashboard() is the
// one-call path the page uses.
// ---------------------------------------------------------------------------

interface SpotifyPlayFull {
  played_at: string;
  played_date_et: string;
  track_id: string | null;
  track_name: string | null;
  artist_id: string | null;
  artist_name: string | null;
  duration_ms: number | null;
}

const SPOTIFY_PAGE_SIZE = 1000;
const SPOTIFY_CHUNK = 200;

/** All plays in range (chronological), paged past the 1000-row PostgREST cap. */
async function fetchSpotifyPlays(range: SpotifyRange): Promise<SpotifyPlayFull[]> {
  const since = sinceFor(range);
  let countQ = supabase
    .from("spotify_plays")
    .select("played_at", { count: "exact", head: true });
  if (since) countQ = countQ.gte("played_date_et", since);
  const { count, error: countErr } = await countQ;
  if (countErr) throw countErr;
  const total = count ?? 0;
  if (total === 0) return [];

  const pages = Math.ceil(total / SPOTIFY_PAGE_SIZE);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      let q = supabase
        .from("spotify_plays")
        .select("played_at,played_date_et,track_id,track_name,artist_id,artist_name,duration_ms")
        .order("played_at", { ascending: true })
        .range(i * SPOTIFY_PAGE_SIZE, (i + 1) * SPOTIFY_PAGE_SIZE - 1);
      if (since) q = q.gte("played_date_et", since);
      return q;
    })
  );
  const rows: SpotifyPlayFull[] = [];
  for (const r of results) {
    if (r.error) throw r.error;
    rows.push(...((r.data ?? []) as SpotifyPlayFull[]));
  }
  return rows;
}

/** Genres per artist_id, chunked .in() requests fired in parallel. */
async function fetchArtistGenres(artistIds: string[]): Promise<Map<string, string[]>> {
  const genresByArtist = new Map<string, string[]>();
  if (artistIds.length === 0) return genresByArtist;
  const chunks: string[][] = [];
  for (let i = 0; i < artistIds.length; i += SPOTIFY_CHUNK) {
    chunks.push(artistIds.slice(i, i + SPOTIFY_CHUNK));
  }
  const results = await Promise.all(
    chunks.map((batch) =>
      supabase.from("spotify_artists").select("artist_id,genres").in("artist_id", batch)
    )
  );
  for (const r of results) {
    if (r.error) throw r.error;
    for (const a of (r.data ?? []) as Array<{ artist_id: string; genres: string[] | null }>) {
      if (a.genres && a.genres.length > 0) genresByArtist.set(a.artist_id, a.genres);
    }
  }
  return genresByArtist;
}

interface SpotifyTrackFeatureRow {
  track_id: string;
  valence: number | null;
  energy: number | null;
  danceability: number | null;
  acousticness: number | null;
  instrumentalness: number | null;
  liveness: number | null;
  speechiness: number | null;
}

/** Audio features per track_id, chunked .in() requests fired in parallel. */
async function fetchTrackFeatures(trackIds: string[]): Promise<SpotifyTrackFeatureRow[]> {
  if (trackIds.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < trackIds.length; i += SPOTIFY_CHUNK) {
    chunks.push(trackIds.slice(i, i + SPOTIFY_CHUNK));
  }
  const results = await Promise.all(
    chunks.map((batch) =>
      supabase
        .from("spotify_tracks")
        .select("track_id,valence,energy,danceability,acousticness,instrumentalness,liveness,speechiness")
        .in("track_id", batch)
    )
  );
  const rows: SpotifyTrackFeatureRow[] = [];
  for (const r of results) {
    if (r.error) throw r.error;
    rows.push(...((r.data ?? []) as SpotifyTrackFeatureRow[]));
  }
  return rows;
}

/**
 * Every track_id played before `since` (for the discovery-rate "is this track
 * new" check). Pages fetched in parallel after a count request — the old
 * implementation paged sequentially.
 */
async function fetchPriorTrackIds(since: string | null): Promise<Set<string>> {
  const prior = new Set<string>();
  if (!since) return prior; // "all time": every first occurrence is new
  const { count, error: countErr } = await supabase
    .from("spotify_plays")
    .select("track_id", { count: "exact", head: true })
    .lt("played_date_et", since);
  if (countErr) throw countErr;
  const total = count ?? 0;
  if (total === 0) return prior;
  const pages = Math.ceil(total / SPOTIFY_PAGE_SIZE);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      supabase
        .from("spotify_plays")
        .select("track_id")
        .lt("played_date_et", since)
        .order("played_at", { ascending: true })
        .range(i * SPOTIFY_PAGE_SIZE, (i + 1) * SPOTIFY_PAGE_SIZE - 1)
    )
  );
  for (const r of results) {
    if (r.error) throw r.error;
    for (const row of r.data ?? []) if (row.track_id) prior.add(row.track_id);
  }
  return prior;
}

// --- pure aggregate computations over the shared plays rows ---

function computeSpotifyKpis(rows: SpotifyPlayFull[]) {
  const uniqueTracks = new Set(rows.map((r) => r.track_id).filter(Boolean)).size;
  const uniqueArtists = new Set(rows.map((r) => r.artist_id).filter(Boolean)).size;
  const totalMs = rows.reduce((s, r) => s + (r.duration_ms ?? 0), 0);

  // Top track of the period (by play count)
  const trackCounts = new Map<string, { name: string | null; artist: string | null; count: number }>();
  for (const r of rows) {
    if (!r.track_id) continue;
    const entry = trackCounts.get(r.track_id) ?? { name: r.track_name, artist: r.artist_name, count: 0 };
    entry.count++;
    trackCounts.set(r.track_id, entry);
  }
  let topTrack: { name: string | null; artist: string | null; count: number } | null = null;
  for (const v of trackCounts.values()) {
    if (!topTrack || v.count > topTrack.count) topTrack = v;
  }

  return {
    totalPlays: rows.length,
    totalHours: totalMs / 3_600_000,
    uniqueTracks,
    uniqueArtists,
    topTrack,
  };
}

export async function getSpotifyKpis(range: SpotifyRange = "30d") {
  return computeSpotifyKpis(await fetchSpotifyPlays(range));
}

export async function getSpotifyDailyVolume(range: SpotifyRange = "90d"): Promise<SpotifyDailySignatureRow[]> {
  // Matview read (15-min refresh, 2026-06-11): plays only ingest hourly at :50, so staleness is invisible.
  let q = supabase
    .from("spotify_daily_signature_mat")
    .select("calendar_date,play_count,unique_tracks,unique_artists,total_minutes,featurized_plays");
  const since = sinceFor(range);
  if (since) q = q.gte("calendar_date", since);
  const { data, error } = await q.order("calendar_date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as SpotifyDailySignatureRow[];
}

export async function getSpotifyAudioFeatureDrift(range: SpotifyRange = "60d"): Promise<SpotifyDailySignatureRow[]> {
  // Matview read (15-min refresh, 2026-06-11): plays only ingest hourly at :50, so staleness is invisible.
  let q = supabase
    .from("spotify_daily_signature_mat")
    .select(
      "calendar_date,avg_valence,avg_energy,avg_danceability,avg_acousticness,avg_instrumentalness,avg_liveness,avg_speechiness,featurized_plays,play_count",
    );
  const since = sinceFor(range);
  if (since) q = q.gte("calendar_date", since);
  const { data, error } = await q
    .gt("featurized_plays", 0)
    .order("calendar_date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as SpotifyDailySignatureRow[];
}

export interface SpotifyGenreRotationRow {
  calendar_date: string;
  // Open-ended: each top-N genre becomes a key plus an "other" bucket.
  [genre: string]: string | number;
}

function computeGenreRotation(
  plays: Pick<SpotifyPlayFull, "played_date_et" | "artist_id">[],
  genresByArtist: Map<string, string[]>,
  topN: number,
): { rows: SpotifyGenreRotationRow[]; topGenres: string[] } {
  if (plays.length === 0) return { rows: [], topGenres: [] };

  // First pass: compute global genre totals so we can decide top-N.
  const totals = new Map<string, number>();
  for (const p of plays) {
    if (!p.artist_id) continue;
    const gs = genresByArtist.get(p.artist_id);
    if (!gs) continue;
    for (const g of gs) totals.set(g, (totals.get(g) ?? 0) + 1);
  }
  const topGenres = Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([g]) => g);
  const topSet = new Set(topGenres);

  // Second pass: build per-date buckets.
  const byDate = new Map<string, Record<string, number>>();
  for (const p of plays) {
    const date = p.played_date_et as string;
    if (!date) continue;
    const bucket = byDate.get(date) ?? {};
    if (!p.artist_id) {
      byDate.set(date, bucket);
      continue;
    }
    const gs = genresByArtist.get(p.artist_id);
    if (!gs || gs.length === 0) {
      bucket["other"] = (bucket["other"] ?? 0) + 1;
      byDate.set(date, bucket);
      continue;
    }
    let countedTop = false;
    for (const g of gs) {
      if (topSet.has(g)) {
        bucket[g] = (bucket[g] ?? 0) + 1;
        countedTop = true;
      }
    }
    if (!countedTop) bucket["other"] = (bucket["other"] ?? 0) + 1;
    byDate.set(date, bucket);
  }

  const rows: SpotifyGenreRotationRow[] = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => {
      const row: SpotifyGenreRotationRow = { calendar_date: date };
      for (const g of topGenres) row[g] = counts[g] ?? 0;
      row["other"] = counts["other"] ?? 0;
      return row;
    });

  return { rows, topGenres };
}

export async function getSpotifyGenreRotation(
  range: SpotifyRange = "30d",
  topN: number = 8,
): Promise<{ rows: SpotifyGenreRotationRow[]; topGenres: string[] }> {
  const plays = await fetchSpotifyPlays(range);
  const artistIds = Array.from(new Set(plays.map((p) => p.artist_id).filter(Boolean) as string[]));
  const genresByArtist = await fetchArtistGenres(artistIds);
  return computeGenreRotation(plays, genresByArtist, topN);
}

export interface SpotifyDiscoveryRow {
  calendar_date: string;
  new_tracks: number;
  total_plays: number;
  pct_new: number;
}

// For each play in the range, "new" = track_id not seen in any previous play
// (across all-time, not just the range — otherwise picking a wider range would
// flip familiar tracks back to "new"). `plays` must be in chronological order.
function computeDiscoveryRate(
  plays: Pick<SpotifyPlayFull, "played_date_et" | "track_id">[],
  prior: Set<string>,
): SpotifyDiscoveryRow[] {
  const buckets = new Map<string, { new_tracks: number; total_plays: number }>();
  const seenInRange = new Set<string>();
  for (const p of plays) {
    const date = p.played_date_et as string;
    if (!date) continue;
    const b = buckets.get(date) ?? { new_tracks: 0, total_plays: 0 };
    b.total_plays += 1;
    const tid = p.track_id;
    if (tid && !prior.has(tid) && !seenInRange.has(tid)) {
      b.new_tracks += 1;
      seenInRange.add(tid);
    }
    buckets.set(date, b);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([calendar_date, b]) => ({
      calendar_date,
      new_tracks: b.new_tracks,
      total_plays: b.total_plays,
      pct_new: b.total_plays > 0 ? (b.new_tracks / b.total_plays) * 100 : 0,
    }));
}

export async function getSpotifyDiscoveryRate(
  range: SpotifyRange = "30d",
): Promise<SpotifyDiscoveryRow[]> {
  const [plays, prior] = await Promise.all([
    fetchSpotifyPlays(range),
    fetchPriorTrackIds(sinceFor(range)),
  ]);
  return computeDiscoveryRate(plays, prior);
}

function computeTopArtists(
  rows: Pick<SpotifyPlayFull, "artist_id" | "artist_name" | "duration_ms">[],
  limit: number,
) {
  const agg = new Map<string, { name: string; plays: number; minutes: number }>();
  for (const r of rows) {
    const key = r.artist_id ?? r.artist_name ?? "—";
    const entry = agg.get(key) ?? { name: r.artist_name ?? "—", plays: 0, minutes: 0 };
    entry.plays++;
    entry.minutes += (r.duration_ms ?? 0) / 60000;
    agg.set(key, entry);
  }
  return Array.from(agg.values())
    .sort((a, b) => b.plays - a.plays)
    .slice(0, limit);
}

export async function getSpotifyTopArtists(range: SpotifyRange = "30d", limit: number = 10) {
  return computeTopArtists(await fetchSpotifyPlays(range), limit);
}

// Each play contributes one tally to every genre the artist has.
// Heavy-rotation artists naturally weight their genres more.
function computeTopGenres(
  plays: Pick<SpotifyPlayFull, "artist_id">[],
  genresByArtist: Map<string, string[]>,
  limit: number,
) {
  const playsByArtist = new Map<string, number>();
  for (const p of plays) {
    if (!p.artist_id) continue;
    playsByArtist.set(p.artist_id, (playsByArtist.get(p.artist_id) ?? 0) + 1);
  }
  if (playsByArtist.size === 0) return [];

  const counts = new Map<string, number>();
  for (const [artistId, genres] of genresByArtist) {
    const w = playsByArtist.get(artistId) ?? 0;
    if (!w) continue;
    for (const g of genres) {
      if (!g) continue;
      counts.set(g, (counts.get(g) ?? 0) + w);
    }
  }

  return Array.from(counts.entries())
    .map(([genre, plays]) => ({ genre, plays }))
    .sort((a, b) => b.plays - a.plays)
    .slice(0, limit);
}

export async function getSpotifyTopGenres(range: SpotifyRange = "30d", limit: number = 10) {
  const plays = await fetchSpotifyPlays(range);
  const ids = Array.from(new Set(plays.map((p) => p.artist_id).filter(Boolean) as string[]));
  const genresByArtist = await fetchArtistGenres(ids);
  return computeTopGenres(plays, genresByArtist, limit);
}

function computeTopTracks(
  rows: Pick<SpotifyPlayFull, "track_id" | "track_name" | "artist_name" | "duration_ms">[],
  limit: number,
) {
  const agg = new Map<string, { track_id: string; name: string; artist: string; plays: number; minutes: number }>();
  for (const r of rows) {
    if (!r.track_id) continue;
    const entry = agg.get(r.track_id) ?? {
      track_id: r.track_id,
      name: r.track_name ?? "—",
      artist: r.artist_name ?? "—",
      plays: 0,
      minutes: 0,
    };
    entry.plays++;
    entry.minutes += (r.duration_ms ?? 0) / 60000;
    agg.set(r.track_id, entry);
  }
  return Array.from(agg.values())
    .sort((a, b) => b.plays - a.plays)
    .slice(0, limit);
}

export async function getSpotifyTopTracks(range: SpotifyRange = "30d", limit: number = 10) {
  return computeTopTracks(await fetchSpotifyPlays(range), limit);
}

export interface SonicProfileRow {
  feature: "valence" | "energy" | "danceability" | "acousticness" | "instrumentalness" | "liveness" | "speechiness";
  value: number;
}

function computeSonicProfile(
  plays: Pick<SpotifyPlayFull, "track_id">[],
  features: SpotifyTrackFeatureRow[],
): {
  profile: SonicProfileRow[];
  totalPlays: number;
  featurizedPlays: number;
} | null {
  const playCounts = new Map<string, number>();
  for (const p of plays) {
    if (!p.track_id) continue;
    playCounts.set(p.track_id, (playCounts.get(p.track_id) ?? 0) + 1);
  }
  if (playCounts.size === 0) return null;

  const featureNames = [
    "valence",
    "energy",
    "danceability",
    "acousticness",
    "instrumentalness",
    "liveness",
    "speechiness",
  ] as const;
  const sums: Record<string, number> = Object.fromEntries(featureNames.map((f) => [f, 0]));
  const weights: Record<string, number> = Object.fromEntries(featureNames.map((f) => [f, 0]));
  let featurizedPlays = 0;

  for (const t of features) {
    const w = playCounts.get(t.track_id) ?? 0;
    let counted = false;
    for (const f of featureNames) {
      const v = t[f];
      if (v != null) {
        sums[f] += Number(v) * w;
        weights[f] += w;
        counted = true;
      }
    }
    if (counted) featurizedPlays += w;
  }

  const totalPlays = Array.from(playCounts.values()).reduce((a, b) => a + b, 0);
  const profile: SonicProfileRow[] = featureNames.map((f) => ({
    feature: f,
    value: weights[f] > 0 ? sums[f] / weights[f] : 0,
  }));

  return { profile, totalPlays, featurizedPlays };
}

export async function getSpotifySonicProfile(range: SpotifyRange = "30d"): Promise<{
  profile: SonicProfileRow[];
  totalPlays: number;
  featurizedPlays: number;
} | null> {
  const plays = await fetchSpotifyPlays(range);
  const trackIds = Array.from(new Set(plays.map((p) => p.track_id).filter(Boolean) as string[]));
  const features = await fetchTrackFeatures(trackIds);
  return computeSonicProfile(plays, features);
}

export interface SpotifyLedgerRow {
  played_at: string;
  track_id: string;
  track_name: string | null;
  artist_name: string | null;
  album_name: string | null;
  duration_ms: number | null;
}

export async function getSpotifyLedger(
  range: SpotifyRange = "30d",
  page: number = 0,
  perPage: number = 50,
): Promise<{ rows: SpotifyLedgerRow[]; totalCount: number }> {
  const from = page * perPage;
  const to = from + perPage - 1;
  let q = supabase
    .from("spotify_plays")
    .select("played_at,track_id,track_name,artist_name,album_name,duration_ms", { count: "exact" });
  const since = sinceFor(range);
  if (since) q = q.gte("played_date_et", since);
  const { data, error, count } = await q
    .order("played_at", { ascending: false })
    .range(from, to);
  if (error) throw error;
  return { rows: (data ?? []) as SpotifyLedgerRow[], totalCount: count ?? 0 };
}

function computeHourOfDay(rows: Pick<SpotifyPlayFull, "played_at">[]) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, plays: 0 }));
  // hourCycle: 'h23' returns 0..23 always; the old `hour12: false` config
  // returns '24' for midnight in V8/Node and the h<24 guard would drop every
  // 00:00–00:59 play silently (gemini units/F-003).
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  });
  for (const r of rows) {
    const h = parseInt(fmt.format(new Date(r.played_at)), 10);
    if (!Number.isNaN(h) && h >= 0 && h < 24) buckets[h].plays++;
  }
  return buckets;
}

export async function getSpotifyHourOfDay(range: SpotifyRange = "30d") {
  return computeHourOfDay(await fetchSpotifyPlays(range));
}

/**
 * One-call data path for the /spotify dashboard: fetches the range's plays
 * ONCE (paged in parallel past the 1000-row cap), the artist-genre map ONCE,
 * and the track features ONCE, then computes every aggregate from the shared
 * rows. Replaces 8 independent plays scans + 2 sequential artist chunk-loops
 * (~17+ requests, several silently truncated at 1000 rows) with ~4 request
 * waves.
 */
export async function getSpotifyDashboard(range: SpotifyRange = "30d", topN: { genres?: number; artists?: number; tracks?: number } = {}) {
  const [plays, prior] = await Promise.all([
    fetchSpotifyPlays(range),
    fetchPriorTrackIds(sinceFor(range)),
  ]);
  const artistIds = Array.from(new Set(plays.map((p) => p.artist_id).filter(Boolean) as string[]));
  const trackIds = Array.from(new Set(plays.map((p) => p.track_id).filter(Boolean) as string[]));
  const [genresByArtist, features] = await Promise.all([
    fetchArtistGenres(artistIds),
    fetchTrackFeatures(trackIds),
  ]);
  return {
    kpis: computeSpotifyKpis(plays),
    topArtists: computeTopArtists(plays, topN.artists ?? 10),
    topTracks: computeTopTracks(plays, topN.tracks ?? 10),
    hours: computeHourOfDay(plays),
    sonic: computeSonicProfile(plays, features),
    genreRotation: computeGenreRotation(plays, genresByArtist, 8),
    topGenres: computeTopGenres(plays, genresByArtist, topN.genres ?? 10),
    discovery: computeDiscoveryRate(plays, prior),
  };
}
