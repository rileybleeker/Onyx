"use client";

import { useCallback, useRef, useState } from "react";
import { saveRequest } from "@/lib/autosave";
import { lbToKg } from "@/lib/format";
import { useAutosave } from "@/lib/use-autosave";
import { etToday, parseLb, weightDelayMs, weightNotReady, type WeightEntry } from "@/lib/weight-rules";

export { etToday, parseLb, weightDelayMs, weightNotReady, type WeightEntry };

/**
 * Weight entry that saves itself (2026-11-15), used by the /log Weight section (the one weight form since #331).
 * Same route and rules as before: POST /api/weight upserts one row per ET calendar day (a manual entry then owns
 * the day), 0 to 1000 lb, no day after today.
 *  - Typing saves 1 s after the last keystroke, or 4 s when the number is far (over 30 %) from the last weigh-in
 *    (a half-typed "18" on the way to "185"); Enter, leaving the field and hiding the page save at once.
 *  - Later edits replace the same day's row. Moving the day after a save MOVES the entry: the earlier day gets
 *    back what it had before this form wrote it (a manual row its old value and note; a Tanita or empty day is
 *    cleared, and the next scale run writes the Tanita reading back).
 *  - Undo does the same for the day the form wrote. An emptied field saves nothing (it never removes a weight).
 */

export interface StoredWeight {
  log_date: string;
  weight_kg: number;
  notes: string | null;
  logged_at: string;
  source: "manual" | "tanita";
}
type Prior = StoredWeight | null;

/** Put a day back the way it was before this form wrote it. */
export async function restoreWeightDay(day: string, prior: Prior, keepalive = false): Promise<StoredWeight | null> {
  if (prior && prior.source === "manual") {
    const row = await saveRequest("/api/weight", {
      method: "POST",
      body: { log_date: day, weight_kg: Number(prior.weight_kg), ...(prior.notes ? { notes: prior.notes } : {}) },
      keepalive,
    });
    return row as unknown as StoredWeight;
  }
  await saveRequest(`/api/weight?log_date=${encodeURIComponent(day)}`, { method: "DELETE", keepalive });
  return null;
}

/** How many days before ET today `day` is (0 = today). */
function daysBack(day: string, today = etToday()): number {
  return Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000);
}

/** What a day holds now: from the rows on screen when they cover it, else one read of the server. */
async function priorRow(day: string, rows: StoredWeight[], coversDays: number): Promise<Prior> {
  const back = daysBack(day);
  if (back < coversDays) return rows.find((r) => r.log_date === day) ?? null;
  const res = await fetch(`/api/weight?days=${Math.min(back + 1, 3650)}`);
  if (!res.ok) throw new Error(`Couldn't read that day's weight (${res.status}).`);
  const json = (await res.json()) as { rows?: StoredWeight[] };
  return (json.rows ?? []).find((r) => r.log_date === day) ?? null;
}

export function useWeightAutosave(
  name: string,
  opts: {
    /** The rows on screen now (what a day held before the first write is read from here). */
    rows: () => StoredWeight[];
    /** How many days back (from ET today) `rows` covers; an older day's row is read from the server first. */
    coversDays: () => number;
    /** A day's stored row changed (null = removed). */
    onRow: (day: string, row: StoredWeight | null) => void;
    /** After every successful save. */
    onSaved?: () => void;
  },
) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const priors = useRef(new Map<string, Prior>());
  const [written, setWritten] = useState<{ day: string; lb: number } | null>(null);
  const writtenRef = useRef(written);
  const [undoing, setUndoing] = useState(false);

  const setW = (w: { day: string; lb: number } | null) => {
    writtenRef.current = w;
    setWritten(w);
  };

  const saver = useAutosave<WeightEntry>(name, {
    delayMs: 1000,
    ready: (v) => weightNotReady(v),
    save: async (v, { keepalive }) => {
      const lb = parseLb(v.lb) as number;
      const prev = writtenRef.current;
      if (prev && prev.day !== v.day) {
        const restored = await restoreWeightDay(prev.day, priors.current.get(prev.day) ?? null, keepalive);
        priors.current.delete(prev.day);
        setW(null);
        optsRef.current.onRow(prev.day, restored);
      }
      if (!priors.current.has(v.day)) priors.current.set(v.day, await priorRow(v.day, optsRef.current.rows(), optsRef.current.coversDays()));
      const notes = v.notes?.trim();
      const json = (await saveRequest("/api/weight", {
        method: "POST",
        body: { log_date: v.day, weight_kg: lbToKg(lb), ...(notes ? { notes } : {}) },
        keepalive,
      })) as Partial<StoredWeight>;
      setW({ day: v.day, lb });
      if (json.log_date && typeof json.weight_kg === "number") optsRef.current.onRow(json.log_date, json as StoredWeight);
      optsRef.current.onSaved?.();
    },
  });

  /** Every change of the fields goes through here. */
  const edit = useCallback(
    (next: WeightEntry) => {
      if (!next.lb.trim()) {
        saver.reset();
        return;
      }
      const rows = optsRef.current.rows();
      saver.change(next, { delayMs: weightDelayMs(next.lb, rows.length ? rows[rows.length - 1].weight_kg : null) });
    },
    [saver],
  );

  /** Undo the form's entry. Returns an error message, or null when the day is back to what it was. */
  const undo = useCallback(async (): Promise<string | null> => {
    if (!writtenRef.current) return null;
    setUndoing(true);
    try {
      await saver.flush();
      const cur = writtenRef.current;
      if (cur) {
        const restored = await restoreWeightDay(cur.day, priors.current.get(cur.day) ?? null);
        priors.current.delete(cur.day);
        optsRef.current.onRow(cur.day, restored);
      }
      setW(null);
      saver.reset();
      return null;
    } catch (e) {
      return `Couldn't undo: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      setUndoing(false);
    }
  }, [saver]);

  /** The row a day held before this form wrote it (undefined = not written by this form). */
  const priorOf = useCallback((day: string): Prior | undefined => priors.current.get(day), []);

  return { saver, written, edit, undo, undoing, priorOf };
}
