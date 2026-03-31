import { NextResponse } from "next/server";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_HABITS_DB = process.env.NOTION_HABITS_DB || "29cc936fd5e14ae8b10a4fe5c5f7a6cd";

export interface NotionHabit {
  id: string;
  name: string;
  category: string;
  frequency: string;
  active: boolean;
  lastCompleted: string | null;
}

export async function GET() {
  if (!NOTION_API_KEY) {
    return NextResponse.json({ error: "NOTION_API_KEY not configured" }, { status: 500 });
  }

  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_HABITS_DB}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      filter: {
        property: "Active",
        checkbox: { equals: true },
      },
      sorts: [{ property: "Habit ID", direction: "ascending" }],
    }),
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Notion query error:", text);
    return NextResponse.json({ error: "Failed to fetch habits from Notion" }, { status: 500 });
  }

  const data = await res.json();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const habits: NotionHabit[] = data.results.map((page: any) => ({
    id: page.id,
    name: page.properties.Habit?.title?.[0]?.plain_text || "",
    category: page.properties.Category?.select?.name || "general",
    frequency: page.properties.Frequency?.select?.name || "daily",
    active: page.properties.Active?.checkbox ?? false,
    lastCompleted: page.properties["Last Completed"]?.date?.start || null,
  }));

  return NextResponse.json({ habits });
}
