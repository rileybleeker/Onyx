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
 *   unsaved one to be saved or settled (the buttons say so); nothing unsaved is replaced. The tap is shown at once
 *   and kept on this device until the server confirmed it; a kept tap from a closed tab is OFFERED again (Save it /
 *   Discard), never sent on its own, and blocks new taps until it is resolved. A tap that reaches the server after the
 *   behavioral day turned over (offline across 06:00) is refused as stale, and its kept copy stays: the reloaded day
 *   offers it again for the night Riley tapped.
 * - Every tap carries its own id (the same on every retry). A tap that was sent and not answered may have landed, so
 *   "Cancel" (and "Discard" on a kept tap) asks the server to settle it: it had landed (shown as saved, with Undo) or
 *   it had not and now never will (a late arrival is refused). When the server cannot be asked, nothing is dropped.
 * - A kept tap is never forgotten because the night shows its answer (another writer may have set the same answer
 *   while the tap is still on its way, SLEEP01-R2). It is forgotten only once its request can no longer land (the
 *   server's day or the night's goal version moved past the tap's: keptTapDecision), or once the server settled
 *   its id (saved, replayed, landed or cancelled). A refusal that depends on what the night holds (OXW15) of a tap
 *   sent before without an answer is settled by its id too (fenceRefused) before the kept copy goes.
 * - A read that started before a confirmed write is never shown (it may predate the write): each read is tagged with
 *   the write count at its start, the re-read after a write is always a NEW request, and untagged copies wait for it.
 * - The session ending (sign-out, 401, redirect to sign-in) empties this store: the private data, any retry waiting
 *   and the kept tap (clientCache.onWipe). A 200 that is a sign-in page is never taken for a saved answer.
 */

import { useSyncExternalStore } from "react";
import { GONE, clientCache, fetchJsonValue, reportSessionEnded, sessionEnded } from "@/lib/client-cache";
import { unsavedWork } from "@/lib/unsaved-work";
import { UI_PREFS_PATH } from "@/lib/ui-preferences";
import {
  WINDDOWN_CANCEL_URL,
  WINDDOWN_NIGHT_URL,
  WINDDOWN_PAUSE_URL,
  WINDDOWN_PENDING_KEY,
  WINDDOWN_PREF_KEY,
  WINDDOWN_RULE_URL,
  WINDDOWN_SAVED_EVENT,
  WINDDOWN_SESSION_ENDED_CODE,
  WINDDOWN_FINAL_REFUSALS,
  WINDDOWN_STALE_CODE,
  WINDDOWN_STALE_MESSAGE,
  WINDDOWN_URL,
  WindDownRefused,
  WindDownSaver,
  answerOn,
  confirmNightReply,
  msUntilRollover,
  keptTapDecision,
  newOpId,
  nightRequestBody,
  parsePending,
  parseWindDownPayload,
  pendingRecord,
  readIsCurrent,
  ruleFor,
  undoApplies,
  withAnswer,
  type LastTap,
  type NightAnswer,
  type NightIntent,
  type PendingTap,
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
  /**
   * A kept tap exists but the payload shown cannot judge it yet (a cached copy from before it), or it is being
   * settled by its id after a refusal: nothing is offered and every answer button waits.
   */
  recoveryChecking: boolean;
  /**
   * The last thing a tap did, for the screen reader and the undo line, with the goal version it answered (Undo is
   * dropped once the night is under another goal or no longer holds that answer: undoApplies).
   */
  last: LastTap | null;
  /** A goal / pause / hide action (or discarding a kept tap) in flight, and the message of the last one that failed. */
  busy: "rule" | "pause" | "hidden" | "recovery" | null;
  actionError: string | null;
  /** What the last Cancel / Discard settled, in words (cleared by the next tap). */
  notice: string | null;
}

const RELOAD_AFTER_MS = 60_000;
/** A page that mounts later in the same visit (Today -> Log) checks again when the last check is older than this. */
const REMOUNT_RELOAD_MS = 5_000;
let server: WindDownPayload | null = null;
let overlay: { night: string; answer: NightAnswer | null } | null = null;
const INITIAL: WindDownSnapshot = {
  load: "loading", payload: null, refreshFailed: false, at: null, fresh: false, saver: { status: "idle" }, recovery: null, recoveryChecking: false, last: null, busy: null, actionError: null, notice: null,
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
/** Writes confirmed in this visit. A read tagged with an older count started before the latest write (readIsCurrent). */
let writeSeq = 0;
/** A write was confirmed and its own re-read has not been accepted yet: untagged payloads (a cached copy) wait. */
let settling = false;
/** The write count at the START of the read that produced a payload. */
const born = new WeakMap<object, number>();
/** The read in flight, shared only by callers at the same write count. */
let reading: { seq: number; epoch: number; p: Promise<boolean> } | null = null;
/** The last payload object that was accepted (the cache notifies the same object again after our own put). */
let lastRaw: unknown = null;
/** The tap id being settled after a refusal (fenceRefused): its kept copy stays until the server answered. */
let fencing: string | null = null;
function afterWrite() { writeSeq++; settling = true; }
const CANCELLED_NOTICE = "Stopped. That tap was not saved and will not be.";
const DISCARDED_NOTICE = "Discarded. That tap was not saved and will not be.";
const LANDED_NOTICE = "That tap had already been saved.";
/**
 * Tap ids sent again from a kept copy (Save it): their earlier sends, in an earlier visit, went unanswered, so a
 * refusal of the resend does not prove the first request will never land (see onRefused).
 */
const resentKept = new Set<string>();

/** A tap is kept on this device and no send of this visit owns it (offered, being checked, or waiting for a read). */
function keptUnowned(): boolean {
  if (saver.unsaved) return false;
  try { return parsePending(window.localStorage.getItem(WINDDOWN_PENDING_KEY)) !== null; } catch { return false; }
}
/** What to do with the kept tap on the payload shown now (keptTapDecision; never decided by equal answers). */
function readKept(): ReturnType<typeof keptTapDecision> {
  try {
    return keptTapDecision(parsePending(window.localStorage.getItem(WINDDOWN_PENDING_KEY)), server, Date.now());
  } catch { return { kind: "none" }; }
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
  const tag = raw && typeof raw === "object" ? born.get(raw) : undefined;
  // A read that started before the latest confirmed write may have been answered before it landed: never shown.
  if (!readIsCurrent(tag, writeSeq, settling)) return false;
  if (raw === lastRaw) return true;
  lastRaw = raw;
  if (tag !== undefined) settling = false;
  server = next;
  // A kept tap is forgotten here only when the server can no longer apply it (the day or the goal moved on past it).
  // A night that already shows its answer proves nothing (another writer may have set it while the tap is still on
  // its way), so that tap is offered to be settled by its id instead (SLEEP01-R2).
  const kept = readKept();
  // "drop" means the request as sent can no longer be accepted, but a request already inside the database when the day
  // or the goal moved may still commit: the kept copy is forgotten only after the server settled that tap id under
  // the write's own lock (pds.sleep_winddown_cancel_op; SLEEP01-R2). Until then every answer button waits.
  const dropping = kept.kind === "drop" && !saver.unsaved;
  if (dropping && fencing === null) settleDropped();
  const owned = saver.unsaved || fencing !== null;
  // Undo is judged on the server's own read: a goal switched since (another habit) or an answer changed since (a
  // replayed tap's later edits) leaves nothing to undo.
  const last = snap.last && !saver.unsaved && !undoApplies(snap.last, next) ? null : snap.last;
  emit({
    load: "ready", refreshFailed: false, at: clientCache.fetchedAt(WINDDOWN_URL) ?? Date.now(), fresh: snap.fresh || fresh,
    recovery: !owned && kept.kind === "offer" ? kept.intent : null,
    // (A payload that is not ready has no answer buttons: nothing to say about a kept tap until the goal exists.)
    recoveryChecking: fencing !== null || dropping || (!saver.unsaved && kept.kind === "hold" && next.status === "ready"),
    last,
  });
  return true;
}

/** Tap ids whose settlement was tried lately (a failed attempt is repeated on a later read, never in a tight loop). */
const settleTried = new Map<string, number>();
const SETTLE_RETRY_MS = 30_000;
function settleDropped() {
  let tap: PendingTap | null = null;
  try { tap = parsePending(window.localStorage.getItem(WINDDOWN_PENDING_KEY)); } catch { /* none */ }
  if (!tap) return;
  const last = settleTried.get(tap.opId);
  if (last !== undefined && Date.now() - last < SETTLE_RETRY_MS) return;
  settleTried.set(tap.opId, Date.now());
  void fenceRefused(tap);
}

/**
 * One NEW read of the payload (never the answer to a request that started earlier: the cache's shared request could
 * have been sent before a write), tagged with the write count at its start. Callers at the same write count share it.
 */
function readServer(): Promise<boolean> {
  const seq = writeSeq;
  const mine = epoch;
  if (reading && reading.seq === seq && reading.epoch === mine) return reading.p;
  const p = (async () => {
    const data = await fetchJsonValue(WINDDOWN_URL);
    if (data === GONE || !data || typeof data !== "object") throw new Error("Couldn't read the wind-down.");
    parseWindDownPayload(data);
    if (mine !== epoch) return false;
    born.set(data, seq);
    if (!readIsCurrent(seq, writeSeq, settling)) return false;
    // Stored first so the shown "checked" time is this read's; the cache's own notice of the same object is a no-op.
    clientCache.put(WINDDOWN_URL, data);
    accept(data, true);
    return true;
  })();
  const job = { seq, epoch: mine, p };
  reading = job;
  p.finally(() => { if (reading === job) reading = null; }).catch(() => {});
  return p;
}

/**
 * The warm-up's read (components/AppData): tagged with the write count at its start like every other read, so a
 * response that was answered before a confirmed write is never shown, however late it is stored.
 */
export async function warmWindDownRead(): Promise<unknown> {
  const seq = writeSeq;
  const data = await fetchJsonValue(WINDDOWN_URL);
  if (data !== GONE && data && typeof data === "object") born.set(data, seq);
  return data;
}

/** Read the payload (the cached copy is already showing, then the server). Never writes. */
export function reloadWindDown(): Promise<void> {
  lastLoad = Date.now();
  const mine = epoch;
  return readServer().then(
    () => {},
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

/** The cancel answer is the server's own for this tap: its night and whether it landed. */
const confirmCancelReply = (intent: NightIntent) => (d: Record<string, unknown>) => {
  if (d.night !== intent.night || typeof d.landed !== "boolean") throw new Error("Couldn't confirm it was stopped.");
};

/** A tap is confirmed (saved, or found to have landed): show it, offer undo, re-read the server. */
function settled(intent: NightIntent, answer: NightAnswer | null, replayed: boolean, notice: string | null) {
  keep(null);
  // A replay answers with the first request's result; the habit may have been changed since, so it is read, not assumed.
  if (server && !replayed) server = withAnswer(server, intent.night, answer);
  // The answer the night had BEFORE this tap is the one the screen showed when it was made: a retry after a lost
  // answer comes back from the server as an unchanged night, so the server's own "previous" cannot be used to undo.
  // (A same-night tap still waiting behind this one keeps the overlay until it is saved too.)
  if (!saver.unsaved) overlay = null;
  afterWrite();
  const previous = intent.expect === "none" ? null : intent.expect;
  // A kept tap confirmed on a night that already showed its answer changed nothing: there is nothing to undo. Undo
  // remembers the goal version the tap answered, so a goal switched since never has the undo written to its habit.
  emit({ last: previous === answer ? null : { night: intent.night, answer, previous, ruleId: intent.ruleId }, recovery: null, recoveryChecking: false, notice });
  try { window.dispatchEvent(new CustomEvent(WINDDOWN_SAVED_EVENT)); } catch { /* no window */ }
  void reloadWindDown();
}

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
    if (s.status === "saving" || s.status === "retrying" || s.status === "cancelling") keep(s.intent);
    emit({ saver: s });
  },
  cancel: async (intent) => {
    const d = await send(WINDDOWN_CANCEL_URL, "POST", { op_id: intent.opId, night: intent.night }, confirmCancelReply(intent));
    return { landed: d.landed === true, answer: d.answer === "Yes" || d.answer === "No" ? d.answer : null };
  },
  // Cancel found the tap HAD landed: a replay, not a fresh save. Its answer is what the tap wrote back then; the night
  // may have changed since (cleared on another device), so it is never installed as current: the re-read decides.
  onLanded: (intent, answer) => settled(intent, answer ?? intent.answer, true, LANDED_NOTICE),
  // Cancel settled a tap that never landed and now never will: the screen goes back to what the server holds.
  onCancelled: () => {
    keep(null);
    overlay = null;
    afterWrite();
    emit({ recovery: null, notice: CANCELLED_NOTICE, saver: saver.current });
    void reloadWindDown();
  },
  onSaved: (intent, answer) => {
    resentKept.delete(intent.opId);
    const a = answer as { answer?: NightAnswer | null; replayed?: boolean };
    settled(intent, a.answer ?? intent.answer, a.replayed === true, null);
  },
  onRefused: (intent, e, sentBefore) => {
    // A stale refusal keeps the tap: its night is still the one Riley tapped and may still be answerable on the new
    // day, so the reload below offers it again (keptTapDecision). A refusal the server gives this request every time
    // ends it. Any other refusal of a tap that was sent before without an answer does not prove that earlier send
    // will never land (the night can change back to what the tap expected), so it is settled by its id first.
    const earlierSend = sentBefore || resentKept.has(intent.opId);
    resentKept.delete(intent.opId);
    overlay = null;
    let checking = false;
    if (e.code === WINDDOWN_STALE_CODE) {
      // kept, offered again by the reload below. Until a read judged it, every answer button waits ("Checking a tap
      // from earlier"), also when that read fails: a new tap would overwrite the kept copy.
      checking = true;
    } else if (earlierSend && !WINDDOWN_FINAL_REFUSALS.has(e.code) && e.code !== WINDDOWN_SESSION_ENDED_CODE) {
      void fenceRefused(intent);
      return;
    } else {
      keep(null);
    }
    emit({ recovery: null, recoveryChecking: checking });
    void reloadWindDown();
  },
});

/**
 * A refused tap whose earlier send went unanswered: ask the server to settle that tap id (pds.sleep_winddown_cancel_op)
 * before its kept copy is forgotten. Landed (the earlier send had been applied after all): shown as saved. Not
 * landed: it now never will. When the server cannot be asked the kept copy stays, and the next read offers it
 * (Save it / Discard) or drops it once the day or the goal moved past it. Every answer button waits meanwhile.
 */
async function fenceRefused(intent: NightIntent) {
  const mine = epoch;
  fencing = intent.opId;
  emit({ recovery: null, recoveryChecking: true });
  let d: Record<string, unknown> | null = null;
  try {
    d = await send(WINDDOWN_CANCEL_URL, "POST", { op_id: intent.opId, night: intent.night }, confirmCancelReply(intent));
  } catch { /* not settled: kept, offered by the read below */ }
  if (mine !== epoch) return;
  fencing = null;
  if (d && d.landed === true) {
    // Not a refusal after all: the earlier send had landed. The refusal message goes; the night shows as saved.
    saver.dismiss();
    settled(intent, d.answer === "Yes" || d.answer === "No" ? d.answer : intent.answer, true, LANDED_NOTICE);
    return;
  }
  if (d) { keep(null); afterWrite(); }
  // Not settled (d null): the kept copy stays and the buttons keep waiting until a read offers it or drops it.
  emit({ recovery: null, recoveryChecking: !d });
  void reloadWindDown();
}

/** The session ended: this store holds private data and maybe a write waiting to retry. Drop all of it, silently. */
function resetAfterSessionEnd() {
  epoch++;
  saver.reset();
  server = null;
  overlay = null;
  lastLoad = 0;
  started = false;
  reading = null;
  lastRaw = null;
  settling = false;
  fencing = null;
  resentKept.clear();
  settleTried.clear();
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
    const seq = writeSeq;
    const data = await fetchJsonValue(WINDDOWN_URL);
    if (data !== GONE) {
      parseWindDownPayload(data);
      if (data && typeof data === "object") born.set(data, seq);
    }
    return data;
  });
  clientCache.subscribe(WINDDOWN_URL, (raw) => {
    if (raw === undefined) return;
    // A read from before a write that the cache stored late: ignored here, and the current state is read again.
    if (!accept(raw, true) && raw && typeof raw === "object" && born.has(raw)) void reloadWindDown();
  });
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
  if (snap.recovery || snap.recoveryChecking || fencing !== null || !saver.canAccept(night)) return false;
  // A kept tap that no send of this visit owns is never overwritten by a new tap: check it again first.
  if (keptUnowned()) { emit({ recoveryChecking: true }); void reloadWindDown(); return false; }
  const rule = ruleFor(p.rules, night);
  if (!rule) return false;
  const expect = answerOn(p, night);
  if (expect === (answer ?? "none")) return false;
  overlay = { night, answer };
  emit({ recovery: null, actionError: null, notice: null });
  return saver.submit({ night, answer, expect, today: p.today, ruleId: rule.id, opId: newOpId() });
}
/**
 * Undo the last tap: put that night back to the answer it had, only while the night is still under the goal version
 * the tap answered and still holds the tap's answer (undoApplies). Otherwise there is nothing to undo.
 */
