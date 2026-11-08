import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { searchTracks, createPlaylist } from "@/lib/spotify-server";
import { logStackIntake } from "@/lib/supplement-stacks";
import { addHighlight, getOverview, logSession, recordQuiz, summarizeForChat, type HighlightSource, type Medium } from "@/lib/reading";
import { mirrorHighlight, mirrorProgress, mirrorSession } from "@/lib/reading-notion";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

const SYSTEM_PROMPT = `You are Onyx, a personal data scientist assistant. You help the user understand their health and fitness data from three devices: Garmin watch, WHOOP band, and Eight Sleep mattress. You also help them track daily habits.

You have access to the user's data via function calls. When the user asks about their health metrics, use the appropriate function to fetch real data before answering. You can call multiple tools to cross-reference data across devices. Be concise and insightful — highlight trends, anomalies, and actionable takeaways.

When the user mentions completing a habit (e.g., "I meditated today", "I took my vitamins"), use mark_habit_complete to log it. The habit name should match what's defined in their habits list. Use query_journal to see both self-reported behaviors and habit completions together.

The user keeps reusable supplement "stacks" — named lists of supplements + doses (like a bill of materials). When they say they took a named stack or routine (e.g. "log my morning stack", "I took my evening stack"), use log_supplement_stack with the stack name. It records every supplement in that stack at once. If the name doesn't match, the tool returns the list of available stacks so you can confirm which one they mean.

The user also keeps a free-form *personal* journal in Notion (prose entries about life, mood, relationships, training, mental health). Use query_journal_entries when they ask about what they wrote, how they were feeling, or to find context behind biometric trends — combine it with biometric tools to answer questions like "what was my HRV on days I logged a 'low' mood?". When a question is thematic rather than date-specific, set semantic_query to do similarity search.

You also have the user's nutrition data. FOOD comes from Cronometer (cutover 2026-05-31; MyFitnessPal for older history). Use query_nutrition for daily macros and query_meals_log for the per-meal food log. For vitamins/minerals use query_vitamins — it already COMBINES dietary intake (food, from Cronometer) with supplemental intake (pills, from Onyx's /supplements tracker) and returns the dietary, supplement, and total amounts per nutrient, so never add supplements on top of those totals. The rule is: Cronometer = food, Onyx /supplements = pills. Use query_micronutrient_trend for single-nutrient trends.

You can also create Spotify playlists. The user has private-playlist write access enabled. When asked to make a playlist:
- Use query_spotify_tracks_by_features to pick tracks from their listening history (filter by audio-feature ranges like valence, energy, tempo).
- Use search_spotify_catalog when they want tracks they haven't listened to before, or when filling out a playlist beyond what their history covers.
- Once you have track IDs (mix sources freely), call create_spotify_playlist directly — playlists are private and easily deleted, so don't ask for confirmation.
- Default to ~25–40 tracks unless the user specifies otherwise. Give the playlist a descriptive name that reflects the user's request.

The user is also reading a book as a tracked "reading quest" (currently The Goal by Goldratt, 40 chapters, target Nov 30 2026). Use get_reading_status for progress, pace and coaching. When they report reading ("finished chapters 3 and 4 on my run, here's what I remember: …"), call log_reading_session and pass their recall text VERBATIM — never summarize it. When they quote a passage with a comment, call add_book_highlight. When they ask to be quizzed ("quiz me on The Goal through chapter 12"), first call get_reading_status, then ask 5 short questions ONE AT A TIME drawn from the chapters they have read, their highlights and recall notes; grade each answer honestly; then call record_reading_quiz with checkpoint 'ch<N>' and the score. Keep coaching brief and specific (chapters behind pace, streak at risk, reviews due).

Format numbers clearly. Use relative comparisons (e.g., "your HRV is 15% above your weekly average"). When comparing across devices, note any discrepancies. When you don't have enough data, say so.`;

