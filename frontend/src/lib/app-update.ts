/**
 * The installed app keeps itself current (Riley 2026-11-14: no reinstalling on the phone). An iPhone home-screen app
 * is paused in memory, and Vercel's skew protection keeps an open page on the deployment it started with, so a new
 * release was not seen until the app was killed. UpdateChecker asks /api/version when the app comes back to the
 * screen (and every few minutes while visible) and reloads onto the new build.
 * Pure rules, no imports; unit-tested in tests/app-update.test.cjs.
 */
export type UpdateAction = "none" | "reload" | "prompt";

export const CHECK_EVERY_MS = 5 * 60 * 1000;
export const MIN_GAP_MS = 30 * 1000;

/** What to do when the live build may differ from the running one. */
export function updateAction(o: {
  running: string | undefined | null;
  live: string | undefined | null;
  busy: boolean; // typing in a field or a dialog is open
  reloadedFor: string | null; // the live build this tab already reloaded for (sessionStorage)
}): UpdateAction {
  const { running, live, busy, reloadedFor } = o;
  if (!running || !live || running === live) return "none";
  // Reloaded once for this build and still not on it: offer the button, never loop.
  if (reloadedFor === live) return "prompt";
  return busy ? "prompt" : "reload";
}

/** Typing in a field or working in a dialog: do not pull the page away. */
export function isBusy(doc: { activeElement: Element | null; querySelector(s: string): Element | null }): boolean {
  const el = doc.activeElement as (Element & { isContentEditable?: boolean }) | null;
  const tag = el?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || el?.isContentEditable) return true;
  return !!doc.querySelector('[role="dialog"][aria-modal="true"], dialog[open]');
}
