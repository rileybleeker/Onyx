import { supabase } from "./supabase";

export async function getDailySummaries(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("garmin_daily_summary")
    .select("*")
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getSleepData(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("garmin_sleep")
    .select("*")
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getHeartRateData(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("garmin_heart_rate")
    .select("*")
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
    .select("*")
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getActivities(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("garmin_activities")
    .select("*")
    .gte("start_time_local", since.toISOString())
    .order("start_time_local", { ascending: false });

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
    .select("*")
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
    .select("*")
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// WHOOP
// ---------------------------------------------------------------------------

export async function getWhoopCycles(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("whoop_cycles")
    .select("*")
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
    .select("*")
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
    .select("*")
    .gte("start_time", since.toISOString())
    .eq("is_nap", false)
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
    .select("*")
    .gte("start_time", since.toISOString())
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

  // Fetch WHOOP sleep starts + cycles + recovery + workouts, plus Garmin
  // activities. Compute the join client-side so we don't add a server view
  // for a single chart.
  const [sleepRes, cyclesRes, recRes, wkRes, gactRes] = await Promise.all([
    supabase.from("whoop_sleep").select("cycle_id,start_time")
      .eq("is_nap", false).eq("score_state", "SCORED")
      .gte("start_time", sinceISO).order("start_time", { ascending: true }),
    supabase.from("whoop_cycles").select("cycle_id,start_time").gte("start_time", sinceISO),
    supabase.from("whoop_recovery").select("cycle_id,hrv_rmssd_milli").eq("score_state", "SCORED"),
    supabase.from("whoop_workouts").select("end_time,strain")
      .eq("score_state", "SCORED").gte("end_time", sinceISO),
    supabase.from("garmin_activities").select("start_time_gmt,duration_seconds,training_load")
      .gte("start_time_gmt", sinceISO),
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

  const eighteenHrMs = 18 * 60 * 60 * 1000;
  const out: WorkoutSleepGap[] = [];
  for (const s of sleeps) {
    const sleepMs = new Date(s.start_time as string).getTime();
    // Binary-search-ish: find the latest workout with end <= sleepMs
    let last: W | null = null;
    for (let i = workouts.length - 1; i >= 0; i--) {
      if (workouts[i].end <= sleepMs && sleepMs - workouts[i].end <= eighteenHrMs) {
        last = workouts[i]; break;
      }
      if (workouts[i].end < sleepMs - eighteenHrMs) break;
    }
    // pred_date = ET date of (cycle_start - 1 day), matching pipeline attribution
    const cycleStart = cycleStartByCycle.get(s.cycle_id as number);
    const cycleStartMs = cycleStart ? new Date(cycleStart).getTime() : sleepMs;
    const predDateMs = cycleStartMs - 24 * 60 * 60 * 1000;
    const predDate = new Date(predDateMs).toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
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

  const { data, error } = await supabase
    .from("whoop_journal")
    .select("*")
    .gte("cycle_date", since.toISOString().split("T")[0])
    .order("cycle_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Eight Sleep
// ---------------------------------------------------------------------------

export async function getEightSleepTrends(days: number = 30, side: string = "left") {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("eight_sleep_trends")
    .select("*")
    .eq("bed_side", side)
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// MyFitnessPal
// ---------------------------------------------------------------------------

export async function getMfpNutrition(days: number = 30) {
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

// ---------------------------------------------------------------------------
// Recovery vs Pace Correlation
// ---------------------------------------------------------------------------

export async function getRecoveryVsPace(days: number = 365) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("recovery_vs_pace")
    .select("*")
    .gte("activity_date", since.toISOString().split("T")[0])
    .not("whoop_recovery", "is", null)
    .order("activity_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Unified Health Matrix view
// ---------------------------------------------------------------------------

export async function getHealthMatrix(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("daily_health_matrix")
    .select("*")
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Habits (stored in habit_journal, same schema as whoop_journal)
// ---------------------------------------------------------------------------

export async function getHabitJournal(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("habit_journal")
    .select("*")
    .gte("cycle_date", since.toISOString().split("T")[0])
    .order("cycle_date", { ascending: true });

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
