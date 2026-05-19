import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { searchTracks, createPlaylist } from "@/lib/spotify-server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

const SYSTEM_PROMPT = `You are Onyx, a personal data scientist assistant. You help the user understand their health and fitness data from three devices: Garmin watch, WHOOP band, and Eight Sleep mattress. You also help them track daily habits.

You have access to the user's data via function calls. When the user asks about their health metrics, use the appropriate function to fetch real data before answering. You can call multiple tools to cross-reference data across devices. Be concise and insightful — highlight trends, anomalies, and actionable takeaways.

When the user mentions completing a habit (e.g., "I meditated today", "I took my vitamins"), use mark_habit_complete to log it. The habit name should match what's defined in their habits list. Use query_journal to see both WHOOP journal behaviors and habit completions together.

The user also keeps a free-form *personal* journal in Notion (prose entries about life, mood, relationships, training, mental health). Use query_journal_entries when they ask about what they wrote, how they were feeling, or to find context behind biometric trends — combine it with biometric tools to answer questions like "what was my HRV on days I logged a 'low' mood?". When a question is thematic rather than date-specific, set semantic_query to do similarity search.

You can also create Spotify playlists. The user has private-playlist write access enabled. When asked to make a playlist:
- Use query_spotify_tracks_by_features to pick tracks from their listening history (filter by audio-feature ranges like valence, energy, tempo).
- Use search_spotify_catalog when they want tracks they haven't listened to before, or when filling out a playlist beyond what their history covers.
- Once you have track IDs (mix sources freely), call create_spotify_playlist directly — playlists are private and easily deleted, so don't ask for confirmation.
- Default to ~25–40 tracks unless the user specifies otherwise. Give the playlist a descriptive name that reflects the user's request.

Format numbers clearly. Use relative comparisons (e.g., "your HRV is 15% above your weekly average"). When comparing across devices, note any discrepancies. When you don't have enough data, say so.`;

const tools: Anthropic.Tool[] = [
  {
    name: "query_daily_summary",
    description: "Get daily summary stats (steps, calories, heart rate, stress, body battery, SpO2) for a date range. Use this for general health questions.",
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
    description: "Get WHOOP daily cycle data including strain, kilojoules, average and max heart rate.",
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
    name: "query_whoop_journal",
    description: "Get WHOOP Journal entries — self-reported behaviors like caffeine, alcohol, supplements, sleep habits, recovery activities, and more. Each entry has a date, question/behavior name, category, and answer (Yes/No or a value).",
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
    description: "Get the unified journal view combining both WHOOP journal behaviors AND habit completions. Each entry has a date, question/behavior name, category, answer, and source ('whoop' or 'habit'). Use this for cross-analysis of habits and self-reported behaviors.",
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
    description: "Mark a habit as completed for a given date. The habit name must match one defined in the user's Notion Habits database (e.g., 'Meditated', 'Exercised', 'Read'). Defaults to today.",
    input_schema: {
      type: "object" as const,
      properties: {
        habit: { type: "string", description: "The habit name exactly as defined in Notion (e.g., 'Meditated', 'Exercised')" },
        date: { type: "string", description: "Date in YYYY-MM-DD format (defaults to today)" },
        category: { type: "string", description: "Optional: habit category (e.g., 'mindfulness', 'fitness')" },
      },
      required: ["habit"],
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
    description: "Search the user's personal Notion journal (free-form prose entries about their life — relationships, mental health, work, training, etc., distinct from the WHOOP/habit behavior journal). Use this when the user asks about how they were feeling, what they wrote about, or to find context behind health data. Supports filters and optional semantic search via 'semantic_query'. Returns entries sorted by similarity (when semantic_query given) or by date desc.",
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
];

function stripRawFields(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const { raw_json, raw_hr_values, raw_stress_values, raw_hrv_readings, ...rest } = row;
    void raw_json; void raw_hr_values; void raw_stress_values; void raw_hrv_readings;
    return rest;
  });
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

  // Handle whoop journal (special: calendar_date + optional filters)
  if (name === "query_whoop_journal") {
    const journalDays = (input.days as number) || 30;
    const jSince = new Date();
    jSince.setDate(jSince.getDate() - journalDays);
    let query = supabase.from("whoop_journal").select("*")
      .gte("cycle_date", jSince.toISOString().split("T")[0])
      .order("cycle_date", { ascending: true })
      .limit(200);
    if (input.question) query = query.ilike("question", `%${input.question}%`);
    if (input.category) query = query.ilike("category", `%${input.category}%`);
    const { data, error } = await query;
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Unified journal view (WHOOP + habits)
  if (name === "query_journal") {
    const journalDays = (input.days as number) || 30;
    const jSince = new Date();
    jSince.setDate(jSince.getDate() - journalDays);
    let query = supabase.from("journal").select("*")
      .gte("cycle_date", jSince.toISOString().split("T")[0])
      .order("cycle_date", { ascending: true })
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

  // Mark a habit as complete (writes to both Supabase and Notion)
  if (name === "mark_habit_complete") {
    const habit = input.habit as string;
    const date = (input.date as string) || new Date().toISOString().split("T")[0];
    const category = (input.category as string) || null;
    const { data, error } = await supabase
      .from("habit_journal")
      .upsert(
        { cycle_date: date, question: habit, category, answer: "Yes", notes: "Completed via Claude chat" },
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
            await fetch(`https://api.notion.com/v1/pages/${searchData.results[0].id}`, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${notionKey}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
              body: JSON.stringify({ properties: { "Last Completed": { date: { start: date } } } }),
            });
          }
        }
      } catch (e) {
        console.error("Notion sync from chat failed:", e);
      }
    }

    return JSON.stringify({ success: true, entry: data });
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
    return JSON.stringify(stripRawFields(data ?? []));
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
  return JSON.stringify(stripRawFields(data ?? []));
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
