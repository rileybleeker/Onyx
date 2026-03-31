import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_HABITS_DB = process.env.NOTION_HABITS_DB || "29cc936fd5e14ae8b10a4fe5c5f7a6cd";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/habits/sync
 * 1. Detects renamed habits (via habit_name_map) and updates old entries in habit_journal
 * 2. Syncs "Last Completed" dates from Notion into habit_journal
 * 3. Updates the name map for future rename detection
 */
export async function POST() {
  if (!NOTION_API_KEY) {
    return NextResponse.json({ error: "NOTION_API_KEY not configured" }, { status: 500 });
  }

  // Fetch ALL active habits (not just ones with Last Completed)
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_HABITS_DB}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      filter: { property: "Active", checkbox: { equals: true } },
    }),
  });

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to query Notion" }, { status: 500 });
  }

  const data = await res.json();
  const synced: string[] = [];
  const renamed: string[] = [];

  // Load existing name map
  const { data: nameMap } = await supabase.from("habit_name_map").select("*");
  const mapByPageId = new Map<string, string>();
  (nameMap || []).forEach((row: any) => mapByPageId.set(row.notion_page_id, row.habit_name));

  for (const page of data.results) {
    const pageId = page.id;
    const name = page.properties.Habit?.title?.[0]?.plain_text;
    const category = page.properties.Category?.select?.name || null;
    const lastCompleted = page.properties["Last Completed"]?.date?.start;

    if (!name) continue;

    // Check for rename
    const oldName = mapByPageId.get(pageId);
    if (oldName && oldName !== name) {
      // Rename detected — update all old entries in habit_journal
      const { count } = await supabase
        .from("habit_journal")
        .update({ question: name, category })
        .eq("question", oldName);
      renamed.push(`"${oldName}" → "${name}" (${count ?? 0} entries updated)`);
    }

    // Update name map
    await supabase
      .from("habit_name_map")
      .upsert(
        { notion_page_id: pageId, habit_name: name, updated_at: new Date().toISOString() },
        { onConflict: "notion_page_id" }
      );

    // Sync Last Completed to habit_journal
    if (lastCompleted) {
      const { error } = await supabase
        .from("habit_journal")
        .upsert(
          { cycle_date: lastCompleted, question: name, category, answer: "Yes", notes: "Completed via Notion" },
          { onConflict: "cycle_date,question" }
        );
      if (!error) synced.push(`${name} (${lastCompleted})`);
    }
  }

  return NextResponse.json({ synced, renamed, count: synced.length });
}
