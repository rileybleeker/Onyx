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
