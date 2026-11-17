"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { useInFeed } from "@/components/FeedContext";
import { AutosaveRefused, saveRequest } from "@/lib/autosave";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import { useLogDrafts, type ReadingLogDraft } from "@/lib/log-drafts";
import { LOG_READING_URL, logEarlyGet } from "@/lib/log-early";
import type { Book, Medium, ReadingOverview, ReadingSession } from "@/lib/reading";
import { deviceBehavioralDay, fallbackBehavioralToday } from "@/lib/checkin";
import { isBlankSession, newClientKey, readingSaveTarget, sameReadingValue, sessionValue, type SessionValue } from "@/lib/reading-autosave";
import { readRemovalReply } from "@/lib/reading-removal-receipt";
import type { RetainedSaveContext } from "@/lib/autosave-retain";
import { useRetainedAutosave } from "@/lib/use-autosave";
import { DraftMark, LogCard, SectionSkeleton } from "./ui";

/**
 * /log Reading. The book being read (chapters done, pace, the Kindle position) and the day's sessions, read-only:
 * Kindle days are written automatically by the harvester. Below them one audio / paper session, saved as it is
 * entered (lib/autosave.ts, Riley 2026-11-15): once the fields hold a valid session (chapter_through set and not past
 * the book's last chapter) it is created through POST /api/reading/sessions when Riley pauses or leaves a field,
 * and every later edit of the same form updates that session (PATCH /api/reading/sessions/[id]). The day is sent
 * only when chosen (the server takes behavioral today); the recall note is stored verbatim; the book's habit is
 * stamped Yes for that day. "New session" starts the next one; "Remove this session" deletes the one just made.
 * Reads GET /api/reading through the client cache (same key as Today and /reading). A Say it draft
 * (ReadingLogDraft) fills the fields Riley has not changed and is saved like his own entry, marked "from what you
 * said"; a new draft after a session was saved starts a new session. Nothing is written on open or on scroll.
 * An entry not saved yet (incomplete, failed or waiting) survives the section being unmounted: its fields, the session
 * it made and its client_key stay with its autosaver until it is saved (useRetainedAutosave, PROD-T01). It keeps the
 * day it was started on (also when finished after 06:00 with no new answer from the server), and it stays on screen
 * with its reason and Retry when its book is no longer in progress (or the overview cannot be read), with Discard
 * (which drops the Say it words the entry was made from too). A failed save that may have been stored anyway (every
 * failure but a refusal: mayHaveStored) reads "Not confirmed", and until a save is answered changing the form back to
 * the last confirmed values is sent, never shown as "Saved" while the server may hold the lost edit. Likewise an entry
 * whose create went out without a confirmed answer is never dropped locally: Discard, or emptying the form, removes the
 * session that create may have made (by its client_key; nothing is created) and the entry goes only once the server
 * says nothing of it is stored ("Discarded"); until then it is kept and retried like a save. The server records that
 * key as discarded before it looks (sql/reading_session_discards.sql), so a create of it still running there is
 * found or refused, never stored after the answer; an entry edited after its Discard reached the server continues
 * under a new key.
 */

const READING_URL = LOG_READING_URL;

type ReadingAnswer = { overview: ReadingOverview | null; books?: Book[] };
function asReading(raw: unknown): ReadingAnswer | null {
  const v = raw as ReadingAnswer | undefined;
  return v && typeof v === "object" && "overview" in v && (v.overview === null || !!v.overview?.book?.slug) ? v : null;
}
function checkReading(raw: unknown) {
  if (!asReading(raw)) throw new Error("unexpected reading answer");
}

const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

const MEDIA: Array<{ key: Medium; label: string }> = [
  { key: "audio", label: "Audio" },
  { key: "paper", label: "Paper" },
  { key: "other", label: "Other" },
];
const MEDIUM_LABEL: Record<Medium, string> = { audio: "Audio", paper: "Paper", kindle: "Kindle", other: "Other" };
const DEFAULT_MEDIUM: Medium = "audio";

type Field = "from" | "through" | "minutes" | "date" | "medium" | "recall" | "book";
type Form = { from: string; through: string; minutes: string; date: string; medium: Medium; recall: string; book: string | null };
const EMPTY_FIELDS: Record<Field, boolean> = { from: false, through: false, minutes: false, date: false, medium: false, recall: false, book: false };

function blankForm(today: string): Form {
  return { from: "", through: "", minutes: "", date: today, medium: DEFAULT_MEDIUM, recall: "", book: null };
}

/** The draft's values as form fields (only the ones it carries). */
function draftFields(v: ReadingLogDraft): Partial<Form> {
  const out: Partial<Form> = {};
  if (v.chapter_from != null && Number.isFinite(v.chapter_from)) out.from = String(v.chapter_from);
  if (v.chapter_through != null && Number.isFinite(v.chapter_through)) out.through = String(v.chapter_through);
  if (v.minutes != null && Number.isFinite(v.minutes)) out.minutes = String(Math.round(v.minutes));
  if (v.date && isYmd(v.date)) out.date = v.date;
  if (v.medium) out.medium = v.medium;
  if (v.recall) out.recall = v.recall;
  if (v.book) out.book = v.book;
  return out;
}

function draftSummary(v: ReadingLogDraft): string {
  const parts: string[] = [];
  if (v.minutes != null) parts.push(`${v.minutes} min`);
  if (v.chapter_through != null) parts.push(v.chapter_from != null ? `ch ${v.chapter_from}–${v.chapter_through}` : `through ch ${v.chapter_through}`);
  if (v.medium) parts.push(MEDIUM_LABEL[v.medium]);
  if (v.date) parts.push(fmtDate(v.date));
  return parts.join(" · ");
}

