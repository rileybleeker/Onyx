import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

const SYSTEM_PROMPT = `You are Onyx, a personal data scientist assistant. You help the user understand their health and fitness data from three devices: Garmin watch, WHOOP band, and Eight Sleep mattress.

You have access to the user's data via function calls. When the user asks about their health metrics, use the appropriate function to fetch real data before answering. You can call multiple tools to cross-reference data across devices. Be concise and insightful — highlight trends, anomalies, and actionable takeaways.

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
    name: "query_health_matrix",
    description: "Get the unified daily health matrix view that combines data from all three devices (Garmin, WHOOP, Eight Sleep) into a single row per day. Best for cross-device comparisons.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
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
    query_health_matrix: "daily_health_matrix",
  };

  // Tables queried by timestamp columns
  const timestampTables: Record<string, { table: string; timeCol: string; extra?: Record<string, unknown> }> = {
    query_activities: { table: "garmin_activities", timeCol: "start_time_local" },
    query_whoop_cycles: { table: "whoop_cycles", timeCol: "start_time" },
    query_whoop_recovery: { table: "whoop_recovery", timeCol: "created_at", extra: { score_state: "SCORED" } },
    query_whoop_sleep: { table: "whoop_sleep", timeCol: "start_time", extra: { is_nap: false, score_state: "SCORED" } },
    query_whoop_workouts: { table: "whoop_workouts", timeCol: "start_time" },
  };

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
