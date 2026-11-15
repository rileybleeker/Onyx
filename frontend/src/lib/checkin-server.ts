// Server-only helpers shared by the check-in routes (GET/POST /api/habits/checkin and POST
// /api/habits/checkin/voice): behavioral today, the date window, and the active question list.
import { createClient } from "@supabase/supabase-js";
import { fetchActiveHabitsCached, type NotionHabit } from "@/lib/habits-notion";
import { addDays, CHECKIN_MAX_DAYS_BACK, fallbackBehavioralToday, groupFor, SLEEP_QUESTIONS, type CheckinItem } from "@/lib/checkin";

export const WHOOP_JOURNAL_FROZEN_THROUGH = "2026-06-08";

export const checkinSupabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function behavioralToday(): Promise<string> {
  try {
    const { data } = await checkinSupabase.rpc("behavioral_today_now");
    if (data) return data as string;
  } catch {
    /* fall through */
  }
  return fallbackBehavioralToday(new Date());
}

export function dateError(date: string, today: string): string | null {
  if (date > today) return "That day hasn't happened yet.";
  if (date < addDays(today, -CHECKIN_MAX_DAYS_BACK)) return `The check-in only covers today and the ${CHECKIN_MAX_DAYS_BACK} days before.`;
  if (date <= WHOOP_JOURNAL_FROZEN_THROUGH) return "That day is in the frozen WHOOP era.";
  return null;
}

/**
 * The active questions. The habit list comes from the shared Notion cache (lib/habits-notion.ts: usually under an
 * hour old, never over 3 hours), so the check-in screen does not wait on Notion; the channel comes live from
 * habit_name_map. Notion "Last Completed" writes must not use `habits` from here (fetchActiveHabits() is fresh).
 */
export async function loadItems(): Promise<{ items: CheckinItem[]; habits: NotionHabit[] }> {
  const [habits, channel] = await Promise.all([fetchActiveHabitsCached(), loadChannels()]);
  return { items: toItems(habits, channel), habits };
}

/** habit_name_map: which questions are WHOOP-derived (their group and Notion rules differ). */
export async function loadChannels(): Promise<Map<string, string>> {
  const { data: map } = await checkinSupabase.from("habit_name_map").select("habit_name, channel");
  return new Map((map ?? []).map((r: { habit_name: string; channel: string }) => [r.habit_name, r.channel]));
}

export function toItems(habits: NotionHabit[], channel: Map<string, string>): CheckinItem[] {
  return habits
    .filter((h) => h.name)
    .map((h): CheckinItem => {
      const ch = channel.get(h.name) === "whoop" ? "whoop" : "habit";
      return {
        name: h.name,
        notionPageId: h.id,
        category: h.category,
        frequency: h.frequency,
        channel: ch,
        group: groupFor(h.name, ch, h.frequency),
        sleep: SLEEP_QUESTIONS.has(h.name),
      };
    });
}
