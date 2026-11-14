// Focus habit unlock: the database reads and the one write, shared by /api/focus/config and
// /api/focus/unlock-status. Takes the service-role client as an argument so tests/focus-unlock.test.cjs
// can run it against a fake. Errors carry a short code only: no row data, no habit names.

import {
  buildUnlockStatus,
  configFromRow,
  type FocusUnlockConfig,
  type FocusUnlockStatus,
} from "@/lib/focus-unlock";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface FocusDb {
  from(table: string): any;
  rpc(fn: string): any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class FocusUnlockError extends Error {
  constructor(readonly step: "config" | "habit_names" | "behavioral_day" | "habit_answers" | "save") {
    super(`focus unlock: ${step} failed`);
  }
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The stored config, or the default (no habits, rule OR) when nothing has been saved yet. */
export async function readFocusConfig(db: FocusDb): Promise<FocusUnlockConfig> {
  const { data, error } = await db.from("focus_unlock_config").select("rule, habit_page_ids").eq("id", 1).maybeSingle();
  if (error) throw new FocusUnlockError("config");
  return configFromRow(data);
}

/** Chosen page id to the habit's current name. Ids the map does not know are simply absent. */
export async function resolveHabitNames(db: FocusDb, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!ids.length) return names;
  const { data, error } = await db.from("habit_name_map").select("notion_page_id, habit_name").in("notion_page_id", [...ids]);
  if (error) throw new FocusUnlockError("habit_names");
  for (const row of (data ?? []) as { notion_page_id: string; habit_name: string }[]) {
    if (row.notion_page_id && row.habit_name) names.set(row.notion_page_id, row.habit_name);
  }
  return names;
}

/**
 * Today's answer for the phone: the behavioral day, the rule, and each chosen habit's done flag
 * (a pds.habit_journal row with answer 'Yes' for that day). Reads the chosen habits only.
 */
export async function loadUnlockStatus(db: FocusDb): Promise<FocusUnlockStatus> {
  const config = await readFocusConfig(db);

  const { data: day, error: dayError } = await db.rpc("behavioral_today_now");
  if (dayError || !isDate(day)) throw new FocusUnlockError("behavioral_day");

  const names = await resolveHabitNames(db, config.habitPageIds);
  const wanted = [...names.values()];
  const yes = new Set<string>();
  if (wanted.length) {
    const { data, error } = await db
      .from("habit_journal")
      .select("question")
      .eq("cycle_date", day)
      .eq("answer", "Yes")
      .in("question", wanted);
    if (error) throw new FocusUnlockError("habit_answers");
    for (const row of (data ?? []) as { question: string }[]) yes.add(row.question);
  }
  return buildUnlockStatus({ behavioralDate: day, config, names, yes });
}

export type SaveResult = { ok: true; config: FocusUnlockConfig } | { ok: false; unknownIds: string[] };

/** Saves the config after checking that every chosen id is a habit Onyx knows. */
export async function saveFocusConfig(db: FocusDb, config: FocusUnlockConfig, now: Date = new Date()): Promise<SaveResult> {
  const names = await resolveHabitNames(db, config.habitPageIds);
  const unknownIds = config.habitPageIds.filter((id) => !names.has(id));
  if (unknownIds.length) return { ok: false, unknownIds };

  const { error } = await db
    .from("focus_unlock_config")
    .upsert({ id: 1, rule: config.rule, habit_page_ids: config.habitPageIds, updated_at: now.toISOString() }, { onConflict: "id" });
  if (error) throw new FocusUnlockError("save");
  return { ok: true, config };
}
