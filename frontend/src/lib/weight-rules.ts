// Pure rules of the self-saving weight entry (lib/weight-entry.ts). No React, no imports at runtime: tested in
// tests/autosave-forms.test.cjs.

export type WeightEntry = { day: string; lb: string; notes?: string };

const LB_PER_KG = 2.20462262185;

const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
export const etToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Pounds to save, or why the entry can't be saved yet. */
export function parseLb(input: string): number | string {
  const lb = parseFloat(input);
  if (!input.trim() || !Number.isFinite(lb) || lb <= 0 || lb > 1000) return "Enter a weight in pounds between 0 and 1000.";
  return lb;
}

/** Why an entry can't be saved yet (null = it can). */
export function weightNotReady(v: WeightEntry, today = etToday()): string | null {
  const lb = parseLb(v.lb);
  if (typeof lb === "string") return lb;
  if (!isYmd(v.day) || v.day > today) return "Pick today or an earlier day.";
  return null;
}

/** Delay before saving a typed value: longer when it is far from the last weigh-in (maybe still mid-number). */
export function weightDelayMs(lbText: string, lastKg: number | null): number {
  const lb = parseFloat(lbText);
  const ref = lastKg == null ? null : Number(lastKg) * LB_PER_KG;
  if (!ref) return 1000;
  return Number.isFinite(lb) && lb >= ref * 0.7 && lb <= ref * 1.3 ? 1000 : 4000;
}

