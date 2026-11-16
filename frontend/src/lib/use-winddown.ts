"use client";

/**
 * The wind-down streak on the client (PROD-SLEEP-01): ONE store per page shared by Today's panel, Today's quiet view
 * and the Log section, so they always show the same goal, progress and action. Rules: lib/sleep-winddown.ts.
 *
 * - Reads GET /api/sleep/winddown through the client cache (shown at once from a cached copy, then revalidated on
 *   every mount, when the app comes back after a minute and when the behavioral day rolls over; a habit write
 *   anywhere refetches it: lib/client-cache.ts writeInvalidates). Opening, scrolling or reading progress never
 *   writes.
 * - Writes only after a tap: one night at a time through WindDownSaver (retry with backoff, Retry now when the
 *   device comes back online, a refusal shown and the answer reloaded). A tap for another night waits for the
 *   unsaved one to be saved or cancelled (the buttons say so); nothing unsaved is replaced. The tap is shown at once
 *   and kept on this device until the server confirmed it; a kept tap from a closed tab is OFFERED again (Save it /
 *   Discard), never sent on its own, and blocks new taps until it is resolved.
 */

import { useSyncExternalStore } from "react";
import { GONE, cachedJson, clientCache, fetchJsonValue } from "@/lib/client-cache";
import { unsavedWork } from "@/lib/unsaved-work";
import { UI_PREFS_PATH } from "@/lib/ui-preferences";
import {
  WINDDOWN_NIGHT_URL,
  WINDDOWN_PAUSE_URL,
  WINDDOWN_PENDING_KEY,
  WINDDOWN_PREF_KEY,
  WINDDOWN_RULE_URL,
  WINDDOWN_SAVED_EVENT,
  WINDDOWN_URL,
  WindDownRefused,
  WindDownSaver,
  answerOn,
  msUntilRollover,
  parsePending,
  parseWindDownPayload,
  pendingRecord,
  pendingToOffer,
  ruleFor,
  withAnswer,
  type NightAnswer,
  type NightIntent,
  type SaverState,
  type WindDownPayload,
} from "@/lib/sleep-winddown";

export interface WindDownSnapshot {
  load: "loading" | "ready" | "error";
  /** The server's answer with a tap that is being saved already applied. */
  payload: WindDownPayload | null;
  /** The shown answer is from an earlier check: the last read failed. */
  refreshFailed: boolean;
  /** When the shown payload was fetched from the server (ms; a cached copy keeps its own time). */
  at: number | null;
  /** The server answered during this page visit (a cached copy from an earlier visit is still being checked). */
  fresh: boolean;
  saver: SaverState;
  /** A tap kept from an earlier visit that was never confirmed: offered, never sent on its own. */
  recovery: NightIntent | null;
  /** The last thing a tap did, for the screen reader and the undo line. */
  last: { night: string; answer: NightAnswer | null; previous: NightAnswer | null } | null;
  /** A goal / pause / hide action in flight, and the message of the last one that failed. */
  busy: "rule" | "pause" | "hidden" | null;
  actionError: string | null;
}

const RELOAD_AFTER_MS = 60_000;
/** A page that mounts later in the same visit (Today -> Log) checks again when the last check is older than this. */
const REMOUNT_RELOAD_MS = 5_000;
let server: WindDownPayload | null = null;
let overlay: { night: string; answer: NightAnswer | null } | null = null;
let snap: WindDownSnapshot = {
  load: "loading", payload: null, refreshFailed: false, at: null, fresh: false, saver: { status: "idle" }, recovery: null, last: null, busy: null, actionError: null,
};
const listeners = new Set<() => void>();
let started = false;
let lastLoad = 0;

function readKept(): NightIntent | null {
  try {
    return pendingToOffer(parsePending(window.localStorage.getItem(WINDDOWN_PENDING_KEY)), server, Date.now());
  } catch { return null; }
}
function keep(intent: NightIntent | null) {
  try {
    if (intent) window.localStorage.setItem(WINDDOWN_PENDING_KEY, pendingRecord(intent, Date.now()));
    else window.localStorage.removeItem(WINDDOWN_PENDING_KEY);
  } catch { /* a device that cannot keep it still saves the tap now */ }
}