const tools: Anthropic.Tool[] = [
  {
    name: "query_daily_summary",
    description: "Get Garmin daily summary stats (steps, heart rate, stress, body battery, SpO2) for a date range. Use this for general health questions. Garmin's calorie estimate is returned as garmin_total_kcal_NOT_TDEE and must NOT be reported as calories burned — use query_whoop_cycles (tdee_kcal) for daily energy expenditure.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_sleep",
    description: "Get sleep data (duration, stages, scores, HRV, heart rate) for a date range.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_hrv",
    description: "Get HRV (heart rate variability) data including weekly average, last night average, and baseline ranges.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_activities",
    description: "Get workout/activity data (type, distance, duration, pace, heart rate, training effect, VO2 max).",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "query_training_status",
    description: "Get training readiness scores and contributing factors (sleep, recovery, HRV, stress, training load).",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_stress",
    description: "Get stress level data including duration breakdowns by intensity.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_whoop_recovery",
    description: "Get WHOOP recovery data including recovery score, HRV (RMSSD), resting heart rate, SpO2, and skin temperature.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_whoop_cycles",
    description: "Get WHOOP daily cycle data including strain, kilojoules, average and max heart rate. tdee_kcal (kilojoule / 4.184) is THE canonical daily calories-burned / TDEE figure — always use it for 'calories burned' questions.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_whoop_sleep",
    description: "Get WHOOP sleep data including sleep performance, efficiency, stages (in milliseconds), disturbances, and respiratory rate.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_whoop_workouts",
    description: "Get WHOOP workout data including sport type, strain, heart rate zones, distance, and altitude.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "query_behaviors",
    description: "Get self-reported behavior entries — caffeine, alcohol, supplements, sleep habits, recovery activities, and more. Each entry has a date, behavior name, category, and answer (Yes/No or a value).",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 30)" },
        question: { type: "string", description: "Optional: filter by specific behavior name (e.g., 'Caffeine', 'Melatonin')" },
        category: { type: "string", description: "Optional: filter by category (e.g., 'Supplements', 'Lifestyle', 'Sleep')" },
      },
      required: [],
    },
  },
  {
    name: "query_journal",
    description: "Get the unified behavior journal combining self-reported behaviors AND habit completions. Each entry has a date, behavior/habit name, category, answer, and source ('whoop' = imported behavior history, 'habit' = tracked habit). Use this for cross-analysis of habits and self-reported behaviors.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 30)" },
        source: { type: "string", description: "Optional: filter by source — 'whoop' or 'habit'" },
        question: { type: "string", description: "Optional: filter by specific behavior/habit name" },
      },
      required: [],
    },
  },
  {
    name: "mark_habit_complete",
    description: "Record a habit answer for a given date — 'Yes' (did it, default) or 'No' (explicitly did NOT do it, e.g. 'I skipped meditation today'). The habit name must match one defined in the user's Notion Habits database (e.g., 'Meditated', 'Exercised', 'Read'). Defaults to today. Only record 'No' when the user explicitly says they didn't do the habit — an unmentioned habit should stay unlogged.",
    input_schema: {
      type: "object" as const,
      properties: {
        habit: { type: "string", description: "The habit name exactly as defined in Notion (e.g., 'Meditated', 'Exercised')" },
        date: { type: "string", description: "Date in YYYY-MM-DD format (defaults to today)" },
        category: { type: "string", description: "Optional: habit category (e.g., 'mindfulness', 'fitness')" },
        answer: { type: "string", enum: ["Yes", "No"], description: "'Yes' = completed (default); 'No' = explicitly not done" },
      },
      required: ["habit"],
    },
  },
  {
    name: "log_supplement_stack",
    description: "Record a whole supplement 'stack' (a saved, named list of supplements + doses) as consumed. Use when the user says they took a named stack or routine, e.g. 'log my morning stack' or 'I took my evening stack'. Writes one intake event per supplement in the stack. If the stack name doesn't match, the response lists available stacks — relay them and ask which one.",
    input_schema: {
      type: "object" as const,
      properties: {
        stack: { type: "string", description: "The stack name as the user refers to it (e.g. 'Morning', 'Evening stack'). Matched case-insensitively." },
        date: { type: "string", description: "Date in YYYY-MM-DD format (defaults to the current behavioral day)" },
      },
      required: ["stack"],
    },
  },
  {
    name: "get_reading_status",
    description: "Get the user's reading quest for the book in progress (default: the active book): chapters done vs total, pace vs target date, streak, XP/level, badges, checkpoints with quiz results, recent sessions WITH their from-memory recall notes, highlights WITH comments, and highlights due for review. Use it for 'how is my reading going', to coach pace, and as the source material when the user asks to be quizzed on the book.",
    input_schema: {
      type: "object" as const,
      properties: {
        book: { type: "string", description: "Book slug (e.g. 'the-goal'). Omit for the active book." },
      },
      required: [],
    },
  },
  {
    name: "log_reading_session",
    description: "Record a reading session for the active book: the chapter reached, minutes, medium, and the user's from-memory recall note (what happened, what principle, where it shows up in a BC implementation) plus one question. Use when the user says they read/listened to chapters ('I finished chapters 5 and 6 on my run', 'log my reading: through chapter 8, here is what I remember…'). Pass their recall text VERBATIM as `recall`. Also marks the book's habit for that day and mirrors the entry to Notion. Returns XP gained.",
    input_schema: {
      type: "object" as const,
      properties: {
        chapter_through: { type: "number", description: "Last chapter completed (cumulative, e.g. 6)" },
        chapter_from: { type: "number", description: "First chapter of this session (optional; defaults to previous max + 1)" },
        minutes: { type: "number", description: "Minutes spent (optional)" },
        medium: { type: "string", enum: ["audio", "kindle", "paper", "other"], description: "How they read (optional)" },
        recall: { type: "string", description: "The user's own words, verbatim: what happened, the principle, the BC mapping" },
        question: { type: "string", description: "One question they'd ask a plant manager / client (optional)" },
        date: { type: "string", description: "YYYY-MM-DD (defaults to the current behavioral day)" },
        book: { type: "string", description: "Book slug (optional; defaults to the active book)" },
      },
      required: ["chapter_through"],
    },
  },
  {
    name: "add_book_highlight",
    description: "Save a highlighted passage from the book with the user's comment, chapter and concept tag (e.g. 'Bottleneck / capacity-constrained resource'). Use when the user quotes or paraphrases a passage they want to keep ('highlight this: …', 'save this quote and note that …'). Idempotent on passage. Mirrors to Notion and enters the spaced-repetition review queue.",
    input_schema: {
      type: "object" as const,
      properties: {
        passage: { type: "string", description: "The passage text" },
        comment: { type: "string", description: "The user's comment / annotation (optional but encouraged)" },
        chapter: { type: "number", description: "Chapter number (optional)" },
        concept: { type: "string", description: "Concept tag for the TOC→BC mapping (optional)" },
        source: { type: "string", enum: ["manual", "kindle", "audible", "paper", "photo"], description: "Where it came from (optional)" },
        book: { type: "string", description: "Book slug (optional)" },
      },
      required: ["passage"],
    },
  },
  {
    name: "record_reading_quiz",
    description: "Record the result of a checkpoint quiz you just ran with the user about the book. Call it AFTER asking the questions one at a time and grading the answers. checkpoint is 'ch<N>' for the chapter checkpoints (e.g. 'ch12', 'ch26', 'ch40') or 'review' for a later spaced review. 80%+ passes and earns the Quiz Master badge.",
    input_schema: {
      type: "object" as const,
      properties: {
        checkpoint: { type: "string", description: "'ch12' | 'ch26' | 'ch40' | 'review' | other label" },
        score: { type: "number", description: "Correct answers" },
        total: { type: "number", description: "Questions asked" },
        notes: { type: "string", description: "What they missed, in one or two lines (optional)" },
        book: { type: "string", description: "Book slug (optional)" },
      },
      required: ["checkpoint", "score", "total"],
    },
  },
  {
    name: "query_eight_sleep",
    description: "Get Eight Sleep mattress data including sleep score, fitness score, HRV, heart rate, breath rate, bed/room temperature, sleep stages, and toss & turns.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "search_spotify_catalog",
    description: "Search Spotify's full catalog for tracks (not just the user's listening history). Use this when the user wants tracks they haven't played before, or to fill out a playlist beyond what their history covers. Returns track ID, name, artists, album, duration, and popularity. Query syntax supports filters like 'genre:ambient', 'year:2020-2024', 'artist:Tycho'.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Spotify search query (supports field filters: artist:, album:, genre:, year:, etc.)" },
        limit: { type: "number", description: "Max tracks to return (default 20, max 50)" },
      },
      required: ["query"],
    },
  },
  {
    name: "query_spotify_tracks_by_features",
    description: "Query the user's listening-history track library by audio features (valence, energy, danceability, tempo). Use this to curate playlists from tracks they already know. Audio features are normalized 0–1 except tempo (BPM, ~50–200). Only returns tracks with audio features attached (~78% of plays).",
    input_schema: {
      type: "object" as const,
      properties: {
        min_valence: { type: "number", description: "Minimum valence 0–1 (positivity)" },
        max_valence: { type: "number", description: "Maximum valence 0–1" },
        min_energy: { type: "number", description: "Minimum energy 0–1" },
        max_energy: { type: "number", description: "Maximum energy 0–1" },
        min_danceability: { type: "number", description: "Minimum danceability 0–1" },
        max_danceability: { type: "number", description: "Maximum danceability 0–1" },
        min_tempo: { type: "number", description: "Minimum tempo in BPM" },
        max_tempo: { type: "number", description: "Maximum tempo in BPM" },
        limit: { type: "number", description: "Max tracks to return (default 50, max 200)" },
      },
      required: [],
    },
  },
  {
    name: "query_journal_entries",
    description: "Search the user's personal Notion journal (free-form prose entries about their life — relationships, mental health, work, training, etc., distinct from the behavior journal of self-reported behaviors and habits). Use this when the user asks about how they were feeling, what they wrote about, or to find context behind health data. Supports filters and optional semantic search via 'semantic_query'. Returns entries sorted by similarity (when semantic_query given) or by date desc.",
    input_schema: {
      type: "object" as const,
      properties: {
        date_from: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive" },
        date_to: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive" },
        mood: { type: "string", description: "Filter by mood: 'low' | 'neutral' | 'good' | 'great'" },
        topics: { type: "array", items: { type: "string" }, description: "ANY-match against Notion Topics (e.g., ['gym','mental-health']). Empty/omit for no topic filter." },
        semantic_query: { type: "string", description: "Optional free-text query for embedding-based similarity (e.g., 'feeling unmotivated about training'). When provided, results are ordered by similarity." },
        limit: { type: "number", description: "Max entries to return (default 10, max 25)" },
      },
      required: [],
    },
  },
  {
    name: "create_spotify_playlist",
    description: "Create a private Spotify playlist with the given tracks. Playlists are added to the user's Spotify account and a link is returned. Always private — do not ask for confirmation, just create it (easy to delete in Spotify if not wanted).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Playlist name (e.g., 'Onyx — High-energy workout')" },
        description: { type: "string", description: "Optional playlist description shown in Spotify" },
        track_ids: { type: "array", items: { type: "string" }, description: "Ordered array of Spotify track IDs (just the ID portion, not full URIs)" },
      },
      required: ["name", "track_ids"],
    },
  },
  {
    name: "query_nutrition",
    description:
      "Daily nutrition macros (calories, protein, carbs, fat, fiber, sugar, sodium, water) plus caffeine per behavioral day. caffeine_total_mg (diet + supplement) is the canonical total caffeine — nutrition_caffeine_mg is the dietary-only archive. Also returns caffeine_supplement_mg, caffeine_mg_at_bedtime (5h half-life residual at sleep onset; null without trusted timestamps), and caffeine_to_bedtime_min. Source is Cronometer for new days and MyFitnessPal for pre-2026-05-31 history, transparently COALESCE'd. Macros are FOOD intake only — for supplement-inclusive vitamin/mineral totals use query_vitamins.",
    input_schema: {
      type: "object" as const,
      properties: { days: { type: "number", description: "How many days back (default 7)" } },
    },
  },
  {
    name: "query_meals_log",
    description:
      "Per-entry Cronometer food log: each logged food with its meal group (Breakfast/Lunch/Dinner/Snacks/Uncategorized), amount, and macros. Use for 'what did I eat' / meal-by-meal questions. Pass `date` (YYYY-MM-DD, ET behavioral day) for a single day, or `days` for a range.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Days back (default 7)" },
        date: { type: "string", description: "Single ET behavioral day, YYYY-MM-DD" },
        limit: { type: "number", description: "Max entries (default 100)" },
      },
    },
  },
  {
    name: "query_vitamins",
    description:
      "Daily micronutrient intake WITH the dietary-vs-supplement split. For each vitamin/mineral you get the amount from FOOD (Cronometer), from SUPPLEMENTS (Onyx UNII rollup), and the TOTAL — columns like vit_d_dietary_iu / vit_d_supplement_iu / vit_d_total_iu, magnesium_total_mg, omega3_total_g, etc. Use for 'did I hit my RDA of X', 'how much Y am I getting', or food-vs-pill questions. This view ALREADY combines food + supplements, so never add supplement amounts on top of the totals.",
    input_schema: {
      type: "object" as const,
      properties: { days: { type: "number", description: "Days back (default 7)" } },
    },
  },
  {
    name: "query_micronutrient_trend",
    description:
      "Time series (dietary / supplement / total columns) for ONE micronutrient over the window, for trend questions ('how has my magnesium been', '7-day avg vitamin D'). Pass `nutrient` as a key fragment like 'magnesium', 'vit_d', 'omega3', 'b12', 'calcium'.",
    input_schema: {
      type: "object" as const,
      properties: {
        nutrient: { type: "string", description: "Nutrient key fragment, e.g. 'magnesium', 'vit_d', 'omega3'" },
        days: { type: "number", description: "Days back (default 30)" },
      },
      required: ["nutrient"],
    },
  },
];

