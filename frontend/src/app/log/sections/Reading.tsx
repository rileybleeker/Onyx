"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { useInFeed } from "@/components/FeedContext";
import { AutosaveRefused, saveRequest } from "@/lib/autosave";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import { useLogDrafts, type ReadingLogDraft } from "@/lib/log-drafts";
import { LOG_READING_URL, logEarlyGet } from "@/lib/log-early";
import type { Book, Medium, ReadingOverview, ReadingSession } from "@/lib/reading";
import { isBlankSession, readingSaveTarget, sameReadingValue, sessionValue, type SessionValue } from "@/lib/reading-autosave";
import { useAutosave } from "@/lib/use-autosave";
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

export default function ReadingSection() {
  const [data, setData] = useState<ReadingAnswer | null>(() => asReading(clientCache.peek(READING_URL)));
  const [loadFailed, setLoadFailed] = useState(false);
  const alive = useRef(true);
  const o = data?.overview ?? null;
  const today = o?.today ?? "";
  const overviewRef = useRef(o);
  overviewRef.current = o;

  const [form, setFormState] = useState<Form>(() => blankForm(today));
  const formRef = useRef(form);
  const touched = useRef<Record<Field, boolean>>({ ...EMPTY_FIELDS });
  const [fromDraft, setFromDraftState] = useState<{ id: number; fields: Record<Field, boolean> } | null>(null);
  const fromDraftRef = useRef(fromDraft);
  // The session this form made (POST), edited by every later save (PATCH); null = the next save creates one.
  const [sessionId, setSessionIdState] = useState<number | null>(null);
  const sessionRef = useRef<number | null>(null);
  const [saved, setSaved] = useState<SavedInfo>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const { draft, clear } = useLogDrafts("reading");
  const seenDraft = useRef<number | null>(null);
  // The draft whose values are in the form now (cleared from the store once saved; its marks stay).
  const pendingDraft = useRef<number | null>(null);

  const setForm = (next: Form) => {
    formRef.current = next;
    setFormState(next);
  };
  const setFromDraft = (next: { id: number; fields: Record<Field, boolean> } | null) => {
    fromDraftRef.current = next;
    setFromDraftState(next);
  };
  const setSessionId = (id: number | null) => {
    sessionRef.current = id;
    setSessionIdState(id);
  };

  const show = useCallback((raw: unknown) => {
    const v = asReading(raw);
    if (v && alive.current) setData((prev) => (sameJson(prev, v) ? prev : v));
  }, []);

  // The routed page's first read takes the GET its HTML already started (lib/log-early.ts), once.
  const routed = !useInFeed();
  const load = useCallback(() => {
    setLoadFailed(false);
    cachedJson(READING_URL, { check: checkReading, get: logEarlyGet(READING_URL, routed) })
      .then(show)
      .catch(() => { if (alive.current) setLoadFailed(true); });
  }, [show, routed]);

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
    void cachedJson(READING_URL, { check: checkReading }).then(show).catch(() => {});
  };

  const autosave = useAutosave<SessionValue>("log-reading", {
    delayMs: 1500,
    ready: (v) => v.reason,
    same: sameReadingValue,
    save: async (v, { keepalive }) => {
      if (!v.body) return;
      const id = sessionRef.current;
      const target = readingSaveTarget("sessions", id);
      let json: Record<string, unknown>;
      try {
        json = await saveRequest(target.url, { method: target.method, body: v.body, keepalive });
      } catch (e) {
        if (id !== null && e instanceof AutosaveRefused && /no longer exists/i.test(e.message)) {
          // Removed elsewhere: Retry logs it again as a new session.
          if (sessionRef.current === id) setSessionId(null);
          throw new AutosaveRefused("That session was removed elsewhere. Retry logs it again.");
        }
        throw e;
      }
      const session = json.session as ReadingSession | undefined;
      if (id === null && session?.session_id && sessionRef.current === null) setSessionId(session.session_id);
      if (alive.current) setSaved({ xp: Number(json.xp_gained) || 0, finished: !!json.finished });
      showOverview(json.overview as ReadingOverview | null | undefined);
      const savedDraft = pendingDraft.current;
      if (savedDraft !== null) {
        pendingDraft.current = null; // first: dropping it from the store must not read as "dismissed before saving"
        clear(savedDraft);
      }
    },
  });

  /** What the form is worth as a request right now. */
  const valueOf = (f: Form): SessionValue => {
    const cur = overviewRef.current;
    const marks = fromDraftRef.current?.fields;
    const otherBook = cur && f.book && f.book !== cur.book.slug ? f.book : null;
    const day = f.date || cur?.today || "";
    const chosenDay = touched.current.date || marks?.date ? day : null;
    return sessionValue(f, { book: otherBook ?? cur?.book.slug ?? "", chosenDay, today: cur?.today ?? "", total: otherBook ? null : cur?.totalChapters || null });
  };

  /** The form changed by Riley or his Say it words: show it and hand it to the autosaver. */
  const commit = (next: Form) => {
    setForm(next);
    setRemoveError(null);
    const anyBook = !!next.book && next.book !== overviewRef.current?.book.slug;
    if (sessionRef.current === null && !anyBook && !touched.current.date && isBlankSession(next, { medium: DEFAULT_MEDIUM })) {
      autosave.reset(); // back to nothing typed: nothing to save, nothing unsaved
      return;
    }
    autosave.change(valueOf(next));
  };

  // The behavioral day the server reports: an untouched date follows it (first load, a new day). Not an entry.
  useEffect(() => {
    if (!today || touched.current.date || fromDraftRef.current?.fields.date) return;
    if (formRef.current.date !== today) setForm({ ...formRef.current, date: today });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const set = (field: Field, patch: Partial<Form>) => {
    touched.current[field] = true;
    const fd = fromDraftRef.current;
    if (fd?.fields[field]) setFromDraft({ ...fd, fields: { ...fd.fields, [field]: false } });
    commit({ ...formRef.current, ...patch });
  };

  /** Start the next session: the one on screen is kept as saved. */
  const startNew = useCallback(() => {
    setSessionId(null);
    touched.current = { ...EMPTY_FIELDS };
    setFromDraft(null);
    setSaved(null);
    setRemoveError(null);
    autosave.reset();
    setForm(blankForm(overviewRef.current?.today ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosave.reset]);

  const applyDraft = async (force: boolean) => {
    if (!draft) return;
    const d = draft;
    // Words about another session: the session already made from this form keeps its values (anything still
    // waiting is sent first), and the words fill a new one.
    if (sessionRef.current !== null && !force) {
      await autosave.flush();
      if (!alive.current) return;
      startNew();
    }
    const vals = draftFields(d.value);
    const applied: Record<Field, boolean> = { ...EMPTY_FIELDS };
    const patch: Partial<Form> = {};
    for (const key of Object.keys(vals) as Field[]) {
      if (!force && touched.current[key]) continue;
      (patch as Record<string, unknown>)[key] = vals[key];
      applied[key] = true;
      if (force) touched.current[key] = false;
    }
    setFromDraft({ id: d.id, fields: applied });
    pendingDraft.current = d.id;
    commit({ ...formRef.current, ...patch });
  };

  useEffect(() => {
    if (!draft || seenDraft.current === draft.id) return;
    seenDraft.current = draft.id;
    void applyDraft(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  /** Take the draft's values out of the fields Riley has not changed (they were never kept). */
  const revertDraftFields = () => {
    const fd = fromDraftRef.current;
    if (!fd) return;
    const blank = blankForm(overviewRef.current?.today ?? "");
    const next = { ...formRef.current };
    for (const key of Object.keys(fd.fields) as Field[]) {
      if (fd.fields[key] && !touched.current[key]) (next as Record<string, unknown>)[key] = blank[key];
    }
    setFromDraft(null);
    pendingDraft.current = null;
    commit(next);
  };

  useEffect(() => {
    // The draft left the store before its values were saved (dismissed elsewhere): they go too, so nothing Riley
    // did not keep is saved. A newer draft is handled by applyDraft above. A saved draft keeps its marks.
    const f = fromDraftRef.current;
    if (f && !draft && pendingDraft.current === f.id && sessionRef.current === null) revertDraftFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const dismissDraft = () => {
    revertDraftFields();
    clear(draft?.id);
  };

  const removeSession = async () => {
    const id = sessionRef.current;
    if (id === null || removing) return;
    autosave.reset(); // an edit still waiting belongs to the session being removed
    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await fetch(`/api/reading/sessions/${id}`, { method: "DELETE" });
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

  if (!data && !loadFailed) return <SectionSkeleton section="reading" />;
  if (!data) {
    return (
      <LogCard title="Reading" id="log-section-reading">
        <div className="flex items-center gap-3">
          <p className="text-[13px] text-down">Couldn&apos;t load reading.</p>
          <button type="button" onClick={load} className="min-h-11 px-3 text-[13px] text-text-secondary hover:text-text-primary underline underline-offset-2">
            Retry
          </button>
        </div>
      </LogCard>
    );
  }
  if (!o) {
    return (
      <LogCard title="Reading" id="log-section-reading">
        <p className="text-[13px] text-text-tertiary">No book in progress.</p>
      </LogCard>
    );
  }

  const otherBook = form.book && form.book !== o.book.slug ? form.book : null;
  const otherBookTitle = otherBook ? data.books?.find((b) => b.slug === otherBook)?.title ?? otherBook : null;
  const total = o.totalChapters || 0;
  const next = total ? Math.min(total, o.chaptersDone + 1) : o.chaptersDone + 1;
  const chips = [next, next + 1].filter((n, i, all) => n >= 0 && (!total || n <= total) && all.indexOf(n) === i);
  const todaySessions = o.sessions.filter((s) => s.session_date === o.today);
  const pace = o.pace;
  const paceText =
    o.book.status === "finished"
      ? "finished"
      : pace.aheadBy === 0
        ? "on pace"
        : pace.aheadBy > 0
          ? `${pace.aheadBy} ahead`
          : `${-pace.aheadBy} behind`;
  const paceClass = o.book.status === "finished" || pace.aheadBy >= 0 ? "text-up" : pace.aheadBy >= -2 ? "text-[var(--color-mid)]" : "text-down";
  const mediaOptions = form.medium === "kindle" ? [...MEDIA, { key: "kindle" as Medium, label: "Kindle" }] : MEDIA;
  const day = form.date || o.today;
  const anyTouched = Object.values(touched.current).some(Boolean) || anyMarked;
  const savedText = `Saved${saved?.finished ? " · book finished" : ""}${saved?.xp ? ` · +${saved.xp} XP` : ""}`;

  const inputCls =
    "mt-1 w-full min-h-11 px-3 text-[16px] font-mono tabular-nums bg-surface-sunken border border-border-subtle rounded-control text-text-primary placeholder:text-text-tertiary/60 focus:border-accent/60 outline-none";
  const labelCls = "text-[11px] font-mono uppercase tracking-wider text-text-tertiary";

  return (
    <LogCard
      title="Reading"
      id="log-section-reading"
      action={<span className="font-mono text-[12px] tabular-nums text-text-secondary">ch {o.chaptersDone} / {total || "?"}</span>}
    >
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

      <form
        noValidate
        onSubmit={(e) => { e.preventDefault(); void autosave.flush(); }}
        onBlur={() => void autosave.flush()}
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
              type="number" inputMode="numeric" min={0} max={total || undefined}
              value={form.from}
              onChange={(e) => set("from", { from: e.target.value })}
              placeholder="auto"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Through ch. {marked("through") && <DraftMark />}</span>
            <input
              type="number" inputMode="numeric" min={0} max={total || undefined}
              value={form.through}
              onChange={(e) => set("through", { through: e.target.value })}
              placeholder={String(next)}
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
              max={o.today}
              onChange={(e) => set("date", { date: e.target.value || o.today })}
              className={inputCls}
            />
          </label>
        </div>

        <label className="mt-2 block">
          <span className={labelCls}>Recall note {marked("recall") && <DraftMark />}</span>
          <textarea
            value={form.recall}
            onChange={(e) => set("recall", { recall: e.target.value })}
            rows={2}
            placeholder="Optional, from memory"
            className="mt-1 w-full px-3 py-2 text-[16px] leading-relaxed bg-surface-sunken border border-border-subtle rounded-control text-text-primary placeholder:text-text-tertiary/60 focus:border-accent/60 outline-none"
          />
        </label>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-[12px] text-text-tertiary">
            {day !== o.today ? `For ${fmtDate(day)}` : "For today"}
            {" · "}
            <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} savedText={savedText} showIncomplete={anyTouched} />
          </span>
          {sessionId !== null && (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void removeSession()}
                disabled={busy}
                className="min-h-11 px-2 text-[12px] text-text-tertiary hover:text-down underline underline-offset-2 disabled:opacity-40"
              >
                {removing ? "Removing…" : "Remove this session"}
              </button>
              <button
                type="button"
                onClick={() => void autosave.flush().then(() => { if (alive.current) startNew(); })}
                disabled={busy || st === "error"}
                className="min-h-11 px-4 rounded-full text-[13px] font-medium border border-border-subtle text-text-secondary hover:text-text-primary disabled:opacity-40"
              >
                New session
              </button>
            </span>
          )}
        </div>
        {removeError && (
          <p role="alert" className="mt-2 text-[13px] text-down">{removeError}</p>
        )}
      </form>
    </LogCard>
  );
}