function emit(patch: Partial<WindDownSnapshot> = {}) {
  const payload = server && overlay ? withAnswer(server, overlay.night, overlay.answer) : server;
  snap = { ...snap, ...patch, payload };
  unsavedWork.setDirty("sleep-winddown", saver.unsaved);
  for (const fn of Array.from(listeners)) fn();
}

function accept(raw: unknown, fresh = false): boolean {
  let next: WindDownPayload;
  try { next = parseWindDownPayload(raw); } catch { return false; }
  server = next;
  // A kept tap that did land (the server now holds its answer) is dropped without asking.
  const offer = readKept();
  if (!offer && !saver.unsaved) keep(null);
  emit({ load: "ready", refreshFailed: false, at: clientCache.fetchedAt(WINDDOWN_URL) ?? Date.now(), fresh: snap.fresh || fresh, recovery: saver.unsaved ? null : offer });
  return true;
}

/** Read the payload (cached copy first, then the server). Never writes. */
export function reloadWindDown(): Promise<void> {
  lastLoad = Date.now();
  return cachedJson(WINDDOWN_URL, { check: parseWindDownPayload }).then(
    (raw) => { accept(raw, true); },
    () => { emit(server ? { refreshFailed: true } : { load: "error" }); },
  );
}

async function send(url: string, method: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data: Record<string, unknown> = {};
  try { data = (await res.json()) as Record<string, unknown>; } catch { /* no JSON body */ }
  if (res.ok) return data;
  const message = typeof data.error === "string" ? data.error : "Not saved.";
  // A refusal is shown and not retried; a server error is retried.
  if (res.status >= 400 && res.status < 500) throw new WindDownRefused(message, typeof data.code === "string" ? data.code : String(res.status));
  throw new Error(message);
}

const saver = new WindDownSaver({
  send: (intent) => send(WINDDOWN_NIGHT_URL, "POST", intent),
  onState: (s) => {
    if (s.status === "saving" || s.status === "retrying") keep(s.intent);
    emit({ saver: s });
  },
  onSaved: (intent, answer) => {
    const a = answer as { answer?: NightAnswer | null };
    keep(null);
    if (server) server = withAnswer(server, intent.night, a.answer ?? intent.answer);
    // The answer the night had BEFORE this tap is the one the screen showed when it was made: a retry after a lost
    // answer comes back from the server as an unchanged night, so the server's own "previous" cannot be used to undo.
    // (A same-night tap still waiting behind this one keeps the overlay until it is saved too.)
    if (!saver.unsaved) overlay = null;
    emit({ last: { night: intent.night, answer: a.answer ?? intent.answer, previous: intent.expect === "none" ? null : intent.expect }, recovery: null });
    try { window.dispatchEvent(new CustomEvent(WINDDOWN_SAVED_EVENT)); } catch { /* no window */ }
    void reloadWindDown();
  },
  onRefused: () => {
    keep(null);
    overlay = null;
    emit({ recovery: null });
    void reloadWindDown();
  },
});

function scheduleRollover() {
  setTimeout(() => {
    // The behavioral day turned over (06:00 on this device): the screen's "tonight" is last night's.
    if (document.visibilityState === "visible" && !saver.unsaved) void reloadWindDown();
    scheduleRollover();
  }, msUntilRollover(new Date()));
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (typeof window !== "undefined") {
    if (!started) {
      started = true;
      const cached = clientCache.peek(WINDDOWN_URL);
      if (cached === undefined || !accept(cached)) void clientCache.read(WINDDOWN_URL).then((raw) => { if (raw !== undefined && !server) accept(raw); });
      // A write elsewhere (the check-in, /habits, chat) drops the cached copy and refetches it: show that answer.
      // (A plain fetch, not cachedJson: invalidate() already runs the fetcher inside the cache's own revalidate.)
      clientCache.register(WINDDOWN_URL, async () => {
        const data = await fetchJsonValue(WINDDOWN_URL);
        if (data !== GONE) parseWindDownPayload(data);
        return data;
      });
      clientCache.subscribe(WINDDOWN_URL, (raw) => { if (raw !== undefined) accept(raw, true); });
      void reloadWindDown();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastLoad > RELOAD_AFTER_MS && !saver.unsaved) void reloadWindDown();
      });
      window.addEventListener("online", () => saver.retryNow());
      scheduleRollover();
    } else if (Date.now() - lastLoad > REMOUNT_RELOAD_MS && !saver.unsaved) {
      // Another page mounted in the same visit (Today -> Log, a nav click): the day or the goal may have moved on
      // another device since the last check. The cached copy shows at once; this is the revalidation.
      void reloadWindDown();
    }
  }
  return () => { listeners.delete(fn); };
}
const getSnapshot = () => snap;
const LOADING: WindDownSnapshot = snap;
const getServerSnapshot = () => LOADING;

