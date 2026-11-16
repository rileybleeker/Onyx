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
 *   Discard), never sent on its own, and blocks new taps until it is resolved. A tap that reaches the server after the
 *   behavioral day turned over (offline across 06:00) is refused as stale, and its kept copy stays: the reloaded day
 *   offers it again for the night Riley tapped.
 * - The session ending (sign-out, 401, redirect to sign-in) empties this store: the private data, any retry waiting
 *   and the kept tap (clientCache.onWipe). A 200 that is a sign-in page is never taken for a saved answer.
 */

import { useSyncExternalStore } from "react";
import { GONE, cachedJson, clientCache, fetchJsonValue, reportSessionEnded, sessionEnded } from "@/lib/client-cache";
import { unsavedWork } from "@/lib/unsaved-work";
import { UI_PREFS_PATH } from "@/lib/ui-preferences";
import {
  WINDDOWN_NIGHT_URL,
  WINDDOWN_PAUSE_URL,
  WINDDOWN_PENDING_KEY,
  WINDDOWN_PREF_KEY,
  WINDDOWN_RULE_URL,
  WINDDOWN_SAVED_EVENT,
  WINDDOWN_SESSION_ENDED_CODE,
  WINDDOWN_STALE_CODE,
  WINDDOWN_STALE_MESSAGE,
  WINDDOWN_URL,
  WindDownRefused,
  WindDownSaver,
  answerOn,
  confirmNightReply,
  msUntilRollover,
  nightRequestBody,
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
const INITIAL: WindDownSnapshot = {
  load: "loading", payload: null, refreshFailed: false, at: null, fresh: false, saver: { status: "idle" }, recovery: null, last: null, busy: null, actionError: null,
};
let snap: WindDownSnapshot = INITIAL;
const listeners = new Set<() => void>();
/** The page-wide hooks (cache fetcher, cache listener, document listeners, wipe listener) are installed once. */
let hooked = false;
/** This visit's first read has been started (false again after a session end, so the next mount starts afresh). */
let started = false;
let lastLoad = 0;
/** Bumped when the session ends: a read that started before it never fills the emptied store. */
let epoch = 0;

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
  const mine = epoch;
  return cachedJson(WINDDOWN_URL, { check: parseWindDownPayload }).then(
    (raw) => { if (mine === epoch) accept(raw, true); },
    () => { if (mine === epoch) emit(server ? { refreshFailed: true } : { load: "error" }); },
  );
}

/**
 * One write. `check` throws unless a success answer is the server's own for this request: an expired session answers a
 * 200 sign-in page after a redirect, and that is neither a saved answer nor a reason to clear what was kept.
 */
async function send(url: string, method: string, body: unknown, check?: (data: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (sessionEnded(res)) {
    reportSessionEnded();
    throw new WindDownRefused("Your session ended. Sign in again.", WINDDOWN_SESSION_ENDED_CODE);
  }
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* no JSON body */ }
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (res.ok) {
    if (!data) throw new Error("Couldn't confirm it was saved.");
    check?.(data);
    return data;
  }
  const message = data && typeof data.error === "string" ? data.error : "Not saved.";
  // A refusal is shown and not retried; a server error (and a timeout / rate limit) is retried.
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    throw new WindDownRefused(message, data && typeof data.code === "string" ? data.code : String(res.status));
  }
  throw new Error(message);
}
const hasKey = (key: string) => (d: Record<string, unknown>) => {
  if (!d[key] || typeof d[key] !== "object") throw new Error("Couldn't confirm it was saved.");
};

const saver = new WindDownSaver({
  send: async (intent) => {
    try {
      return await send(WINDDOWN_NIGHT_URL, "POST", nightRequestBody(intent), (d) => confirmNightReply(d, intent));
    } catch (e) {
      // The day turned over before the tap was saved: say so (the kept copy and the reloaded day offer it again).
      if (e instanceof WindDownRefused && e.code === WINDDOWN_STALE_CODE) throw new WindDownRefused(WINDDOWN_STALE_MESSAGE, e.code);
      throw e;
    }
  },
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
  onRefused: (_intent, e) => {
    // A stale refusal is the only one that keeps the tap: its night is still the one Riley tapped and may still be
    // answerable on the new day, so the reload below offers it again (pendingToOffer). Every other refusal is final.
    if (e.code !== WINDDOWN_STALE_CODE) keep(null);
    overlay = null;
    emit({ recovery: null });
    void reloadWindDown();
  },
});

