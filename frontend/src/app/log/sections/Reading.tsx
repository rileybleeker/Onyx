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
import { fallbackBehavioralToday } from "@/lib/checkin";
import { isBlankSession, newClientKey, readingSaveTarget, sameReadingValue, sessionValue, type SessionValue } from "@/lib/reading-autosave";
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
 * with its reason and Retry when its book is no longer in progress (or the overview cannot be read), with Discard.
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
  /**
   * The book on screen when this entry was started (when the form has no book of its own). A restored entry, or a
   * later edit of the session it made, stays with that book even if the current book changes meanwhile.
   */
  entryBook: string | null;
  /** Something was entered: entryBook and entryDay were taken then (cleared when the form is emptied or reset). */
  entryStarted: boolean;
  /** The first send of this create went out. */
  entrySent: boolean;
  /**
   * The day this entry is for when no day was chosen: the day on screen when it was started, if that day was current
   * then (the server's last answer said so and the day has not rolled since, or it is the clock's day); else the day
   * on screen at the first send, if the server had confirmed it by then. The first send lets the server's behavioral
   * today apply while that is still this day; every later send of the same create (a retry, also one running while
   * the section is away) and a first send after the day rolled carry it, so the session never moves to the next day.
   * Null = unknown (the day on screen could be stale, e.g. an offline first paint from the cache): the server decides,
   * and the form then shows the day it stored.
   */
  entryDay: string | null;
};

/**
 * The form's action buttons (Discard, Remove, New session, the removal's Retry) decide themselves what happens to
 * the entry, so reaching one never saves it first. The form saves on blur; without this, pressing Discard while a field
 * has focus moved focus to the button, the field's blur created the session, and the button was disabled (busy) or
 * gone before the click landed (PROD-T01). A pointer press keeps focus where it is (no blur at all); focus moving to one
 * of them (Tab) skips the blur save, and leaving the form from one still saves.
 */