function SessionLine({ s }: { s: ReadingSession }) {
  const chapters =
    s.chapter_through != null
      ? `ch ${s.chapter_from ?? "?"}–${s.chapter_through}`
      : s.in_chapter != null
        ? `in ch ${s.in_chapter}`
        : null;
  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] font-mono text-text-secondary">
        <span className="text-text-primary">
          {s.source === "kindle" ? "Kindle · auto" : s.medium ? MEDIUM_LABEL[s.medium] : "Session"}
        </span>
        {chapters && <span>{chapters}</span>}
        {s.minutes ? <span>{s.minutes} min</span> : null}
        {s.source === "kindle" && s.highlight_count ? <span>{s.highlight_count} highlight{s.highlight_count === 1 ? "" : "s"}</span> : null}
        {s.source === "chat" && <span className="text-text-tertiary">chat</span>}
      </div>
      {s.recall && <p className="mt-0.5 text-[13px] text-text-tertiary line-clamp-2">{s.recall}</p>}
    </li>
  );
}

type SavedInfo = { xp: number; finished: boolean } | null;

/**
 * What the autosaver holds: the session the fields describe, or DISCARD, the request that removes the session this
 * entry's create may have made (Discard, or the form emptied, after a create got no confirmed answer).
 */
type FormValue = SessionValue & { discard?: true };
const DISCARD: FormValue = { body: null, reason: null, discard: true };
const sameValue = (a: FormValue, b: FormValue) => !!a.discard === !!b.discard && sameReadingValue(a, b);
type DraftMarks = { id: number; fields: Record<Field, boolean> };

/**
 * The form's own state, kept with its autosaver past this component while the entry is not saved
 * (lib/autosave-retain.ts, PROD-T01): the scroll dropping the Log page, a navigation, a hidden or moved part. A remount
 * shows the same fields, the session it made and the same client_key, so a retry after a failure creates the session
 * once. Memory only (a reload forgets it); forgotten as soon as nothing is left unsaved.
 */
type ReadingFormData = {
  form: Form;
  touched: Record<Field, boolean>;
  /** Fields holding a Say it draft's values. */
  fromDraft: DraftMarks | null;
  /** The session this form made (POST), edited by every later save (PATCH); null = the next save creates one. */
  sessionId: number | null;
  /** Idempotency key of the session being made: a retried create returns the same row. */
  clientKey: string;
  /** The day of the habit row that session made, as the server reported it (sent back on a move or removal). */
  habitCreatedOn: string | null;
  saved: SavedInfo;
  heldDraft: boolean;
  seenDraft: number | null;
  /** The draft whose values are in the form now (cleared from the store once saved; its marks stay). */
  pendingDraft: number | null;
  /** The behavioral day rolled while this entry was not saved: it keeps the day it was made for (sent explicitly). */
  keptDay: boolean;
  /** The last failed save may have been stored anyway (mayHaveStored): its status line says "Not confirmed". */
  unconfirmed: boolean;
  /**
   * DISCARD is the value being saved (Discard, or the form emptied, after a create of this entry got no confirmed
   * answer): once the server says nothing of the entry is stored, the entry goes. An edit before then continues it.
   */
  discarding: boolean;
  /** The Say it draft the discarded entry was made from: dropped from the store with it. */
  discardDraft: number | null;
  /** The last save was a discard the server confirmed: the status line says "Discarded" (or "Removed"). */
  discarded: boolean;
  /**
   * The DISCARD being saved (or just confirmed) is "Remove this session": the status line says Removing / Not removed /
   * Removed. Remove goes through the same retained saver as Discard (Codex review of PR 376, round 4): until the server
   * confirms the removal the entry stays unsaved work, so a failed or malformed answer keeps its session id, key and
   * Retry also across an unmount.
   */
  removal: boolean;
  /**
   * The book on screen when this entry was started (when the form has no book of its own). A restored entry, or a
   * later edit of the session it made, stays with that book even if the current book changes meanwhile.
   */
  entryBook: string | null;
  /** Something was entered: entryBook and entryDay were taken then (cleared when the form is emptied or reset). */
  entryStarted: boolean;
  /** The first send of this create went out (a create with no day chosen: the day rules below). */
  entrySent: boolean;
  /**
   * A create under this entry's client_key went out, with or without a day (its outcome may be unknown): from then on
   * Discard and emptying the form go through the server, which may hold that session. Cleared with a new key.
   */
  createSent: boolean;
  /**
   * The day this entry is for when no day was chosen: the day on screen when it was started, if that day was current
   * then (the server's last answer said so and the day has not rolled since on the Eastern or this device's clock, or
   * it is the day by one of those clocks); else the day on screen at the first send, if the server had confirmed it by
   * then. The first send lets the server's behavioral today apply while that is still this day; every later send of
   * the same create (a retry, also one running while the section is away) and a first send after the day rolled on
   * either clock carry it, so the session never moves to the next day (dayRolledSince).
   * Null = unknown (the day on screen could be stale, e.g. an offline first paint from the cache): the server decides,
   * and the form then shows the day it stored.
   */
  entryDay: string | null;
};

/**
 * The form's action buttons (Discard, Remove, New session, the removal's Retry) decide themselves what happens to
 * the entry, so reaching one never saves it first. The form saves on blur; without this, pressing Discard while a field
 * has focus moved focus to the button, the field's blur created the session, and the button was disabled (busy) or
 * gone before the click landed (PROD-T01). A mouse press keeps focus where it is (mousedown prevented: no blur at all);
 * focus moving to one of them (Tab) skips the blur save. A touch press can still blur the field, often with no
 * relatedTarget (iOS Safari does not focus a tapped button), so the press itself is remembered (pointerdown and
 * touchstart both come before that blur) and the next blur within PRESS_MS skips the save; the click, that blur, or
 * the touch being cancelled (it became a scroll) clears it. Skipping only drops the immediate save: what is waiting
 * still goes on its pause timer unless the button drops it. Leaving the form from anywhere else still saves at once.
 */
const BLUR_SKIP_ATTR = "data-autosave-blur-skip";
const PRESS_MS = 1000;
function skipsBlurSave(next: EventTarget | null): boolean {
  const el = next as { closest?: (selector: string) => unknown } | null;
  return !!el && typeof el.closest === "function" && !!el.closest(`[${BLUR_SKIP_ATTR}]`);
}

