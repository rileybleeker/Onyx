import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

const SYSTEM_PROMPT = `You are Onyx, a personal data scientist assistant. You help the user understand their health and fitness data from Garmin.

You have access to the user's data via function calls. When the user asks about their health metrics, use the appropriate function to fetch real data before answering. Be concise and insightful — highlight trends, anomalies, and actionable takeaways.

Format numbers clearly. Use relative comparisons (e.g., "your HRV is 15% above your weekly average"). When you don't have enough data, say so.`;

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
];

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const days = (input.days as number) || 7;
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  const tableMap: Record<string, string> = {
    query_daily_summary: "garmin_daily_summary",
    query_sleep: "garmin_sleep",
    query_hrv: "garmin_hrv",
    query_stress: "garmin_stress",
    query_training_status: "garmin_training_status",
  };

  if (name === "query_activities") {
    const { data, error } = await supabase
      .from("garmin_activities")
      .select("activity_type,activity_name,start_time_local,duration_seconds,distance_meters,avg_speed_mps,avg_heart_rate,max_heart_rate,calories,aerobic_training_effect,anaerobic_training_effect,vo2_max,elevation_gain_meters,training_load")
      .gte("start_time_local", since.toISOString())
      .order("start_time_local", { ascending: false })
      .limit(50);
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data);
  }

  const table = tableMap[name];
  if (!table) return JSON.stringify({ error: "Unknown tool" });

  // Select relevant columns (exclude raw_json to keep token count down)
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .gte("calendar_date", sinceStr)
    .order("calendar_date", { ascending: true })
    .limit(60);

  if (error) return JSON.stringify({ error: error.message });

  // Strip raw_json fields to save tokens
  const cleaned = (data ?? []).map((row: Record<string, unknown>) => {
    const { raw_json, raw_hr_values, raw_stress_values, raw_hrv_readings, ...rest } = row;
    void raw_json; void raw_hr_values; void raw_stress_values; void raw_hrv_readings;
    return rest;
  });

  return JSON.stringify(cleaned);
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