const BLUR_SKIP_ATTR = "data-autosave-blur-skip";
const keepsFocus = {
  [BLUR_SKIP_ATTR]: "",
  onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
} as const;
function skipsBlurSave(next: EventTarget | null): boolean {
  const el = next as { closest?: (selector: string) => unknown } | null;
  return !!el && typeof el.closest === "function" && !!el.closest(`[${BLUR_SKIP_ATTR}]`);
}

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
  entryBook: null,
  entryStarted: false,
  entrySent: false,
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
  /** The day on screen is the server's today: confirmed by an answer, and the day has not rolled since (Eastern guess). */
  const shownDayIsCurrent = () => {
    const at = confirmedAt.current;
    return at !== null && fallbackBehavioralToday(new Date(at)) === fallbackBehavioralToday(new Date());
  };
  /** `day` is the server's behavioral today now: the overview on screen says so, and that is still current. */
  const isCurrentDay = (day: string) => shownDayIsCurrent() && overviewRef.current?.today === day;

  // The saver and the form's state (`kept`) outlive this component while the entry is not saved. Its save may run
  // after an unmount (a retry): it reads and writes `kept` only, and touches React state only while mounted.
  const autosave = useRetainedAutosave<SessionValue, ReadingFormData>(
    "log-reading",
    {
      delayMs: 1500,
      ready: (v) => v.reason,
      same: sameReadingValue,
      save: async (v, { keepalive }) => {
        // ready() keeps an incomplete value from getting here; never report "Saved" without a request.
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
            json = await send(target.url, "POST", body);
          } else {
            json = await send(target.url, "PATCH", { ...v.body, habit_created_on: kept.habitCreatedOn });
          }
        } catch (e) {
          if (id !== null && e instanceof AutosaveRefused && /no longer exists/i.test(e.message)) {
            // Removed elsewhere: Retry logs it again as a new session (a new key: the old one named a removed row).
            if (kept.sessionId === id) {
              setSessionId(null);
              kept.clientKey = newClientKey();
              kept.habitCreatedOn = null;
            }
            throw new AutosaveRefused("That session was removed elsewhere. Retry logs it again.");
          }
          throw e;
        }
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
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
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
  // A save that was already under way when this copy mounted (a retry while the Log page was away) wrote `kept`
  // only: show what it made.
  useEffect(() => {
    setSessionIdState((prev) => (prev === kept.sessionId ? prev : kept.sessionId));
    setSavedState((prev) => (prev === kept.saved ? prev : kept.saved));
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
    setRemoveError(null);
    const cur = overviewRef.current;
    const anyBook = !!next.book && next.book !== cur?.book.slug;
    if (kept.sessionId === null && !anyBook && !kept.touched.date && isBlankSession(next, { medium: DEFAULT_MEDIUM })) {
      autosave.reset(); // back to nothing typed: nothing to save, nothing unsaved
      kept.entryBook = null;
      kept.entryStarted = false;
      kept.entrySent = false;
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
      kept.entryDay = shown && (isCurrentDay(shown) || shown === fallbackBehavioralToday(new Date())) ? shown : null;
    }
    autosave.change(valueOf(next));
  };

  // The behavioral day the server reports: an untouched date follows it (first load, a new day). Not an entry. An
  // entry made for the previous day and not saved yet (a create that failed, or is still incomplete; kept across a
  // remount) keeps that day instead, sent explicitly from now on, so a retry after the rollover never moves it to
  // the new day. The form shows "For <that day>" and Riley can still change it.
  useEffect(() => {
    if (!today || kept.touched.date || kept.keptDay || kept.fromDraft?.fields.date) return;
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

  /** Start the next session: the one on screen is kept as saved. */
  const startNew = useCallback(() => {
    setSessionId(null);
    kept.clientKey = newClientKey();
    kept.habitCreatedOn = null;
    setHeldDraft(false);
    kept.touched = { ...EMPTY_FIELDS };
    kept.keptDay = false;
    kept.entryBook = null;
    kept.entryStarted = false;
    kept.entrySent = false;
    kept.entryDay = null;
    setFromDraft(null);
    setSaved(null);
    setRemoveError(null);
    autosave.reset();
    setForm(blankForm(overviewRef.current?.today ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosave.reset, kept]);

  const applyDraft = async (force: boolean) => {
    if (!draft) return;
    const d = draft;
    // Words about another session: the session already made from this form keeps its values (anything still
    // waiting is sent first), and the words fill a new one. If that send fails the form stays as it is and the
    // words wait (Use, once it is saved).
    if (kept.sessionId !== null) {
      const ok = await autosave.flush();
      if (!alive.current) return;
      if (!ok) {
        setHeldDraft(true);
        return;
      }
      startNew();
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
    if (f && !draft && kept.pendingDraft === f.id && kept.sessionId === null) revertDraftFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const dismissDraft = () => {
    revertDraftFields();
    clear(draft?.id);
  };

  const removeSession = async () => {
    const id = kept.sessionId;
    if (id === null || removing) return;
    autosave.reset(); // an edit still waiting belongs to the session being removed
    setRemoving(true);
    setRemoveError(null);
    try {
      const day = kept.habitCreatedOn;
      const res = await fetch(`/api/reading/sessions/${id}${day ? `?habit_created_on=${encodeURIComponent(day)}` : ""}`, { method: "DELETE" });
      const json = (await res.json().catch(() => ({}))) as { error?: string; overview?: ReadingOverview | null };
      if (!res.ok && res.status !== 404) throw new Error(json.error || `HTTP ${res.status}`);
      if (!alive.current) return;
      startNew();
      showOverview(json.overview);
    } catch (e) {
      if (alive.current) setRemoveError(`Couldn't remove the session: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) setRemoving(false);
    }
  };

  const marked = (field: Field) => !!fromDraft?.fields[field];
  const anyMarked = !!fromDraft && Object.values(fromDraft.fields).some(Boolean);
  const draftUnused = !!draft && (!fromDraft || fromDraft.id !== draft.id || !anyMarked);
  const st = autosave.state.status;
  const busy = st === "saving" || removing;

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
  const savedText = `Saved${saved?.finished ? " · book finished" : ""}${saved?.xp ? ` · +${saved.xp} XP` : ""}`;

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
        onBlur={(e) => { if (!skipsBlurSave(e.relatedTarget)) void autosave.flush(); }}
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
            <AutosaveStatus id={statusId} state={autosave.state} onRetry={() => void autosave.retry()} savedText={savedText} showIncomplete={anyTouched} />
          </span>
          {sessionId === null && !o && (
            <button
              type="button"
              {...keepsFocus}
              onClick={startNew}
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
                onClick={() => void removeSession()}
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
        {removeError && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[13px] text-down">
            <p role="alert">{removeError}</p>
            <button
              type="button"
              {...keepsFocus}
              onClick={() => void removeSession()}
              disabled={busy}
              className="min-h-11 px-1 text-text-secondary hover:text-text-primary underline underline-offset-2 disabled:opacity-40"
            >
              Retry
            </button>
          </div>
        )}
      </form>
    </LogCard>
  );
}
