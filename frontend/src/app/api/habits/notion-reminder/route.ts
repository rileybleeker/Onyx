import { NextRequest, NextResponse } from "next/server";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_REMINDERS_DB = process.env.NOTION_REMINDERS_DB || "4fed4ed5c90e4ca3897dac5337eb91ac";

const FREQUENCY_TO_RECURRENCE: Record<string, string> = {
  daily: "daily",
  weekdays: "weekdays",
  weekly: "weekly",
};

const CATEGORY_MAP: Record<string, string> = {
  health: "health",
  fitness: "health",
  mindfulness: "health",
  nutrition: "health",
  productivity: "work",
  learning: "work",
  social: "social",
  general: "personal",
};

export async function POST(req: NextRequest) {
  if (!NOTION_API_KEY) {
    return NextResponse.json({ error: "NOTION_API_KEY not configured" }, { status: 500 });
  }

  const { habitId, name, category, frequency } = await req.json();

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const today = new Date().toISOString().split("T")[0];

  const body = {
    parent: { database_id: NOTION_REMINDERS_DB },
    properties: {
      Reminder: {
        title: [{ text: { content: `[Habit] ${name}` } }],
      },
      Status: {
        select: { name: "pending" },
      },
      Priority: {
        select: { name: "medium" },
      },
      Category: {
        multi_select: [{ name: CATEGORY_MAP[category] || "personal" }],
      },
      Recurrence: {
        select: { name: FREQUENCY_TO_RECURRENCE[frequency] || "daily" },
      },
      "Due Date": {
        date: { start: today },
      },
      "Created Via": {
        select: { name: "notion" },
      },
      Notes: {
        rich_text: [{ text: { content: `Auto-created by Onyx habit tracker. Habit ID: ${habitId}` } }],
      },
    },
  };

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Notion API error:", text);
    return NextResponse.json({ error: "Failed to create Notion reminder" }, { status: 500 });
  }

  const data = await res.json();
  return NextResponse.json({ notionPageId: data.id });
}
