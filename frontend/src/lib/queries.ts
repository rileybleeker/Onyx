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

// Same as getWhoopSleep but INCLUDES naps. Used for Sleep Debt chart so
// nap-only days (travel, jet lag) still surface the WHOOP-recorded debt value.
export async function getWhoopSleepAll(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("whoop_sleep")
    .select("*")
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

  const byDate = new Map<string, { calendar_date: string; kilojoule: number; calories_burnt: number }>();
  for (const c of data ?? []) {
    if (!c.start_time || c.kilojoule == null) continue;
    const start = new Date(c.start_time);
    const midday = new Date(start.getTime() + 12 * 3600 * 1000);
    const calendar_date = midday.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const kcal = Math.round(Number(c.kilojoule) / 4.184);
    // Ascending order means last-write-wins picks the later cycle on the rare
    // day with two; in practice there's one cycle per ET date.
    byDate.set(calendar_date, { calendar_date, kilojoule: Number(c.kilojoule), calories_burnt: kcal });
  }
  return Array.from(byDate.values()).sort((a, b) => (a.calendar_date < b.calendar_date ? -1 : 1));
}


// ---------------------------------------------------------------------------
// Recovery context for running activities (merged into /activities row cards)
// ---------------------------------------------------------------------------

export async function getRunningRecoveryContext(days: number = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("recovery_vs_pace")
    .select("activity_id, whoop_recovery, whoop_hrv, whoop_sleep_performance, pace_delta_pct, segment_targets, segment_target_count")
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

export async function getSpotifyKpis(range: SpotifyRange = "30d") {
  let q = supabase
    .from("spotify_plays")
    .select("track_id,artist_id,duration_ms,track_name,artist_name");
  const since = sinceFor(range);
  if (since) q = q.gte("played_date_et", since);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data ?? [];
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

export async function getSpotifyDailyVolume(range: SpotifyRange = "90d"): Promise<SpotifyDailySignatureRow[]> {
  let q = supabase
    .from("spotify_daily_signature")
    .select("calendar_date,play_count,unique_tracks,unique_artists,total_minutes,featurized_plays");
  const since = sinceFor(range);
  if (since) q = q.gte("calendar_date", since);
  const { data, error } = await q.order("calendar_date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as SpotifyDailySignatureRow[];
}

export async function getSpotifyAudioFeatureDrift(range: SpotifyRange = "60d"): Promise<SpotifyDailySignatureRow[]> {
  let q = supabase
    .from("spotify_daily_signature")
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

export async function getSpotifyGenreRotation(
  range: SpotifyRange = "30d",
  topN: number = 8,
): Promise<{ rows: SpotifyGenreRotationRow[]; topGenres: string[] }> {
  let pq = supabase
    .from("spotify_plays")
    .select("played_date_et,artist_id");
  const since = sinceFor(range);
  if (since) pq = pq.gte("played_date_et", since);
  const { data: plays, error: pErr } = await pq.order("played_date_et", { ascending: true });
  if (pErr) throw pErr;
  if (!plays || plays.length === 0) return { rows: [], topGenres: [] };

  const artistIds = Array.from(
    new Set(plays.map((p) => p.artist_id).filter(Boolean) as string[]),
  );
  type ArtistGenresRow = { artist_id: string; genres: string[] | null };
  const artists: ArtistGenresRow[] = [];
  const CHUNK = 200;
  for (let i = 0; i < artistIds.length; i += CHUNK) {
    const batch = artistIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("spotify_artists")
      .select("artist_id,genres")
      .in("artist_id", batch);
    if (error) throw error;
    artists.push(...((data ?? []) as ArtistGenresRow[]));
  }
  const genresByArtist = new Map<string, string[]>();
  for (const a of artists) {
    if (a.genres && a.genres.length > 0) {
      genresByArtist.set(a.artist_id, a.genres);
    }
  }

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

export interface SpotifyDiscoveryRow {
  calendar_date: string;
  new_tracks: number;
  total_plays: number;
  pct_new: number;
}

export async function getSpotifyDiscoveryRate(
  range: SpotifyRange = "30d",
): Promise<SpotifyDiscoveryRow[]> {
  // For each play in the range, "new" = track_id not seen in any previous play
  // (across all-time, not just the range — otherwise picking a wider range would
  // flip familiar tracks back to "new"). Two queries: all prior track_ids, plus
  // the range's plays in chronological order.
  const since = sinceFor(range);

  let prior: Set<string> = new Set();
  if (since) {
    // Fetch every track_id played before `since`. This can be large, so we page.
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("spotify_plays")
        .select("track_id")
        .lt("played_date_et", since)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const rows = data ?? [];
      for (const r of rows) if (r.track_id) prior.add(r.track_id);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }
  // else: "all time" — nothing prior, every first occurrence is "new"

  let q = supabase
    .from("spotify_plays")
    .select("played_date_et,track_id,played_at")
    .order("played_at", { ascending: true });
  if (since) q = q.gte("played_date_et", since);
  const { data: rangePlays, error: rErr } = await q;
  if (rErr) throw rErr;

  const buckets = new Map<string, { new_tracks: number; total_plays: number }>();
  const seenInRange = new Set<string>();
  for (const p of rangePlays ?? []) {
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

export async function getSpotifyTopArtists(range: SpotifyRange = "30d", limit: number = 10) {
  let q = supabase
    .from("spotify_plays")
    .select("artist_id,artist_name,duration_ms");
  const since = sinceFor(range);
  if (since) q = q.gte("played_date_et", since);
  const { data, error } = await q;
  if (error) throw error;
  const agg = new Map<string, { name: string; plays: number; minutes: number }>();
  for (const r of data ?? []) {
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

export async function getSpotifyTopGenres(range: SpotifyRange = "30d", limit: number = 10) {
  let pq = supabase.from("spotify_plays").select("artist_id");
  const since = sinceFor(range);
  if (since) pq = pq.gte("played_date_et", since);
  const { data: plays, error: pErr } = await pq;
  if (pErr) throw pErr;

  const playsByArtist = new Map<string, number>();
  for (const p of plays ?? []) {
    if (!p.artist_id) continue;
    playsByArtist.set(p.artist_id, (playsByArtist.get(p.artist_id) ?? 0) + 1);
  }
  if (playsByArtist.size === 0) return [];

  const ids = Array.from(playsByArtist.keys());
  type ArtistGenresRow = { artist_id: string; genres: string[] | null };
  const artists: ArtistGenresRow[] = [];
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("spotify_artists")
      .select("artist_id,genres")
      .in("artist_id", batch);
    if (error) throw error;
    artists.push(...((data ?? []) as ArtistGenresRow[]));
  }

  // Each play contributes one tally to every genre the artist has.
  // Heavy-rotation artists naturally weight their genres more.
  const counts = new Map<string, number>();
  for (const a of artists) {
    const w = playsByArtist.get(a.artist_id) ?? 0;
    if (!w || !a.genres) continue;
    for (const g of a.genres) {
      if (!g) continue;
      counts.set(g, (counts.get(g) ?? 0) + w);
    }
  }

  return Array.from(counts.entries())
    .map(([genre, plays]) => ({ genre, plays }))
    .sort((a, b) => b.plays - a.plays)
    .slice(0, limit);
}

export async function getSpotifyTopTracks(range: SpotifyRange = "30d", limit: number = 10) {
  let q = supabase
    .from("spotify_plays")
    .select("track_id,track_name,artist_name,duration_ms");
  const since = sinceFor(range);
  if (since) q = q.gte("played_date_et", since);
  const { data, error } = await q;
  if (error) throw error;
  const agg = new Map<string, { track_id: string; name: string; artist: string; plays: number; minutes: number }>();
  for (const r of data ?? []) {
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

export interface SonicProfileRow {
  feature: "valence" | "energy" | "danceability" | "acousticness" | "instrumentalness" | "liveness" | "speechiness";
  value: number;
}

export async function getSpotifySonicProfile(range: SpotifyRange = "30d"): Promise<{
  profile: SonicProfileRow[];
  totalPlays: number;
  featurizedPlays: number;
} | null> {
  let pq = supabase.from("spotify_plays").select("track_id");
  const since = sinceFor(range);
  if (since) pq = pq.gte("played_date_et", since);
  const { data: plays, error: pErr } = await pq;
  if (pErr) throw pErr;

  const playCounts = new Map<string, number>();
  for (const p of plays ?? []) {
    if (!p.track_id) continue;
    playCounts.set(p.track_id, (playCounts.get(p.track_id) ?? 0) + 1);
  }
  if (playCounts.size === 0) return null;

  const uniqueIds = Array.from(playCounts.keys());
  type FeatureRow = {
    track_id: string;
    valence: number | null;
    energy: number | null;
    danceability: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    liveness: number | null;
    speechiness: number | null;
  };
  const features: FeatureRow[] = [];
  const CHUNK = 200;
  for (let i = 0; i < uniqueIds.length; i += CHUNK) {
    const batch = uniqueIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("spotify_tracks")
      .select("track_id,valence,energy,danceability,acousticness,instrumentalness,liveness,speechiness")
      .in("track_id", batch);
    if (error) throw error;
    features.push(...((data ?? []) as FeatureRow[]));
  }

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

export async function getSpotifyHourOfDay(range: SpotifyRange = "30d") {
  let q = supabase.from("spotify_plays").select("played_at");
  const since = sinceFor(range);
  if (since) q = q.gte("played_date_et", since);
  const { data, error } = await q;
  if (error) throw error;
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, plays: 0 }));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  });
  for (const r of data ?? []) {
    const h = parseInt(fmt.format(new Date(r.played_at)), 10);
    if (!Number.isNaN(h) && h >= 0 && h < 24) buckets[h].plays++;
  }
  return buckets;
}
