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
 * Writes a habit completion to BOTH Supabase and Notion.
 * Body: { habit: string, date?: string, category?: string, notionPageId?: string, undo?: boolean }
 */
export async function POST(req: NextRequest) {
  const { habit, date, category, notionPageId, undo } = await req.json();
  // Default to ET today, NOT UTC today. A habit tap at 21:00 ET is 01:00 UTC
  // the next day — the old `new Date().toISOString().split("T")[0]` would
  // silently file tomorrow's row. Per ADR-0001 D6, calendar attribution uses
  // America/New_York; en-CA gives the ISO YYYY-MM-DD format we need for the
  // DATE column. Phase 1 of ADR-0001 will additionally populate
  // onyx_behavioral_date via the WHOOP cycle anchor (handling the awake-tail
  // 00:00–04:00 ET case).
  const completionDate = date || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  if (!habit) {
    return NextResponse.json({ error: "habit is required" }, { status: 400 });
  }

  // 1. Write to Supabase
  if (undo) {
    await supabase
      .from("habit_journal")
      .delete()
      .eq("question", habit)
      .eq("cycle_date", completionDate);
  } else {
    const { error } = await supabase
      .from("habit_journal")
      .upsert(
        { cycle_date: completionDate, question: habit, category: category || null, answer: "Yes" },
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
        const { data: latest } = await supabase
          .from("habit_journal")
          .select("cycle_date")
          .eq("question", habit)
          .order("cycle_date", { ascending: false })
          .limit(1);

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

  return NextResponse.json({ success: true, habit, date: completionDate, undo: !!undo });
}