export function undoLast() {
  const last = snap.last;
  if (!last) return;
  if (!undoApplies(last, snap.payload)) { emit({ last: null }); return; }
  if (answerNight(last.night, last.previous)) emit({ last: null });
}
export function retryNow() { saver.retryNow(); }
/**
 * "Cancel" on a tap that is waiting to retry: the server is asked whether it landed (it shows as saved) or is told it
 * never will (the screen goes back to what the server holds); when it cannot be asked the tap stays and retries.
 * "OK" on a refusal: clear the message (the screen already went back to what the server holds).
 */
export function dismissTap() {
  const st = saver.current;
  if (st.status === "retrying") { void saver.cancel(); return; }
  if (st.status === "cancelling") return;
  saver.dismiss();
  // OK only clears the message. The kept copy was already decided when the refusal came (onRefused): forgotten when
  // the server refuses that tap every time, kept while it is settled by its id or offered again.
  overlay = null;
  emit({ saver: saver.current });
}
/**
 * The kept tap from an earlier visit: send it now (Riley tapped Save it: the same tap id, so the server replays it if
 * it had landed), or discard it. Discard asks the server to settle the tap first, because it may still be on its way
 * or may have landed: only then is it forgotten, and when the server cannot be asked it stays offered.
 */
export function resolveRecovery(save: boolean) {
  const r = snap.recovery;
  if (!r || snap.busy === "recovery") return;
  if (!save) { void discardRecovery(r); return; }
  emit({ recovery: null, notice: null });
  overlay = { night: r.night, answer: r.answer };
  emit({});
  resentKept.add(r.opId);
  if (!saver.submit(r)) resentKept.delete(r.opId);
}
async function discardRecovery(r: NightIntent) {
  const mine = epoch;
  emit({ busy: "recovery", actionError: null });
  try {
    const d = await send(WINDDOWN_CANCEL_URL, "POST", { op_id: r.opId, night: r.night }, confirmCancelReply(r));
    if (mine !== epoch) return;
    keep(null);
    afterWrite();
    emit({ busy: null, recovery: null, recoveryChecking: false, notice: d.landed === true ? LANDED_NOTICE : DISCARDED_NOTICE });
    if (d.landed === true) { try { window.dispatchEvent(new CustomEvent(WINDDOWN_SAVED_EVENT)); } catch { /* no window */ } }
    void reloadWindDown();
  } catch {
    if (mine !== epoch) return;
    emit({ busy: null, actionError: "Couldn't discard it: Onyx could not be reached. It is still offered." });
  }
}

async function action(kind: "rule" | "pause" | "hidden", run: () => Promise<unknown>): Promise<boolean> {
  emit({ busy: kind, actionError: null });
  try {
    await run();
    afterWrite();
    // A new goal version may name another habit for that night: the last tap's Undo would answer the wrong one.
    emit(kind === "rule" ? { busy: null, last: null } : { busy: null });
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