/** The session ended: this store holds private data and maybe a write waiting to retry. Drop all of it, silently. */
function resetAfterSessionEnd() {
  epoch++;
  saver.reset();
  server = null;
  overlay = null;
  lastLoad = 0;
  started = false;
  keep(null);
  unsavedWork.setDirty("sleep-winddown", false);
  snap = INITIAL;
  for (const fn of Array.from(listeners)) fn();
}

function scheduleRollover() {
  setTimeout(() => {
    // The behavioral day turned over (06:00 on this device): the screen's "tonight" is last night's.
    if (started && document.visibilityState === "visible" && !saver.unsaved) void reloadWindDown();
    scheduleRollover();
  }, msUntilRollover(new Date()));
}

/** Page-wide hooks, installed on the first mount only. */
function hook() {
  // A write elsewhere (the check-in, /habits, chat) drops the cached copy and refetches it: show that answer.
  // (A plain fetch, not cachedJson: invalidate() already runs the fetcher inside the cache's own revalidate.)
  clientCache.register(WINDDOWN_URL, async () => {
    const data = await fetchJsonValue(WINDDOWN_URL);
    if (data !== GONE) parseWindDownPayload(data);
    return data;
  });
  clientCache.subscribe(WINDDOWN_URL, (raw) => { if (raw !== undefined) accept(raw, true); });
  clientCache.onWipe(resetAfterSessionEnd);
  document.addEventListener("visibilitychange", () => {
    if (started && document.visibilityState === "visible" && Date.now() - lastLoad > RELOAD_AFTER_MS && !saver.unsaved) void reloadWindDown();
  });
  window.addEventListener("online", () => saver.retryNow());
  scheduleRollover();
}
/** This visit's first read: the cached copy at once, then the server. */
function begin() {
  const cached = clientCache.peek(WINDDOWN_URL);
  const mine = epoch;
  if (cached === undefined || !accept(cached)) void clientCache.read(WINDDOWN_URL).then((raw) => { if (mine === epoch && raw !== undefined && !server) accept(raw); });
  void reloadWindDown();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (typeof window !== "undefined") {
    if (!hooked) { hooked = true; hook(); }
    if (!started) {
      started = true;
      begin();
    } else if (Date.now() - lastLoad > REMOUNT_RELOAD_MS && !saver.unsaved) {
      // Another page mounted in the same visit (Today -> Log, a nav click): the day or the goal may have moved on
      // another device since the last check. The cached copy shows at once; this is the revalidation.
      void reloadWindDown();
    }
  }
  return () => { listeners.delete(fn); };
}
const getSnapshot = () => snap;
const LOADING: WindDownSnapshot = INITIAL;
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
  const st = saver.current;
  const stale = st.status === "refused" && st.code === WINDDOWN_STALE_CODE;
  saver.dismiss();
  // A tap that is being offered again (after a stale refusal) keeps its copy until Riley picks Save it or Discard;
  // the next read drops it when that night can no longer be answered here.
  if (!snap.recovery && !stale) keep(null);
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
    if (e instanceof WindDownRefused && e.code !== WINDDOWN_SESSION_ENDED_CODE) void reloadWindDown();
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
  }, hasKey("rule")));
}
export function addPause(startDate: string, endDate: string | null): Promise<boolean> {
  const today = snap.payload?.today;
  if (!today) return Promise.resolve(false);
  return action("pause", () => send(WINDDOWN_PAUSE_URL, "POST", { start_date: startDate, end_date: endDate, today }, hasKey("pause")));
}
export function endPause(pauseId: number): Promise<boolean> {
  return action("pause", () => send(WINDDOWN_PAUSE_URL, "PATCH", { pause_id: pauseId }, hasKey("pause")));
}
/** Hide from Today (and collapse on Log), or show again: the UI preference sleep.winddown. */
export function setWindDownHidden(hidden: boolean): Promise<boolean> {
  return action("hidden", () => send(UI_PREFS_PATH, "PUT", { key: WINDDOWN_PREF_KEY, value: { hidden } }, (d) => {
    if (d.key !== WINDDOWN_PREF_KEY) throw new Error("Couldn't confirm it was saved.");
  }));
}