/**
 * Whether the behavioral day may have rolled between `at` and now. The server's day follows where Riley is (travel-aware,
 * pds.behavioral_today_now), so 06:00 is checked on two clocks: Eastern, and this device's own zone, which a phone
 * keeps on local time while travelling. A roll on either counts. Eastern alone missed 06:00 Pacific (09:00 Eastern): an
 * entry started before it and sent after went out without its day and was stored on the next one (PROD-T01).
 */
function dayRolledSince(at: number, now = new Date()): boolean {
  const then = new Date(at);
  return fallbackBehavioralToday(then) !== fallbackBehavioralToday(now) || deviceBehavioralDay(then) !== deviceBehavioralDay(now);
}
/** `day` is behavioral today by the Eastern clock or by this device's clock (a guess while no answer confirms it). */
function isClockDay(day: string, now = new Date()): boolean {
  return day === fallbackBehavioralToday(now) || day === deviceBehavioralDay(now);
}

/**
 * The form's `unknownOutcome` (lib/autosave.ts): every failed save that is not a refusal may have been stored anyway.
 * The request can reach the server and commit while its answer is lost (the connection drops, a gateway error page, a
 * 5xx after the write), and the browser cannot tell that from a request that never arrived. Until a save is answered,
 * no value then counts as already saved: an edit that failed this way and was changed back to the last confirmed
 * values is sent (to the same session), instead of the retry being dropped and "Saved" shown while the server may hold
 * the edit (Codex T01-R3). Resending is safe: a create carries its client_key, an edit writes the same values again.
 */
const mayHaveStored = (e: unknown) => !(e instanceof AutosaveRefused);

const newReadingData = (): ReadingFormData => ({
  form: blankForm(""),
  touched: { ...EMPTY_FIELDS },
  fromDraft: null,
  sessionId: null,
  clientKey: "",
  habitCreatedOn: null,
  saved: null,
  heldDraft: false,
  seenDraft: null,
  pendingDraft: null,
  keptDay: false,
  unconfirmed: false,
  discarding: false,
  discardDraft: null,
  discarded: false,
  removal: false,
  entryBook: null,
  entryStarted: false,
  entrySent: false,
  createSent: false,
  entryDay: null,
});

