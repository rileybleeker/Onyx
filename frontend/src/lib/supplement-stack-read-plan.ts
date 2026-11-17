/**
 * Which read the stacks GET starts with. The read tries every optional column first and steps down one 42703
 * (undefined column) at a time; this memo remembers which optional columns a read found missing, so that for
 * `MISSING_COLUMN_TTL_MS` a request starts at the step that already matches the database instead of paying for the
 * failed reads again. Only the number of failed round trips changes: the step decides which columns are selected,
 * and the response is built from the same fallbacks either way.
 */

/** [withVersion, withCount] in the order the GET steps down: full read first, then one column dropped at a time. */
export const STACK_READ_STEPS = [
  [true, true],
  [false, true],
  [true, false],
  [false, false],
] as const;

export const MISSING_COLUMN_TTL_MS = 10 * 60 * 1000;

/** `version` / `count`: true when that optional column was found missing; `at`: when that was recorded (ms). */
export type MissingColumnMemo = { version: boolean; count: boolean; at: number } | null;

export function isFresh(memo: MissingColumnMemo, now: number): boolean {
  return memo !== null && now - memo.at < MISSING_COLUMN_TTL_MS;
}

/** Index into STACK_READ_STEPS of the first step that selects no column the fresh memo knows to be missing. */
export function startStep(memo: MissingColumnMemo, now: number): number {
  if (!memo || !isFresh(memo, now)) return 0;
  return STACK_READ_STEPS.findIndex(([withVersion, withCount]) => !(withVersion && memo.version) && !(withCount && memo.count));
}

/**
 * The memo after a read that succeeded at step `idx`, having started at step `start`.
 * - A fresh memo that the read confirmed keeps its original timestamp, so it expires 10 minutes after it was
 *   recorded (a column installed meanwhile is picked up when it expires, not on every request).
 * - Otherwise the memo is replaced by what this read selected; a full read (both columns present) clears it.
 */
export function nextMemo(memo: MissingColumnMemo, start: number, idx: number, now: number): MissingColumnMemo {
  if (isFresh(memo, now) && idx === start) return memo;
  const [withVersion, withCount] = STACK_READ_STEPS[idx];
  if (withVersion && withCount) return null;
  return { version: !withVersion, count: !withCount, at: now };
}