export function useWindDown(): WindDownSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ─── Actions (each only after a tap) ────────────────────────────────────────────────────────────────────────

/**
 * Answer one night: Yes (wound down), No (confirmed miss) or null (clear). Shown at once, saved by the saver.
 * Returns false when nothing was sent: a tap for another night is still unsaved (or a kept tap from an earlier visit
 * is waiting for Save it / Discard), the answer is already what the screen shows, or there is no goal for the night.
 */
export function answerNight(night: string, answer: NightAnswer | null): boolean {
  const p = snap.payload;
  if (!p || p.status !== "ready") return false;
  if (snap.recovery || !saver.canAccept(night)) return false;
  const rule = ruleFor(p.rules, night);
  if (!rule) return false;
  const expect = answerOn(p, night);
  if (expect === (answer ?? "none")) return false;
  overlay = { night, answer };
  emit({ recovery: null, actionError: null });
  return saver.submit({ night, answer, expect, today: p.today, ruleId: rule.id });
}
/** Undo the last tap: put that night back to the answer it had. */
export function undoLast() {
  const last = snap.last;
  if (!last) return;
  if (answerNight(last.night, last.previous)) emit({ last: null });
}
export function retryNow() { saver.retryNow(); }
/** Give up on a tap that is waiting to retry or was refused: the screen goes back to what the server holds. */
export function dismissTap() {
  saver.dismiss();
  keep(null);
  overlay = null;
  emit({ saver: saver.current });
}
/** The kept tap from an earlier visit: send it now (Riley tapped Save it), or drop it. */
export function resolveRecovery(save: boolean) {
  const r = snap.recovery;
  emit({ recovery: null });
  if (!r) return;
  if (!save) { keep(null); return; }
  overlay = { night: r.night, answer: r.answer };
  emit({});
  saver.submit(r);
}

async function action(kind: "rule" | "pause" | "hidden", run: () => Promise<unknown>): Promise<boolean> {
  emit({ busy: kind, actionError: null });
  try {
    await run();
    emit({ busy: null });
    await reloadWindDown();
    return true;
  } catch (e) {
    emit({ busy: null, actionError: e instanceof TypeError ? "Couldn't reach Onyx. Try again." : e instanceof Error && e.message ? e.message : "Not saved. Try again." });
    if (e instanceof WindDownRefused) void reloadWindDown();
    return false;
  }
}

export interface GoalInput { habitPageId: string; targetTime: string; winsNeeded: number; windowNights: number }
/** A new goal version from tonight on (Start / Save goal). */
export function saveGoal(goal: GoalInput): Promise<boolean> {
  const today = snap.payload?.today;
  if (!today) return Promise.resolve(false);
  let tz = "America/New_York";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch { /* default */ }
  return action("rule", () => send(WINDDOWN_RULE_URL, "POST", {
    habit_page_id: goal.habitPageId, target_time: goal.targetTime, wins_needed: goal.winsNeeded, window_nights: goal.windowNights, tz, today,
  }));
}
export function addPause(startDate: string, endDate: string | null): Promise<boolean> {
  const today = snap.payload?.today;
  if (!today) return Promise.resolve(false);
  return action("pause", () => send(WINDDOWN_PAUSE_URL, "POST", { start_date: startDate, end_date: endDate, today }));
}
export function endPause(pauseId: number): Promise<boolean> {
  return action("pause", () => send(WINDDOWN_PAUSE_URL, "PATCH", { pause_id: pauseId }));
}
/** Hide from Today (and collapse on Log), or show again: the UI preference sleep.winddown. */
export function setWindDownHidden(hidden: boolean): Promise<boolean> {
  return action("hidden", () => send(UI_PREFS_PATH, "PUT", { key: WINDDOWN_PREF_KEY, value: { hidden } }));
}
