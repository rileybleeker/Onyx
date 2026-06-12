import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_HABITS_DB = process.env.NOTION_HABITS_DB || "29cc936fd5e14ae8b10a4fe5c5f7a6cd";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

/**
 * POST /api/habits/complete
 * Writes a habit journal answer to BOTH Supabase and Notion.
 * Body: { habit: string, date?: string, category?: string, notionPageId?: string,
 *         answer?: 'Yes' | 'No' | null, undo?: boolean }
 *
 * Tri-state semantics (2026-06-11): answer 'Yes'/'No' upserts an explicit row;
 * answer null DELETES the row (null = "not logged" — row absence is the
 * canonical null so the PK, the pipeline's missing=No fill, and the backfill
 * trigger all keep working unchanged). Back-compat: `undo: true` → null;
 * neither field present → 'Yes' (the original tap-to-complete contract).
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { habit, date, category, notionPageId, undo } = body;

  // Resolve the requested answer: explicit `answer` wins over legacy `undo`.
  let answer: "Yes" | "No" | null;
  if ("answer" in body) {
    const raw = body.answer;
    if (raw === null) {
      answer = null;
    } else if (typeof raw === "string" && ["yes", "no"].includes(raw.toLowerCase())) {
      answer = raw.toLowerCase() === "yes" ? "Yes" : "No";
    } else {
      return NextResponse.json(
        { error: `answer must be 'Yes', 'No', or null — got ${JSON.stringify(raw)}` },
        { status: 400 }
      );
    }
  } else {
    answer = undo ? null : "Yes";
  }
  // Default to Riley's CURRENT behavioral day via pds.behavioral_today_now()
  // — TZ-aware (handles travel) + awake-tail-aware (-6h rule). The previous
  // hardcoded ET default broke for westbound trips: 10 PM PDT in LA = 1 AM
  // EDT next day, so a habit tap defaulted to ET-tomorrow when Riley's
  // LA-today wasn't over yet. Falls back to ET-today if the RPC fails or
  // user_tz_log is empty.
  let completionDate = date;
  if (!completionDate) {
    try {
      const { data: bday } = await supabase.rpc("behavioral_today_now");
      completionDate = bday || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    } catch {
      completionDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }
  }

  if (!habit) {
    return NextResponse.json({ error: "habit is required" }, { status: 400 });
  }

  // 2026-06-11 merge guard: rows with cycle_date <= 2026-06-08 for
  // WHOOP-derived habits (habit_name_map.channel='whoop') are the frozen
  // WHOOP-journal historical record (explicit Yes/No answers). Writing or
  // deleting inside that era would corrupt real history — reject.
  const WHOOP_JOURNAL_FROZEN_THROUGH = "2026-06-08";
  const { data: mapRow } = await supabase
    .from("habit_name_map")
    .select("channel")
    .eq("habit_name", habit)
    .maybeSingle();
  const isWhoopChannel = mapRow?.channel === "whoop";
  if (isWhoopChannel && completionDate <= WHOOP_JOURNAL_FROZEN_THROUGH) {
    return NextResponse.json(
      { error: `"${habit}" has frozen WHOOP-journal history through ${WHOOP_JOURNAL_FROZEN_THROUGH}; completions can only be logged for later dates.` },
      { status: 400 }
    );
  }

  // 1. Write to Supabase
  if (answer === null) {
    const { error } = await supabase
      .from("habit_journal")
      .delete()
      .eq("question", habit)
      .eq("cycle_date", completionDate);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } else {
    const { error } = await supabase
      .from("habit_journal")
      .upsert(
        { cycle_date: completionDate, question: habit, category: category || null, answer },
        { onConflict: "cycle_date,question" }
      );
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // 2. Update Notion "Last Completed" date
  if (NOTION_API_KEY) {
    try {
      // Find the Notion page ID if not provided
      let pageId = notionPageId;
      if (!pageId) {
        const searchRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_HABITS_DB}/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${NOTION_API_KEY}`,
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
          },
          body: JSON.stringify({
            filter: { property: "Habit", title: { equals: habit } },
          }),
        });
        if (searchRes.ok) {
          const data = await searchRes.json();
          if (data.results.length > 0) pageId = data.results[0].id;
        }
      }

      if (pageId) {
        // Derive Notion's "Last Completed" from the actual max cycle_date in habit_journal
        // (so backdating or undoing doesn't overwrite a more recent completion).
        // Post-merge: only count actual completions (answer='Yes' — the table
        // now also carries explicit 'No' rows), and for WHOOP-derived habits
        // only the post-freeze era — pointing Notion LC at a frozen-era date
        // would make the hourly sync re-upsert over historical rows forever.
        let latestQuery = supabase
          .from("habit_journal")
          .select("cycle_date")
          .eq("question", habit)
          .eq("answer", "Yes")
          .order("cycle_date", { ascending: false })
          .limit(1);
        if (isWhoopChannel) {
          latestQuery = latestQuery.gt("cycle_date", WHOOP_JOURNAL_FROZEN_THROUGH);
        }
        const { data: latest } = await latestQuery;

        const latestDate = latest && latest.length > 0 ? latest[0].cycle_date : null;
        const notionDate = latestDate ? { start: latestDate } : null;

        await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${NOTION_API_KEY}`,
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
          },
          body: JSON.stringify({
            properties: {
              "Last Completed": { date: notionDate },
            },
          }),
        });
      }
    } catch (e) {
      console.error("Notion sync failed (Supabase still updated):", e);
    }
  }

  return NextResponse.json({ success: true, habit, date: completionDate, answer, undo: answer === null });
}
