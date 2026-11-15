// Server-only: active habit definitions from the Notion Habits DB (source of truth for which habits exist).
// Shared by /api/habits/list (the /habits page) and /api/habits/checkin (the daily check-in screen).
import { swrCache } from "@/lib/swr-cache";

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

export class NotionHabitsError extends Error {
  constructor(message: string, readonly status: number, readonly detail: string) {
    super(message);
  }
}

export async function fetchActiveHabits(): Promise<NotionHabit[]> {
  if (!NOTION_API_KEY) throw new NotionHabitsError("NOTION_API_KEY not configured", 500, "");

  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_HABITS_DB}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      filter: { property: "Active", checkbox: { equals: true } },
      sorts: [{ property: "Habit ID", direction: "ascending" }],
    }),
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Notion query error:", res.status, text);
    throw new NotionHabitsError("Failed to fetch habits from Notion", res.status, text);
  }

  const data = await res.json();
  return (data.results as NotionPage[]).map(parseHabitPage);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type NotionPage = { id: string; properties: Record<string, any> };

/** One Notion Habits page as a NotionHabit. Shared with POST /api/habits/sync so both read a page the same way. */
export function parseHabitPage(page: NotionPage): NotionHabit {
  return {
    id: page.id,
    name: page.properties.Habit?.title?.[0]?.plain_text || "",
    category: page.properties.Category?.select?.name || "general",
    frequency: page.properties.Frequency?.select?.name || "daily",
    active: page.properties.Active?.checkbox ?? false,
    lastCompleted: page.properties["Last Completed"]?.date?.start || null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Pure: do two habit lists define the same questions (id, name, category, frequency, active)? Order and
 * `lastCompleted` are ignored: Last Completed moves every day and is not part of the definition.
 */
export function sameHabitDefinitions(a: NotionHabit[], b: NotionHabit[]): boolean {
  const key = (h: NotionHabit) => JSON.stringify([h.id, h.name, h.category, h.frequency, h.active]);
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
}

/**
 * The same list through a shared stale-while-revalidate cache (lib/swr-cache.ts), for request paths that only need
 * WHICH habits exist (name, id, category, frequency): /api/habits/list and the check-in screen. A Notion query costs
 * 0.3-0.5 s and the definitions change a few times a month, so readers get the cached list (refreshed in the
 * background once it is a minute old; POST /api/habits/sync, hourly and on every /habits visit, keeps it warm) and a
 * list older than 3 hours is never served; the sync also drops the cached list as soon as it sees the definitions
 * change. `lastCompleted` in it may be that old: anything that decides a Notion "Last Completed" write must call
 * fetchActiveHabits() instead.
 */
export const HABITS_CACHE_TAG = "notion-active-habits";
export const fetchActiveHabitsCached = swrCache("notion-active-habits-v1", fetchActiveHabits, {
  revalidateSeconds: 60,
  maxAgeMs: 3 * 60 * 60 * 1000,
  // POST /api/habits/sync reads Notion fresh every hour and drops this entry when the definitions changed
  // (sameHabitDefinitions), so a renamed, added or deactivated habit reaches the check-in within the hour.
  tag: HABITS_CACHE_TAG,
});
