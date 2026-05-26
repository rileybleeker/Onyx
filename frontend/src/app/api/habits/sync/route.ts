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
 * 3. Diffs Frequency / Category against habit_metadata_history; closes prior
 *    open interval + opens a new one when either changes. Seeds an initial
 *    open interval on first sight of a habit (valid_from = earliest
 *    cycle_date for that habit, or today if no completions).
 * 4. Updates the name map for future rename detection
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
  const metadataChanged: string[] = [];

  // Load existing name map
  const { data: nameMap } = await supabase.from("habit_name_map").select("*");
  const mapByPageId = new Map<string, string>();
  (nameMap || []).forEach((row: any) => mapByPageId.set(row.notion_page_id, row.habit_name));

  // Today (ET) — used as the boundary when closing/opening intervals
  const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  for (const page of data.results) {
    const pageId = page.id;
    const name = page.properties.Habit?.title?.[0]?.plain_text;
    const category = page.properties.Category?.select?.name || null;
    const frequency = page.properties.Frequency?.select?.name || "daily";
    const lastCompleted = page.properties["Last Completed"]?.date?.start;

    if (!name) continue;

    // Check for rename
    const oldName = mapByPageId.get(pageId);
    if (oldName && oldName !== name) {
      const { count } = await supabase
        .from("habit_journal")
        .update({ question: name, category })
        .eq("question", oldName);
      renamed.push(`"${oldName}" → "${name}" (${count ?? 0} entries updated)`);
    }

    await supabase
      .from("habit_name_map")
      .upsert(
        { notion_page_id: pageId, habit_name: name, updated_at: new Date().toISOString() },
        { onConflict: "notion_page_id" }
      );

    // Metadata-history diff. Pre-2026-05-25 habits won't have an open
    // interval yet — seed one with valid_from = earliest completion date
    // we have for this habit (or today if none). Changes after that point
    // close the prior interval at today−1 and open a new one at today.
    const { data: openRows } = await supabase
      .from("habit_metadata_history")
      .select("valid_from,frequency,category")
      .eq("notion_page_id", pageId)
      .is("valid_to", null)
      .limit(1);
    const open = openRows?.[0];

    if (!open) {
      // First sight — seed initial open interval. Earliest completion is
      // looked up by name (matches the habit_journal join key).
      const { data: firstRow } = await supabase
        .from("habit_journal")
        .select("cycle_date")
        .eq("question", name)
        .order("cycle_date", { ascending: true })
        .limit(1);
      const seedFrom = firstRow?.[0]?.cycle_date || todayET;

      await supabase.from("habit_metadata_history").insert({
        notion_page_id: pageId,
        valid_from: seedFrom,
        valid_to: null,
        frequency,
        category,
      });
    } else if (open.frequency !== frequency || (open.category || null) !== (category || null)) {
      // Metadata changed — close prior, open new. Skip if the prior open
      // interval started today (no-op rather than zero-length interval).
      if (open.valid_from === todayET) {
        // Same-day change → just overwrite the prior row's values rather
        // than creating a zero-length closed interval before it.
        await supabase
          .from("habit_metadata_history")
          .update({ frequency, category, captured_at: new Date().toISOString() })
          .eq("notion_page_id", pageId)
          .eq("valid_from", open.valid_from);
      } else {
        const yesterdayET = new Date(todayET + "T12:00:00");
        yesterdayET.setUTCDate(yesterdayET.getUTCDate() - 1);
        const closeAt = yesterdayET.toISOString().slice(0, 10);

        await supabase
          .from("habit_metadata_history")
          .update({ valid_to: closeAt })
          .eq("notion_page_id", pageId)
          .is("valid_to", null);

        await supabase.from("habit_metadata_history").insert({
          notion_page_id: pageId,
          valid_from: todayET,
          valid_to: null,
          frequency,
          category,
        });
      }
      metadataChanged.push(
        `${name}: ${open.frequency}/${open.category ?? "—"} → ${frequency}/${category ?? "—"}`
      );
    }

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

  return NextResponse.json({ synced, renamed, metadataChanged, count: synced.length });
}