function stripRawFields(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const { raw_json, raw_hr_values, raw_stress_values, raw_hrv_readings, ...rest } = row;
    void raw_json; void raw_hr_values; void raw_stress_values; void raw_hrv_readings;
    return rest;
  });
}

// TDEE guard (mirrors queries.ts:getDailySummaries): WHOOP kJ / 4.184 is the
// canonical calories-burned figure. Rename Garmin's estimate so the model
// can't mistake it for TDEE, and hand WHOOP rows a ready-made tdee_kcal.
function tagCalorieSources(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (table === "garmin_daily_summary") {
    return rows.map(({ total_kilocalories, ...rest }) => ({ ...rest, garmin_total_kcal_NOT_TDEE: total_kilocalories }));
  }
  if (table === "whoop_cycles") {
    return rows.map((r) => ({
      ...r,
      tdee_kcal: typeof r.kilojoule === "number" ? Math.round(r.kilojoule / 4.184) : null,
    }));
  }
  return rows;
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const days = (input.days as number) || 7;
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  // Tables queried by calendar_date
  const calendarDateTables: Record<string, string> = {
    query_daily_summary: "garmin_daily_summary",
    query_sleep: "garmin_sleep",
    query_hrv: "garmin_hrv",
    query_stress: "garmin_stress",
    query_training_status: "garmin_training_status",
    query_eight_sleep: "eight_sleep_trends",
  };

  // Tables queried by timestamp columns
  const timestampTables: Record<string, { table: string; timeCol: string; extra?: Record<string, unknown> }> = {
    query_activities: { table: "garmin_activities", timeCol: "start_time_local" },
    query_whoop_cycles: { table: "whoop_cycles", timeCol: "start_time" },
    query_whoop_recovery: { table: "whoop_recovery", timeCol: "created_at", extra: { score_state: "SCORED" } },
    query_whoop_sleep: { table: "whoop_sleep", timeCol: "start_time", extra: { is_nap: false, score_state: "SCORED" } },
    query_whoop_workouts: { table: "whoop_workouts", timeCol: "start_time" },
  };

  // Nutrition: daily macros (Cronometer→MFP COALESCE via the behavioral matrix)
  if (name === "query_nutrition") {
    const { data, error } = await supabase
      .from("daily_health_matrix_behavioral")
      .select(
        "calendar_date, nutrition_source, nutrition_calories, nutrition_protein_g, " +
          "nutrition_carbs_g, nutrition_fat_g, nutrition_fiber_g, nutrition_sugar_g, " +
          "nutrition_sodium_mg, nutrition_water_ml, nutrition_caffeine_mg, " +
          "caffeine_total_mg, caffeine_supplement_mg, caffeine_mg_at_bedtime, caffeine_to_bedtime_min"
      )
      .gte("calendar_date", sinceStr)
      .not("nutrition_calories", "is", null)
      .order("calendar_date", { ascending: false });
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Nutrition: per-entry Cronometer food log
  if (name === "query_meals_log") {
    let q = supabase
      .from("cronometer_servings")
      .select(
        "calendar_date, event_time, meal_group, food_name, amount_raw, food_category, calories, protein_g, carbs_g, fat_g"
      )
      .order("calendar_date", { ascending: false })
      .order("serving_id", { ascending: false })
      .limit(Math.min((input.limit as number) ?? 100, 400));
    const date = input.date as string | undefined;
    if (date) q = q.eq("calendar_date", date);
    else q = q.gte("calendar_date", sinceStr);
    const { data, error } = await q;
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Nutrition: micronutrient totals (dietary + supplement + total per nutrient)
  if (name === "query_vitamins") {
    const { data, error } = await supabase
      .from("daily_micronutrient_totals")
      .select("*")
      .gte("onyx_behavioral_date", sinceStr)
      .order("onyx_behavioral_date", { ascending: false });
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Nutrition: single-nutrient trend (dietary/supplement/total columns over time)
  if (name === "query_micronutrient_trend") {
    const nutrient = ((input.nutrient as string) ?? "").toLowerCase().trim();
    const trendDays = (input.days as number) || 30;
    const trendSince = new Date();
    trendSince.setDate(trendSince.getDate() - trendDays);
    const { data, error } = await supabase
      .from("daily_micronutrient_totals")
      .select("*")
      .gte("onyx_behavioral_date", trendSince.toISOString().split("T")[0])
      .order("onyx_behavioral_date", { ascending: false });
    if (error) return JSON.stringify({ error: error.message });
    const rows = (data ?? []) as Record<string, unknown>[];
    const cols = rows.length
      ? Object.keys(rows[0]).filter((c) => nutrient && c.includes(nutrient))
      : [];
    const series = rows.map((r) => {
      const o: Record<string, unknown> = { date: r.onyx_behavioral_date };
      for (const c of cols) o[c] = r[c];
      return o;
    });
    return JSON.stringify({ nutrient, matched_columns: cols, series });
  }

  // Spotify: search the full catalog
  if (name === "search_spotify_catalog") {
    try {
      const query = (input.query as string) ?? "";
      const limit = (input.limit as number) ?? 20;
      const tracks = await searchTracks(query, limit);
      return JSON.stringify(tracks);
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Spotify: query the user's track library by audio-feature ranges
  if (name === "query_spotify_tracks_by_features") {
    const limit = Math.min((input.limit as number) ?? 50, 200);
    let q = supabase
      .from("spotify_tracks")
      .select("track_id,name,artists,album,valence,energy,danceability,tempo,duration_ms")
      .not("features_source", "is", null)
      .limit(limit);
    const pairs: Array<[string, string, unknown]> = [
      ["min_valence", "gte", input.min_valence],
      ["max_valence", "lte", input.max_valence],
      ["min_energy", "gte", input.min_energy],
      ["max_energy", "lte", input.max_energy],
      ["min_danceability", "gte", input.min_danceability],
      ["max_danceability", "lte", input.max_danceability],
      ["min_tempo", "gte", input.min_tempo],
      ["max_tempo", "lte", input.max_tempo],
    ];
    const colMap: Record<string, string> = {
      min_valence: "valence", max_valence: "valence",
      min_energy: "energy", max_energy: "energy",
      min_danceability: "danceability", max_danceability: "danceability",
      min_tempo: "tempo", max_tempo: "tempo",
    };
    for (const [key, op, val] of pairs) {
      if (typeof val !== "number") continue;
      const col = colMap[key];
      if (op === "gte") q = q.gte(col, val);
      else q = q.lte(col, val);
    }
    const { data, error } = await q;
    if (error) return JSON.stringify({ error: error.message });
    // Flatten artists JSONB to a readable string for Claude
    const out = (data ?? []).map((r) => ({
      track_id: r.track_id,
      name: r.name,
      artists: Array.isArray(r.artists)
        ? r.artists.map((a: { name?: string }) => a?.name).filter(Boolean).join(", ")
        : null,
      album: (r.album as { name?: string } | null)?.name ?? null,
      valence: r.valence,
      energy: r.energy,
      danceability: r.danceability,
      tempo: r.tempo,
      duration_ms: r.duration_ms,
    }));
    return JSON.stringify(out);
  }

  // Spotify: create a private playlist
  if (name === "create_spotify_playlist") {
    try {
      const trackIds = input.track_ids as string[];
      const result = await createPlaylist({
        name: input.name as string,
        description: input.description as string | undefined,
        trackIds,
        isPublic: false,
        createdVia: "chat",
      });
      return JSON.stringify(result);
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Handle self-reported behaviors (special: calendar_date + optional filters)
  if (name === "query_behaviors") {
    const journalDays = (input.days as number) || 30;
    const jSince = new Date();
    jSince.setDate(jSince.getDate() - journalDays);
    // Self-reported behavior rows live in habit_journal via the pds.journal
    // view (source='whoop'); pds.whoop_journal is a frozen archive.
    // Descending so the 200-row cap keeps the most RECENT entries (ascending
    // returned the oldest week of the window).
    let query = supabase.from("journal").select("*")
      .eq("source", "whoop")
      .gte("cycle_date", jSince.toISOString().split("T")[0])
      .order("cycle_date", { ascending: false })
      .limit(200);
    if (input.question) query = query.ilike("question", `%${input.question}%`);
    if (input.category) query = query.ilike("category", `%${input.category}%`);
    const { data, error } = await query;
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Unified behavior journal (imported behaviors + habits)
  if (name === "query_journal") {
    const journalDays = (input.days as number) || 30;
    const jSince = new Date();
    jSince.setDate(jSince.getDate() - journalDays);
    // Descending so the 500-row cap keeps the most RECENT entries (the merged
    // table is ~12k rows; ascending returned only the oldest slice).
    let query = supabase.from("journal").select("*")
      .gte("cycle_date", jSince.toISOString().split("T")[0])
      .order("cycle_date", { ascending: false })
      .limit(500);
    if (input.source) query = query.eq("source", input.source as string);
    if (input.question) query = query.ilike("question", `%${input.question}%`);
    const { data, error } = await query;
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Personal Notion journal — metadata filters + optional semantic search
  if (name === "query_journal_entries") {
    const limit = Math.min((input.limit as number) ?? 10, 25);
    const semantic = (input.semantic_query as string | undefined)?.trim();

    let queryEmbedding: number[] | null = null;
    if (semantic) {
      const voyageKey = process.env.VOYAGE_API_KEY;
      if (!voyageKey) {
        return JSON.stringify({ error: "VOYAGE_API_KEY not configured; semantic_query unavailable" });
      }
      try {
        const r = await fetch("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: { Authorization: `Bearer ${voyageKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            input: [semantic],
            model: "voyage-3-large",
            input_type: "query",
            output_dimension: 1024,
          }),
        });
        if (!r.ok) {
          const t = await r.text();
          return JSON.stringify({ error: `Voyage embed failed: ${r.status} ${t.slice(0, 200)}` });
        }
        const data = await r.json();
        queryEmbedding = data.data?.[0]?.embedding ?? null;
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    }

    const topics = Array.isArray(input.topics) ? (input.topics as string[]) : null;
    const { data, error } = await supabase.rpc("search_journal_entries", {
      query_embedding: queryEmbedding,
      date_from: (input.date_from as string) ?? null,
      date_to: (input.date_to as string) ?? null,
      mood_filter: (input.mood as string) ?? null,
      topic_filters: topics && topics.length > 0 ? topics : null,
      result_limit: limit,
    });
    if (error) return JSON.stringify({ error: error.message });

    type JournalRow = {
      notion_page_id: string;
      entry_date: string;
      title: string | null;
      mood: string | null;
      source: string | null;
      topics: string[] | null;
      content_md: string | null;
      word_count: number | null;
      similarity: number | null;
    };

    const out = (data ?? []).map((r: JournalRow) => ({
      notion_page_id: r.notion_page_id,
      entry_date: r.entry_date,
      title: r.title,
      mood: r.mood,
      source: r.source,
      topics: r.topics,
      word_count: r.word_count,
      similarity: r.similarity != null ? Number(r.similarity.toFixed(4)) : undefined,
      snippet: (r.content_md ?? "").slice(0, 600),
      truncated: (r.content_md ?? "").length > 600,
    }));
    return JSON.stringify(out);
  }

  // Record a habit answer — Yes (default) or explicit No (tri-state,
  // 2026-06-11). Writes to both Supabase and Notion.
  if (name === "mark_habit_complete") {
    const habit = input.habit as string;
    const category = (input.category as string) || null;
    const answer = (input.answer as string)?.toLowerCase() === "no" ? "No" : "Yes";

    // Default to the behavioral day (TZ + awake-tail aware) — the previous
    // naive-UTC default tagged late-evening ET logs with TOMORROW's date.
    let date = input.date as string | undefined;
    if (!date) {
      try {
        const { data: bday } = await supabase.rpc("behavioral_today_now");
        date = (bday as string) || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      } catch {
        date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      }
    }

    // WHOOP-era rows (cycle_date <= 2026-06-08, the last WHOOP export) are a
    // frozen historical record carrying explicit Yes/No answers. A backdated
    // completion into that era would overwrite real history for WHOOP-derived
    // habits — reject it (post-merge guard, see sql/whoop_journal_merge.sql).
    const WHOOP_JOURNAL_FROZEN_THROUGH = "2026-06-08";
    const { data: mapRow } = await supabase
      .from("habit_name_map")
      .select("channel")
      .eq("habit_name", habit)
      .maybeSingle();
    const isWhoopChannel = mapRow?.channel === "whoop";
    if (isWhoopChannel && date <= WHOOP_JOURNAL_FROZEN_THROUGH) {
      return JSON.stringify({
        error: `"${habit}" has frozen historical entries through ${WHOOP_JOURNAL_FROZEN_THROUGH}; completions can only be logged for later dates.`,
      });
    }

    const { data, error } = await supabase
      .from("habit_journal")
      .upsert(
        {
          cycle_date: date,
          question: habit,
          category,
          answer,
          notes: answer === "Yes" ? "Completed via Claude chat" : "Marked not done via Claude chat",
        },
        { onConflict: "cycle_date,question" }
      )
      .select()
      .single();
    if (error) return JSON.stringify({ error: error.message });

    // Also update Notion "Last Completed"
    const notionKey = process.env.NOTION_API_KEY;
    const notionDb = process.env.NOTION_HABITS_DB || "29cc936fd5e14ae8b10a4fe5c5f7a6cd";
    if (notionKey) {
      try {
        const searchRes = await fetch(`https://api.notion.com/v1/databases/${notionDb}/query`, {
          method: "POST",
          headers: { Authorization: `Bearer ${notionKey}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
          body: JSON.stringify({ filter: { property: "Habit", title: { equals: habit } } }),
        });
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          if (searchData.results.length > 0) {
            // Recompute Last Completed from the actual max completion (mirrors
            // /api/habits/complete) — direct-setting the supplied date moved
            // LC BACKWARD on backdated logs. Yes-only, and post-freeze-era
            // for WHOOP-derived habits.
            let lcQuery = supabase
              .from("habit_journal")
              .select("cycle_date")
              .eq("question", habit)
              .eq("answer", "Yes")
              .order("cycle_date", { ascending: false })
              .limit(1);
            if (isWhoopChannel) {
              lcQuery = lcQuery.gt("cycle_date", WHOOP_JOURNAL_FROZEN_THROUGH);
            }
            const { data: latest } = await lcQuery;
            const latestDate = latest?.[0]?.cycle_date ?? null;
            await fetch(`https://api.notion.com/v1/pages/${searchData.results[0].id}`, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${notionKey}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
              body: JSON.stringify({ properties: { "Last Completed": { date: latestDate ? { start: latestDate } : null } } }),
            });
          }
        }
      } catch (e) {
        console.error("Notion sync from chat failed:", e);
      }
    }

    return JSON.stringify({ success: true, entry: data });
  }

  // Log a whole supplement stack (writes one intake per item)
  // ---- Reading quest tools (lib/reading.ts) ----
  if (name === "get_reading_status") {
    try {
      const o = await getOverview(supabase, (input.book as string) || null);
      if (!o) return JSON.stringify({ error: "No book in progress" });
      return JSON.stringify(summarizeForChat(o));
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : "failed" });
    }
  }

  if (name === "log_reading_session") {
    const result = await logSession(supabase, {
      slug: (input.book as string) || null,
      date: (input.date as string) || null,
      chapter_through: Number(input.chapter_through),
      chapter_from: input.chapter_from != null ? Number(input.chapter_from) : null,
      minutes: input.minutes != null ? Number(input.minutes) : null,
      medium: (input.medium as Medium) || null,
      recall: (input.recall as string) || null,
      question: (input.question as string) || null,
    });
    if (!result.ok) return JSON.stringify({ error: result.error });
    // Mirror inline (the chat loop has no after() boundary worth protecting).
    const blockId = await mirrorSession(result.book, result.session);
    if (blockId) await supabase.from("reading_sessions").update({ notion_block_id: blockId }).eq("session_id", result.session.session_id);
    const o = await getOverview(supabase, result.book.slug).catch(() => null);
    await mirrorProgress(result.book, o?.chaptersDone ?? result.session.chapter_through ?? 0, result.session.session_date);
    return JSON.stringify({
      success: true,
      xp_gained: result.xpGained,
      finished: result.finished,
      habit_marked: result.habitMarked,
      chapters_done: o?.chaptersDone,
      total_chapters: o?.totalChapters,
      pace: o?.pace,
      streak: o?.streak,
      level: o?.level,
      notion_mirrored: !!blockId,
    });
  }

  if (name === "add_book_highlight") {
    const result = await addHighlight(supabase, {
      slug: (input.book as string) || null,
      passage: String(input.passage ?? ""),
      comment: (input.comment as string) || null,
      chapter: input.chapter != null ? Number(input.chapter) : null,
      concept: (input.concept as string) || null,
      source: (input.source as HighlightSource) || null,
    });
    if (!result.ok) return JSON.stringify({ error: result.error });
    let mirrored = false;
    if (result.created) {
      const blockId = await mirrorHighlight(result.book, result.highlight);
      if (blockId) {
        await supabase.from("book_highlights").update({ notion_block_id: blockId }).eq("highlight_id", result.highlight.highlight_id);
        mirrored = true;
      }
    }
    return JSON.stringify({ success: true, created: result.created, highlight_id: result.highlight.highlight_id, next_review: result.highlight.next_review, notion_mirrored: mirrored });
  }

  if (name === "record_reading_quiz") {
    const result = await recordQuiz(supabase, {
      slug: (input.book as string) || null,
      checkpoint: String(input.checkpoint ?? ""),
      score: Number(input.score),
      total: Number(input.total),
      notes: (input.notes as string) || null,
    });
    if (!result.ok) return JSON.stringify({ error: result.error });
    return JSON.stringify({ success: true, passed: result.passed, score: `${result.quiz.score}/${result.quiz.total}`, checkpoint: result.quiz.checkpoint });
  }

  if (name === "log_supplement_stack") {
    const wanted = (input.stack as string)?.trim();
    if (!wanted) return JSON.stringify({ error: "stack name is required" });
    const date = (input.date as string) || undefined;

    // Resolve the stack by case-insensitive name among active stacks.
    const { data: candidates, error: lookupErr } = await supabase
      .from("supplement_stack")
      .select("stack_id,name")
      .eq("is_active", true);
    if (lookupErr) return JSON.stringify({ error: lookupErr.message });

    const lc = wanted.toLowerCase();
    const match =
      (candidates ?? []).find((s) => s.name.toLowerCase() === lc) ??
      (candidates ?? []).find((s) => s.name.toLowerCase().includes(lc));
    if (!match) {
      return JSON.stringify({
        error: `No stack named "${wanted}".`,
        available: (candidates ?? []).map((s) => s.name),
      });
    }

    const result = await logStackIntake(supabase, match.stack_id, { intake_date: date });
    if (!result.ok) return JSON.stringify({ error: result.error });
    return JSON.stringify({
      success: true,
      stack: result.stack_name,
      products: result.count,
      total_doses: result.total_doses,
      date: result.intake_date,
    });
  }

  // Handle timestamp-based tables
  if (name in timestampTables) {
    const { table, timeCol, extra } = timestampTables[name];
    let query = supabase.from(table).select("*").gte(timeCol, since.toISOString()).order(timeCol, { ascending: true }).limit(50);
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        query = query.eq(k, v);
      }
    }
    const { data, error } = await query;
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(tagCalorieSources(table, stripRawFields(data ?? [])));
  }

  // Handle calendar_date-based tables
  const table = calendarDateTables[name];
  if (!table) return JSON.stringify({ error: "Unknown tool" });

  const { data, error } = await supabase
    .from(table)
    .select("*")
    .gte("calendar_date", sinceStr)
    .order("calendar_date", { ascending: true })
    .limit(60);

  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify(tagCalorieSources(table, stripRawFields(data ?? [])));
}

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: "messages required" }, { status: 400 });
    }

    // Initial Claude call with tools
    let response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Agentic tool-use loop
    const allMessages = [...messages];

    while (response.stop_reason === "tool_use") {
      const assistantContent = response.content;
      allMessages.push({ role: "assistant", content: assistantContent });

      const toolResults = [];
      for (const block of assistantContent) {
        if (block.type === "tool_use") {
          const result = await executeTool(block.name, block.input as Record<string, unknown>);
          toolResults.push({
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      allMessages.push({ role: "user", content: toolResults });

      response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages: allMessages,
      });
    }

    // Extract final text
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return Response.json({ response: text });
  } catch (err) {
    console.error("Chat API error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
