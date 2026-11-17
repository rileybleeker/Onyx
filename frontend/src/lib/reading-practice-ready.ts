/**
 * Chapter questions ready for today's round (READ-QUIZ-01 S5), for Today's one line "Practice · 6 ready". Import-free
 * on purpose: Today (a critical-path page) takes this one small function instead of lib/reading.ts, and the overview
 * (lib/reading.ts re-exports it) and the tests run the same code, so the two can never drift.
 *
 * Ideas due plus ideas never asked yet, at most a round (a backlog never makes the round longer), and 0 while the
 * book's questions are off or the summary is missing, so Today shows nothing then.
 */
export const PRACTICE_ROUND_SIZE = 8;

export interface PracticeReadyInput {
  enabled: boolean;
  due: number;
  newReady: number;
}

export function practiceReady(p: PracticeReadyInput | null | undefined, roundSize: number = PRACTICE_ROUND_SIZE): number {
  if (!p?.enabled) return 0;
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
  return Math.min(roundSize, n(p.due) + n(p.newReady));
}
