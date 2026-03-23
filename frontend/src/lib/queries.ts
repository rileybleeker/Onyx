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