export default function ReadingSection() {
  const [data, setData] = useState<ReadingAnswer | null>(() => asReading(clientCache.peek(READING_URL)));
  const [loadFailed, setLoadFailed] = useState(false);
  const alive = useRef(true);
  const o = data?.overview ?? null;
  const today = o?.today ?? "";
  const overviewRef = useRef(o);
  overviewRef.current = o;
  // When the server last answered with the overview (not a cached copy): its `today` was current then.
  const confirmedAt = useRef<number | null>(null);
  /** The day on screen is the server's today: confirmed by an answer, and 06:00 has not passed since on either clock. */
  const shownDayIsCurrent = () => {
    const at = confirmedAt.current;
    return at !== null && !dayRolledSince(at);
  };
  /** `day` is the server's behavioral today now: the overview on screen says so, and that is still current. */
  const isCurrentDay = (day: string) => shownDayIsCurrent() && overviewRef.current?.today === day;

  // The saver and the form's state (`kept`) outlive this component while the entry is not saved. Its save may run
  // after an unmount (a retry): it reads and writes `kept` only, and touches React state only while mounted.
  // saveSession is one save of the session form (the create, or an edit of the session it made); the autosaver's save
  // below wraps it to remember whether a failure may have been stored anyway.
  const saveSession = async (v: FormValue, ctx: RetainedSaveContext, rekeyed = false): Promise<void> => {
    const { keepalive, cancelled } = ctx;
    // ready() keeps an incomplete value from getting here; never report "Saved" without a request.
    // cancelled(): the session ended while this save was under way (sign-out, a 401): it stops after the request
    // that is out, before any further request (a replay's PATCH), any write to `kept` and any refetch.
    if (v.discard) return discardStored({ keepalive, cancelled });
    if (!v.body) throw new AutosaveRefused(v.reason ?? "Enter the chapter you read through to save.");
    const id = kept.sessionId;
    const target = readingSaveTarget("sessions", id);
    const send = (url: string, method: string, body: Record<string, unknown>) => saveRequest(url, { method, body, keepalive });
    let json: Record<string, unknown>;
    try {
      if (id === null) {
        if (!kept.clientKey) kept.clientKey = newClientKey();
        const body: Record<string, unknown> = { ...v.body, client_key: kept.clientKey };
        if (v.body.date === null) {
          // No day chosen: the entry is for its own day (entryDay). The first send lets the server's behavioral
          // today apply while that is still the entry's day; a first send after the day rolled (the entry was
          // started before 06:00 and finished after, with no new answer from the server in between) and every
          // later send of this create carry that day, whether or not this copy is still mounted.
          const first = !kept.entrySent;
          if (first && kept.entryDay === null && shownDayIsCurrent()) kept.entryDay = kept.form.date || overviewRef.current?.today || null;
          kept.entrySent = true;
          if (kept.entryDay && !(first && isCurrentDay(kept.entryDay))) body.date = kept.entryDay;
        }
        kept.createSent = true;
        json = await send(target.url, "POST", body);
      } else {
        json = await send(target.url, "PATCH", { ...v.body, habit_created_on: kept.habitCreatedOn });
      }
    } catch (e) {
      if (cancelled()) return;
      if (id === null && !rekeyed && e instanceof AutosaveRefused && /was discarded/i.test(e.message)) {
        // 409 discarded: an earlier Discard of this entry reached the server although its answer was lost, and the
        // entry was edited since (the edit continues it). Nothing is stored under the old key and nothing can be any
        // more, so the entry is created under a new key, at once.
        kept.clientKey = newClientKey();
        kept.createSent = false;
        return saveSession(v, ctx, true);
      }
      if (id !== null && e instanceof AutosaveRefused && /no longer exists/i.test(e.message)) {
        // Removed elsewhere: Retry logs it again as a new session (a new key: the old one named a removed row).
        if (kept.sessionId === id) {
          setSessionId(null);
          kept.clientKey = newClientKey();
          kept.createSent = false;
          kept.habitCreatedOn = null;
        }
        throw new AutosaveRefused("That session was removed elsewhere. Retry logs it again.");
      }
      throw e;
    }
    if (cancelled()) return;
    const session = json.session as ReadingSession | undefined;
    if (id === null && session?.session_id && kept.sessionId === null) {
      setSessionId(session.session_id);
      // The server chose the day (the day on screen was not known to be current): show the day it stored.
      const stored = typeof session.session_date === "string" && isYmd(session.session_date) ? session.session_date : null;
      if (v.body.date === null && stored && !kept.touched.date && kept.form.date !== stored) {
        kept.entryDay = stored;
        setForm({ ...kept.form, date: stored });
      }
      if (json.replayed) {
        // A retry of a create whose answer was lost: the stored row holds the values of the first send, so the
        // values on screen now are written onto it.
        json = await send(readingSaveTarget("sessions", session.session_id).url, "PATCH", { ...v.body, habit_created_on: kept.habitCreatedOn });
        if (cancelled()) return;
      }
    }
    if (typeof json.habit_created_on === "string" || json.habit_created_on === null) kept.habitCreatedOn = (json.habit_created_on as string | null) ?? null;
    setSaved({ xp: Number(json.xp_gained) || 0, finished: !!json.finished });
    showOverview(json.overview as ReadingOverview | null | undefined);
    const savedDraft = kept.pendingDraft;
    if (savedDraft !== null) {
      kept.pendingDraft = null; // first: dropping it from the store must not read as "dismissed before saving"
      clear(savedDraft);
    }
  };
  /**
   * The discard of an entry whose create may have been stored (DISCARD): the session that create made, if any, is
   * removed by its id when an answer arrived after all, else by its client_key (DELETE /api/reading/sessions?client_key=,
   * which never creates anything). Only once the server answered does the entry go: until then it is kept and retried
   * like any save, so a create whose answer was lost never stays stored with its habit stamp, XP and Notion entry after
   * Discard (Codex review r1 of PR 376: dropping the entry and its key on the spot left exactly that behind).
   */
  const discardStored = async ({ keepalive, cancelled }: RetainedSaveContext): Promise<void> => {
    const id = kept.sessionId;
    const day = kept.habitCreatedOn;
    const url =
      id !== null
        ? `/api/reading/sessions/${id}${day ? `?habit_created_on=${encodeURIComponent(day)}` : ""}`
        : kept.clientKey
          ? `/api/reading/sessions?client_key=${encodeURIComponent(kept.clientKey)}`
          : null;
    let overview: ReadingOverview | null | undefined;
    if (url) {
      const res = await fetch(url, { method: "DELETE", keepalive });
      // Only the removal's own receipt lets the entry go (Codex T01-R8): 200 naming this session id or this key (or
      // 404 "session_gone" for an id). An empty, malformed or redirected answer is retried and the entry, its draft
      // and its key stay. A refusal is shown and not retried.
      const reply = await readRemovalReply(res, id !== null ? { sessionId: id } : { clientKey: kept.clientKey }, kept.removal ? "Removing the session" : undefined);
      if (cancelled()) return;
      if (reply.kind === "refused") throw new AutosaveRefused(reply.error);
      if (reply.kind === "unconfirmed") throw new Error(reply.error);
      overview = reply.overview;
    }
    if (cancelled()) return;
    // Nothing of the entry is stored now, and the server will create nothing more under its key (recorded as
    // discarded). An edit made while this was out continues the entry, created under a new key next; otherwise the
    // entry goes, with the Say it words it was made from.
    setSessionId(null);
    kept.clientKey = newClientKey();
    kept.createSent = false;
    kept.habitCreatedOn = null;
    setSaved(null);
    if (kept.discarding) {
      const words = kept.discardDraft;
      const removal = kept.removal;
      forgetEntry();
      kept.discarded = true;
      kept.removal = removal;
      if (words !== null) clear(words);
    }
    showOverview(overview);
  };
  const autosave = useRetainedAutosave<SessionValue, ReadingFormData>(
    "log-reading",
    {
      delayMs: 1500,
      ready: (v) => v.reason,
      same: sameValue,
      // A failure that may have been stored anyway leaves no value counted as saved until a save is answered.
      unknownOutcome: mayHaveStored,
      save: async (v, ctx) => {
        let unconfirmed = false;
        try {
          await saveSession(v, ctx);
        } catch (e) {
          unconfirmed = mayHaveStored(e);
          throw e;
        } finally {
          // The status line says "Not confirmed" for such a failure, also on the next mount. A session that ended
          // while this save ran writes nothing to `kept`.
          if (!ctx.cancelled()) kept.unconfirmed = unconfirmed;
        }
      },
    },
    newReadingData,
  );
  const kept = autosave.data;

  const [form, setFormState] = useState<Form>(() => kept.form);
  const [fromDraft, setFromDraftState] = useState<DraftMarks | null>(() => kept.fromDraft);
  const [sessionId, setSessionIdState] = useState<number | null>(() => kept.sessionId);
  const [saved, setSavedState] = useState<SavedInfo>(() => kept.saved);
  const [heldDraft, setHeldDraftState] = useState(() => kept.heldDraft);
  const { draft, clear } = useLogDrafts("reading");
  // The status line under the form: the fields point at it while it says why the entry is not saved.
  const statusId = `log-reading-status${useId().replace(/:/g, "")}`;

  const setForm = (next: Form) => {
    kept.form = next;
    setFormState(next);
  };
  const setFromDraft = (next: DraftMarks | null) => {
    kept.fromDraft = next;
    setFromDraftState(next);
  };
  const setSessionId = (id: number | null) => {
    kept.sessionId = id;
    if (alive.current) setSessionIdState(id);
  };
  const setSaved = (next: SavedInfo) => {
    kept.saved = next;
    if (alive.current) setSavedState(next);
  };
  const setHeldDraft = (next: boolean) => {
    kept.heldDraft = next;
    setHeldDraftState(next);
  };
  // A save that was already under way when this copy mounted (a retry while the Log page was away, or the send of the
  // copy that just unmounted) wrote `kept` only, through that copy's setters: show what it made, including the day
  // the server stored the session on when it chose the day. Every setter here writes `kept` and the state together,
  // so they differ only after such a save.
  useEffect(() => {
    setSessionIdState((prev) => (prev === kept.sessionId ? prev : kept.sessionId));
    setSavedState((prev) => (prev === kept.saved ? prev : kept.saved));
    setFormState((prev) => (prev === kept.form ? prev : kept.form));
    setFromDraftState((prev) => (prev === kept.fromDraft ? prev : kept.fromDraft));
    setHeldDraftState((prev) => (prev === kept.heldDraft ? prev : kept.heldDraft));
  }, [autosave.state, kept]);

  const show = useCallback((raw: unknown) => {
    const v = asReading(raw);
    if (v && alive.current) setData((prev) => (sameJson(prev, v) ? prev : v));
  }, []);
  /** A network answer (cachedJson revalidates): shown, and its day counts as confirmed. */
  const showAnswer = useCallback((raw: unknown) => {
    if (asReading(raw)) confirmedAt.current = Date.now();
    show(raw);
  }, [show]);

  // A press on one of the form's action buttons is under way (see BLUR_SKIP_ATTR): when it started, else null.
  const pressAt = useRef<number | null>(null);
  const notePress = () => {
    pressAt.current = Date.now();
  };
  // A touch that turned into a scroll (or was taken over by the browser) is no press: a later blur saves at once.
  const dropPress = () => {
    pressAt.current = null;
  };
  const keepsFocus = {
    [BLUR_SKIP_ATTR]: "",
    onPointerDown: notePress,
    onTouchStart: notePress,
    onPointerCancel: dropPress,
    onTouchCancel: dropPress,
    onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
  };
  const onFormBlur = (next: EventTarget | null) => {
    const at = pressAt.current;
    pressAt.current = null;
    if ((at !== null && Date.now() - at < PRESS_MS) || skipsBlurSave(next)) return;
    void autosave.flush();
  };

  // The routed page's first read takes the GET its HTML already started (lib/log-early.ts), once.
  const routed = !useInFeed();
  const load = useCallback(() => {
    setLoadFailed(false);
    cachedJson(READING_URL, { check: checkReading, get: logEarlyGet(READING_URL, routed) })
      .then(showAnswer)
      .catch(() => { if (alive.current) setLoadFailed(true); });
  }, [showAnswer, routed]);

  useEffect(() => {
    alive.current = true;
    if (!clientCache.peek(READING_URL)) void clientCache.read(READING_URL).then(show).catch(() => {});
    // A save on /reading or Today updates this one; a removal (write invalidation) keeps what is shown until the
    // refetch answers.
    const unsub = clientCache.subscribe(READING_URL, (v) => { if (v !== undefined) show(v); });
    load();
    return () => { alive.current = false; unsub(); };
  }, [load, show]);

  /** The server answered with a fresh overview of the book on screen: show it, and let other screens refetch. */
  const showOverview = (overview: ReadingOverview | null | undefined) => {
    const cur = overviewRef.current;
    if (overview && cur && overview.book.slug === cur.book.slug && alive.current) setData((prev) => (prev ? { ...prev, overview } : prev));
    void cachedJson(READING_URL, { check: checkReading }).then(showAnswer).catch(() => {});
  };

  /** What the form is worth as a request right now. */
  const valueOf = (f: Form): SessionValue => {
    const cur = overviewRef.current;
    const marks = kept.fromDraft?.fields;
    const book = f.book || kept.entryBook || cur?.book.slug || "";
    if (!book) return { body: null, reason: "No book in progress to log this session for." };
    const otherBook = cur && book && book !== cur.book.slug ? book : null;
    const day = f.date || cur?.today || "";
    const chosenDay = kept.touched.date || kept.keptDay || marks?.date ? day : null;
    return sessionValue(f, { book, chosenDay, today: cur?.today ?? "", total: otherBook ? null : cur?.totalChapters || null });
  };

  /** The form changed by Riley or his Say it words: show it and hand it to the autosaver. */
  const commit = (next: Form) => {
    setForm(next);
    // Any change continues the entry: a discard (or removal) still waiting or out no longer drops it (DISCARD is
    // replaced).
    kept.discarding = false;
    kept.discardDraft = null;
    kept.discarded = false;
    kept.removal = false;
    const cur = overviewRef.current;
    const anyBook = !!next.book && next.book !== cur?.book.slug;
    if (kept.sessionId === null && !anyBook && !kept.touched.date && isBlankSession(next, { medium: DEFAULT_MEDIUM })) {
      if (kept.createSent) {
        // Back to nothing typed after a create of this entry went out with no confirmed answer: the server may hold
        // that session, so emptying the form is saved like any edit (DISCARD removes it by its client_key) instead of
        // being dropped as nothing to save (the create's version of Codex T01-R3). The form is clean once it is gone.
        kept.discarding = true;
        autosave.change(DISCARD);
        return;
      }
      autosave.reset(); // back to nothing typed: nothing to save, nothing unsaved
      kept.entryBook = null;
      kept.entryStarted = false;
      kept.entrySent = false;
      kept.createSent = false;
      kept.entryDay = null;
      if (kept.keptDay) {
        // Nothing left of the entry that kept its day: the empty form follows today again.
        kept.keptDay = false;
        const t = overviewRef.current?.today;
        if (t && next.date !== t) setForm({ ...next, date: t });
      }
      return;
    }
    // The entry belongs to the book on screen now, also if the current book changes before it is saved, and to the
    // day on screen when that day is current (an entry started before 06:00 keeps its day when finished after).
    if (!kept.entryBook && cur) kept.entryBook = cur.book.slug;
    if (!kept.entryStarted && kept.sessionId === null) {
      kept.entryStarted = true;
      const shown = next.date || cur?.today || "";
      kept.entryDay = shown && (isCurrentDay(shown) || isClockDay(shown)) ? shown : null;
    }
    autosave.change(valueOf(next));
  };

  // The behavioral day the server reports: an untouched date follows it (first load, a new day). Not an entry. An
  // entry made for the previous day and not saved yet (a create that failed, or is still incomplete; kept across a
  // remount) keeps that day instead, sent explicitly from now on, so a retry after the rollover never moves it to
  // the new day. The form shows "For <that day>" and Riley can still change it.
  useEffect(() => {
    if (!today || kept.touched.date || kept.keptDay || kept.fromDraft?.fields.date || kept.discarding) return;
    const f = kept.form;
    if (f.date === today) return;
    if (kept.sessionId !== null && f.date) return; // a session already made stays on its own day, also on screen
    // An entry whose day on screen could have been stale (entryDay null) leaves the day to the server: the form follows.
    if (f.date && f.date < today && kept.sessionId === null && autosave.dirty && kept.entryDay === f.date) {
      kept.keptDay = true;
      commit(f);
      return;
    }
    setForm({ ...f, date: today });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const set = (field: Field, patch: Partial<Form>) => {
    kept.touched[field] = true;
    const fd = kept.fromDraft;
    if (fd?.fields[field]) setFromDraft({ ...fd, fields: { ...fd.fields, [field]: false } });
    commit({ ...kept.form, ...patch });
  };

  /** Forget the entry on screen (its fields, the session it made, its key and marks) for a fresh, empty one. */
  const forgetEntry = () => {
    setSessionId(null);
    kept.clientKey = newClientKey();
    kept.habitCreatedOn = null;
    setHeldDraft(false);
    kept.touched = { ...EMPTY_FIELDS };
    kept.keptDay = false;
    kept.unconfirmed = false;
    kept.discarding = false;
    kept.discardDraft = null;
    kept.discarded = false;
    kept.removal = false;
    kept.entryBook = null;
    kept.entryStarted = false;
    kept.entrySent = false;
    kept.createSent = false;
    kept.entryDay = null;
    kept.pendingDraft = null;
    setFromDraft(null);
    setSaved(null);
    setForm(blankForm(overviewRef.current?.today ?? ""));
  };

  /** Start the next session: the one on screen is kept as saved. */
  const startNew = useCallback(() => {
    forgetEntry();
    autosave.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosave.reset, kept]);

  /**
   * Discard the entry not saved yet (offered when its book is no longer in progress). The Say it words it was made
   * from go with it: left in the shared draft store, the next mount (a fresh form, since nothing is kept) would apply
   * them again and save them. Words this entry was not made from (a newer draft, or one waiting for the session
   * above to be saved) stay offered. An entry none of whose creates went out is dropped at once. Once a create went
   * out with no confirmed answer the server may hold that session, so its key is kept and DISCARD is saved like any
   * edit (one request in flight with the create's retry, retried, kept across an unmount): the entry goes once the
   * server says nothing of it is stored (discardStored). Pressed again after a failure it tries again.
   */
  const discardEntry = () => {
    const d = draft;
    const words = d && (d.id === kept.pendingDraft || d.id === kept.fromDraft?.id) ? d.id : null;
    if (kept.sessionId === null && !kept.createSent) {
      startNew(); // first: the marks and pendingDraft go, so dropping the draft below reverts nothing
      if (words !== null) clear(words);
      return;
    }
    kept.discarding = true;
    kept.discardDraft = words;
    kept.discarded = false;
    kept.removal = false;
    autosave.change(DISCARD);
    void autosave.retry(); // at once; also after a refused discard, which change() alone would leave as it was
  };

  const applyDraft = async (force: boolean) => {
    if (!draft) return;
    const d = draft;
    // Words about another session: the session already made from this form keeps its values (anything still
    // waiting is sent first), and the words fill a new one. If that send fails the form stays as it is and the
    // words wait (Use, once it is saved).
    // Words that arrive while the entry is being discarded wait for that too, then fill the fresh form.
    if (kept.sessionId !== null || kept.discarding) {
      const ok = await autosave.flush();
      if (!alive.current) return;
      if (!ok) {
        setHeldDraft(true);
        return;
      }
      if (kept.sessionId !== null) startNew();
    }
    const vals = draftFields(d.value);
    const applied: Record<Field, boolean> = { ...EMPTY_FIELDS };
    const patch: Partial<Form> = {};
    for (const key of Object.keys(vals) as Field[]) {
      if (!force && kept.touched[key]) continue;
      (patch as Record<string, unknown>)[key] = vals[key];
      applied[key] = true;
      if (force) kept.touched[key] = false;
    }
    setFromDraft({ id: d.id, fields: applied });
    kept.pendingDraft = d.id;
    commit({ ...kept.form, ...patch });
  };

  useEffect(() => {
    if (!draft || kept.seenDraft === draft.id) return;
    kept.seenDraft = draft.id;
    void applyDraft(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  /** Take the draft's values out of the fields Riley has not changed (they were never kept). */
  const revertDraftFields = () => {
    const fd = kept.fromDraft;
    if (!fd) return;
    const blank = blankForm(overviewRef.current?.today ?? "");
    const next = { ...kept.form };
    for (const key of Object.keys(fd.fields) as Field[]) {
      if (fd.fields[key] && !kept.touched[key]) (next as Record<string, unknown>)[key] = blank[key];
    }
    setFromDraft(null);
    kept.pendingDraft = null;
    commit(next);
  };

  useEffect(() => {
    // The draft left the store before its values were saved (dismissed elsewhere): they go too, so nothing Riley
    // did not keep is saved. A newer draft is handled by applyDraft above. A saved draft keeps its marks.
    const f = kept.fromDraft;
    if (f && !draft && kept.pendingDraft === f.id && kept.sessionId === null && !kept.discarding) revertDraftFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const dismissDraft = () => {
    revertDraftFields();
    clear(draft?.id);
  };

  /**
   * Remove the session this form made. Saved through the retained autosaver like Discard (DISCARD, removed by its id in
   * discardStored), never as a request on the side (Codex review of PR 376, round 4): before, the saver was reset
   * first, so a failed or malformed DELETE answer left a form the saver counted as clean, and an unmount then dropped
   * the session id, the key and the Retry. Now an edit still waiting is replaced by the removal (it belongs to the
   * session being removed, so it is never sent), the entry stays unsaved work until the route's own receipt arrives
   * (retried, also while the section is away), and only then does the form start fresh. Pressed again after a failure
   * it tries again at once.
   */
  const removeSession = () => {
    if (kept.sessionId === null) return;
    kept.discarding = true;
    kept.discardDraft = null;
    kept.discarded = false;
    kept.removal = true;
    autosave.change(DISCARD);
    void autosave.retry(); // at once; also after a failed removal, which change() alone would leave as it was
  };

  const marked = (field: Field) => !!fromDraft?.fields[field];
  const anyMarked = !!fromDraft && Object.values(fromDraft.fields).some(Boolean);
  const draftUnused = !!draft && (!fromDraft || fromDraft.id !== draft.id || !anyMarked);
  const st = autosave.state.status;
  const busy = st === "saving";
  const removing = st === "saving" && kept.discarding && kept.removal;

  // An entry this form still holds (not saved yet, or the session it made) stays on screen with its fields, reason
  // and Retry also when there is no book in progress any more (the book was finished or set aside elsewhere) or the
  // overview cannot be read: it is drawn for its own book, from the book list.
  const keptEntry = !o && (sessionId !== null || autosave.dirty);
  if (!data && !loadFailed) return <SectionSkeleton section="reading" />;
  const loadError = (
    <div className="flex items-center gap-3">
      <p className="text-[13px] text-down">Couldn&apos;t load reading.</p>
      <button type="button" onClick={load} className="min-h-11 px-3 text-[13px] text-text-secondary hover:text-text-primary underline underline-offset-2">
        Retry
      </button>
    </div>
  );
  const noBook = <p className="text-[13px] text-text-tertiary">No book in progress.</p>;
  if (!o && !keptEntry) {
    return (
      <LogCard title="Reading" id="log-section-reading">
        {data ? noBook : loadError}
      </LogCard>
    );
  }

  const entryBook = form.book || kept.entryBook;
  const otherBook = entryBook && (!o || entryBook !== o.book.slug) ? entryBook : null;
  const otherBookTitle = otherBook ? data?.books?.find((b) => b.slug === otherBook)?.title ?? otherBook : null;
  const total = o?.totalChapters || 0;
  const done = o?.chaptersDone ?? 0;
  const next = total ? Math.min(total, done + 1) : done + 1;
  const chips = o ? [next, next + 1].filter((n, i, all) => n >= 0 && (!total || n <= total) && all.indexOf(n) === i) : [];
  const todaySessions = o ? o.sessions.filter((s) => s.session_date === o.today) : [];
  const pace = o?.pace;
  const paceText = !o || !pace
    ? ""
    : o.book.status === "finished"
      ? "finished"
      : pace.aheadBy === 0
        ? "on pace"
        : pace.aheadBy > 0
          ? `${pace.aheadBy} ahead`
          : `${-pace.aheadBy} behind`;
  const paceClass = !o || !pace || o.book.status === "finished" || pace.aheadBy >= 0 ? "text-up" : pace.aheadBy >= -2 ? "text-[var(--color-mid)]" : "text-down";
  const mediaOptions = form.medium === "kindle" ? [...MEDIA, { key: "kindle" as Medium, label: "Kindle" }] : MEDIA;
  const day = form.date || today;
  const anyTouched = Object.values(kept.touched).some(Boolean) || anyMarked;
  const describedBy = (st === "incomplete" && anyTouched) || st === "error" ? statusId : undefined;
  const savedText = kept.discarded ? (kept.removal ? "Removed" : "Discarded") : `Saved${saved?.finished ? " · book finished" : ""}${saved?.xp ? ` · +${saved.xp} XP` : ""}`;
  // A failure of the save on screen: a refusal reads "Not saved:" (the server answered), anything else may have gone
  // through ("Not confirmed:"); a failed discard says so instead.
  const errorLabel =
    st !== "error"
      ? undefined
      : kept.discarding
        ? kept.removal
          ? kept.unconfirmed ? "Removal not confirmed:" : "Not removed:"
          : kept.unconfirmed ? "Discard not confirmed:" : "Not discarded:"
        : kept.unconfirmed ? "Not confirmed:" : undefined;

  const inputCls =
    "mt-1 w-full min-h-11 px-3 text-[16px] font-mono tabular-nums bg-surface-sunken border border-border-subtle rounded-control text-text-primary placeholder:text-text-tertiary/60 focus:border-accent/60 outline-none";
  const labelCls = "text-[11px] font-mono uppercase tracking-wider text-text-tertiary";

  return (
    <LogCard
      title="Reading"
      id="log-section-reading"
      action={o ? <span className="font-mono text-[12px] tabular-nums text-text-secondary">ch {o.chaptersDone} / {total || "?"}</span> : undefined}
    >
      {!o ? (data ? noBook : loadError) : (
      <>
      <div>
        <p className="text-[14px] text-text-primary truncate">{o.book.title}</p>
        <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden" aria-hidden="true">
          <div className="h-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, o.percent))}%` }} />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] font-mono text-text-tertiary">
          <span>{o.percent}%</span>
          <span className={paceClass}>{paceText}</span>
          <span>streak {o.streak.current}d</span>
          {o.position?.chapter != null && (
            <span>
              Kindle ch {o.position.chapter}
              {o.position.page != null ? ` · p. ${o.position.page}` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="mt-3">
        <h3 className={labelCls}>Today</h3>
        {todaySessions.length ? (
          <ul className="divide-y divide-border-subtle">
            {todaySessions.map((s) => <SessionLine key={s.session_id} s={s} />)}
          </ul>
        ) : (
          <p className="mt-1 text-[13px] text-text-tertiary">Nothing logged today.</p>
        )}
      </div>
      </>
      )}

      <form
        noValidate
        onSubmit={(e) => { e.preventDefault(); void autosave.flush(); }}
        onBlur={(e) => onFormBlur(e.relatedTarget)}
        onClick={() => { pressAt.current = null; }}
        className="mt-4 border-t border-border-subtle pt-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className={labelCls}>{sessionId !== null ? "This session" : "Audio or paper session"}</h3>
          {anyMarked && (
            <span className="flex items-center gap-2">
              <DraftMark />
              {sessionId === null && (
                <button type="button" onClick={dismissDraft} className="min-h-11 px-1 text-[12px] text-text-tertiary hover:text-text-primary underline underline-offset-2">
                  Dismiss
                </button>
              )}
            </span>
          )}
        </div>

        {heldDraft && draftUnused && draft && (
          <p className="mt-1 text-[12px] text-text-secondary">The session above isn&apos;t saved yet, so these words wait. Tap Use once it is saved.</p>
        )}
        {draftUnused && draft && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <DraftMark />
            <span className="font-mono text-text-secondary">{draftSummary(draft.value)}</span>
            <button type="button" onClick={() => void applyDraft(true)} className="min-h-11 px-1 text-accent underline underline-offset-2">Use</button>
            <button type="button" onClick={dismissDraft} className="min-h-11 px-1 text-text-tertiary hover:text-text-primary underline underline-offset-2">Dismiss</button>
          </div>
        )}

        {otherBookTitle && (
          <p className="mt-1 text-[12px] text-text-secondary">
            Book: {otherBookTitle} {marked("book") && <DraftMark className="ml-1" />}
          </p>
        )}

        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Medium">
          {mediaOptions.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => set("medium", { medium: m.key })}
              aria-pressed={form.medium === m.key}
              className={`min-h-11 px-4 rounded-control border text-[13px] ${form.medium === m.key ? "bg-accent/15 border-accent/60 text-accent" : "border-border-subtle text-text-tertiary hover:text-text-primary"}`}
            >
              {m.label}
            </button>
          ))}
          {marked("medium") && <DraftMark className="self-center" />}
        </div>
        {form.medium === "kindle" && (
          <p className="mt-1 text-[12px] text-text-secondary">Kindle days are logged automatically from your highlights.</p>
        )}

        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="block">
            <span className={labelCls}>From ch. {marked("from") && <DraftMark />}</span>
            <input
              type="number" inputMode="numeric" min={0} max={(!otherBook && total) || undefined}
              value={form.from}
              aria-describedby={describedBy}
              onChange={(e) => set("from", { from: e.target.value })}
              placeholder="auto"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Through ch. {marked("through") && <DraftMark />}</span>
            <input
              type="number" inputMode="numeric" min={0} max={(!otherBook && total) || undefined}
              value={form.through}
              aria-describedby={describedBy}
              onChange={(e) => set("through", { through: e.target.value })}
              placeholder={o ? String(next) : undefined}
              className={inputCls}
            />
          </label>
        </div>
        {!otherBook && chips.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-text-tertiary">Through</span>
            {chips.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => set("through", { through: String(n) })}
                aria-pressed={form.through === String(n)}
                className={`min-h-11 min-w-11 px-3 rounded-control border font-mono text-[13px] ${form.through === String(n) ? "bg-accent/15 border-accent/60 text-accent" : "border-border-subtle text-text-secondary hover:text-text-primary"}`}
              >
                ch {n}
              </button>
            ))}
          </div>
        )}

        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="block">
            <span className={labelCls}>Minutes {marked("minutes") && <DraftMark />}</span>
            <input
              type="number" inputMode="numeric" min={0}
              value={form.minutes}
              aria-describedby={describedBy}
              onChange={(e) => set("minutes", { minutes: e.target.value })}
              placeholder="30"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Day {marked("date") && <DraftMark />}</span>
            <input
              type="date"
              value={day}
              max={today || undefined}
              aria-describedby={describedBy}
              onChange={(e) => set("date", { date: e.target.value || today })}
              className={inputCls}
            />
          </label>
        </div>

        <label className="mt-2 block">
          <span className={labelCls}>Recall note {marked("recall") && <DraftMark />}</span>
          <textarea
            value={form.recall}
            aria-describedby={describedBy}
            onChange={(e) => set("recall", { recall: e.target.value })}
            rows={2}
            placeholder="Optional, from memory"
            className="mt-1 w-full px-3 py-2 text-[16px] leading-relaxed bg-surface-sunken border border-border-subtle rounded-control text-text-primary placeholder:text-text-tertiary/60 focus:border-accent/60 outline-none"
          />
        </label>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-[12px] text-text-tertiary">
            {day && day !== today ? `For ${fmtDate(day)}` : "For today"}
            {" · "}
            <AutosaveStatus
              id={statusId}
              state={autosave.state}
              onRetry={() => void autosave.retry()}
              savedText={savedText}
              showIncomplete={anyTouched}
              errorLabel={errorLabel}
              savingText={kept.discarding ? (kept.removal ? "Removing…" : "Discarding…") : undefined}
            />
          </span>
          {sessionId === null && !o && (
            <button
              type="button"
              {...keepsFocus}
              onClick={discardEntry}
              disabled={busy}
              className="min-h-11 px-2 text-[12px] text-text-tertiary hover:text-text-primary underline underline-offset-2 disabled:opacity-40"
            >
              Discard this entry
            </button>
          )}
          {sessionId !== null && (
            <span className="flex items-center gap-1">
              <button
                type="button"
                {...keepsFocus}
                onClick={removeSession}
                disabled={busy}
                className="min-h-11 px-2 text-[12px] text-text-tertiary hover:text-down underline underline-offset-2 disabled:opacity-40"
              >
                {removing ? "Removing…" : "Remove this session"}
              </button>
              <button
                type="button"
                {...keepsFocus}
                onClick={() => void autosave.flush().then((ok) => { if (ok && alive.current) startNew(); })}
                disabled={busy || st === "error"}
                className="min-h-11 px-4 rounded-full text-[13px] font-medium border border-border-subtle text-text-secondary hover:text-text-primary disabled:opacity-40"
              >
                New session
              </button>
            </span>
          )}
        </div>
      </form>
    </LogCard>
  );
}
