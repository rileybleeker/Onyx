import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_HABITS_DB = process.env.NOTION_HABITS_DB || "29cc936fd5e14ae8b10a4fe5c5f7a6cd";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

/**
 * POST /api/habits/sync
 * Reads "Last Completed" dates from the Notion Habits DB and upserts
 * matching entries into pds.habit_journal. Returns which habits were synced.
 */
export async function POST() {
  if (!NOTION_API_KEY) {
    return NextResponse.json({ error: "NOTION_API_KEY not configured" }, { status: 500 });
  }

  // Fetch all active habits with a Last Completed date
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_HABITS_DB}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      filter: {
        and: [
          { property: "Active", checkbox: { equals: true } },
          { property: "Last Completed", date: { is_not_empty: true } },
        ],
      },
    }),
  });

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to query Notion" }, { status: 500 });
  }

  const data = await res.json();
  const synced: string[] = [];

  /* eslint-disable @typescript-eslint/no-explicit-any */
  for (const page of data.results) {
    const name = page.properties.Habit?.title?.[0]?.plain_text;
    const category = page.properties.Category?.select?.name || null;
    const lastCompleted = page.properties["Last Completed"]?.date?.start;

    if (!name || !lastCompleted) continue;

    const { error } = await supabase
      .from("habit_journal")
      .upsert(
        {
          cycle_date: lastCompleted,
          question: name,
          category,
          answer: "Yes",
          notes: "Completed via Notion",
        },
        { onConflict: "cycle_date,question" }
      );

    if (!error) synced.push(`${name} (${lastCompleted})`);
  }

  return NextResponse.json({ synced, count: synced.length });
}
