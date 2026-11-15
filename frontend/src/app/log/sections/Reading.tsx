"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import { useLogDrafts, type ReadingLogDraft } from "@/lib/log-drafts";
import type { Book, Medium, ReadingOverview, ReadingSession } from "@/lib/reading";
import { DraftMark, LogCard, LogSaveButton, SectionSkeleton } from "./ui";

/**
 * /log Reading. The book being read (chapters done, pace, the Kindle position) and the day's sessions, read-only:
 * Kindle days are written automatically by the harvester. Below them one audio / paper session through
 * POST /api/reading/sessions, the same route as the /reading form (chapter_through required and not past the
 * book's last chapter; the day defaults to behavioral today on the server; the recall note is stored verbatim; the
 * book's habit is stamped Yes for that day). Reads GET /api/reading through the client cache (same key as Today and
 * /reading). A Say it draft (ReadingLogDraft) fills the form as a suggestion; nothing is written until Save.
 */

const READING_URL = "/api/reading";

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

type Field = "from" | "through" | "minutes" | "date" | "medium" | "recall" | "book";
type Form = { from: string; through: string; minutes: string; date: string; medium: Medium; recall: string; book: string | null };
const EMPTY_FIELDS: Record<Field, boolean> = { from: false, through: false, minutes: false, date: false, medium: false, recall: false, book: false };

function blankForm(today: string): Form {
  return { from: "", through: "", minutes: "", date: today, medium: "audio", recall: "", book: null };
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

type Msg = { kind: "ok" | "err"; text: string } | null;

export default function ReadingSection() {
  const [data, setData] = useState<ReadingAnswer | null>(() => asReading(clientCache.peek(READING_URL)));
  const [loadFailed, setLoadFailed] = useState(false);
  const alive = useRef(true);
  const o = data?.overview ?? null;
  const today = o?.today ?? "";

  const [form, setForm] = useState<Form>(() => blankForm(today));
  const touched = useRef<Record<Field, boolean>>({ ...EMPTY_FIELDS });
  const [fromDraft, setFromDraft] = useState<{ id: number; fields: Record<Field, boolean> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const { draft, clear } = useLogDrafts("reading");
  const seenDraft = useRef<number | null>(null);

  const show = useCallback((raw: unknown) => {
    const v = asReading(raw);
    if (v && alive.current) setData((prev) => (sameJson(prev, v) ? prev : v));
  }, []);

  const load = useCallback(() => {
    setLoadFailed(false);
    cachedJson(READING_URL, { check: checkReading })
      .then(show)
      .catch(() => { if (alive.current) setLoadFailed(true); });
  }, [show]);

  useEffect(() => {
    alive.current = true;
    if (!clientCache.peek(READING_URL)) void clientCache.read(READING_URL).then(show).catch(() => {});
    // A save on /reading or Today updates this one; a removal (write invalidation) keeps what is shown until the
    // refetch answers.
    const unsub = clientCache.subscribe(READING_URL, (v) => { if (v !== undefined) show(v); });
    load();
    return () => { alive.current = false; unsub(); };
  }, [load, show]);

  // The behavioral day the server reports: an untouched date follows it (first load, a new day).
  useEffect(() => {
    if (!today || touched.current.date) return;
    setForm((f) => (fromDraft?.fields.date || f.date === today ? f : { ...f, date: today }));
  }, [today, fromDraft]);

  const set = (field: Field, patch: Partial<Form>) => {
    touched.current[field] = true;
    setForm((f) => ({ ...f, ...patch }));
    setMsg(null);
    if (fromDraft?.fields[field]) setFromDraft({ ...fromDraft, fields: { ...fromDraft.fields, [field]: false } });
  };

  const applyDraft = useCallback((force: boolean) => {
    if (!draft) return;
    const vals = draftFields(draft.value);
    const applied: Record<Field, boolean> = { ...EMPTY_FIELDS };
    const patch: Partial<Form> = {};
    for (const key of Object.keys(vals) as Field[]) {
      if (!force && touched.current[key]) continue;
      (patch as Record<string, unknown>)[key] = vals[key];
      applied[key] = true;
      if (force) touched.current[key] = false;
    }
    setForm((f) => ({ ...f, ...patch }));
    setFromDraft({ id: draft.id, fields: applied });
    setMsg(null);
  }, [draft]);

  useEffect(() => {
    if (!draft || seenDraft.current === draft.id) return;
    seenDraft.current = draft.id;
    applyDraft(false);
  }, [draft, applyDraft]);

  useEffect(() => {
    // Functional: runs after a new draft's own setFromDraft in the same commit and keeps it.
    setFromDraft((f) => (f && (!draft || draft.id !== f.id) ? null : f));
  }, [draft]);

  const dismissDraft = () => {
    if (fromDraft) {
      const blank = blankForm(today);
      setForm((f) => {
        const next = { ...f };
        for (const key of Object.keys(fromDraft.fields) as Field[]) {
          if (fromDraft.fields[key] && !touched.current[key]) (next as Record<string, unknown>)[key] = blank[key];
        }
        return next;
      });
    }
    setFromDraft(null);
    clear(draft?.id);
  };

  const marked = (field: Field) => !!fromDraft?.fields[field];
  const anyMarked = !!fromDraft && Object.values(fromDraft.fields).some(Boolean);
  const draftUnused = !!draft && (!fromDraft || fromDraft.id !== draft.id || !anyMarked);

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

  async function save() {
    if (saving || !o) return;
    const through = Number(form.through);
    if (form.through.trim() === "" || !Number.isInteger(through) || through < 0) {
      setMsg({ kind: "err", text: "Enter the chapter you read through." });
      return;
    }
    if (!otherBook && total && through > total) {
      setMsg({ kind: "err", text: `This book has ${total} chapters.` });
      return;
    }
    const from = form.from.trim() === "" ? null : Number(form.from);
    if (from !== null && (!Number.isInteger(from) || from < 0 || from > through)) {
      setMsg({ kind: "err", text: "The first chapter must be at most the last one." });
      return;
    }
    const minutes = form.minutes.trim() === "" ? null : Number(form.minutes);
    if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0)) {
      setMsg({ kind: "err", text: "Minutes must be 0 or more." });
      return;
    }
    // The day is sent only when Riley (or the draft) chose one; otherwise the server takes behavioral today.
    const chosenDay = touched.current.date || marked("date") ? day : null;
    if (chosenDay && (!isYmd(chosenDay) || chosenDay > o.today)) {
      setMsg({ kind: "err", text: "Pick today or an earlier day." });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/reading/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          book: otherBook ?? o.book.slug,
          date: chosenDay,
          chapter_from: from,
          chapter_through: through,
          minutes,
          medium: form.medium,
          recall: form.recall,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; xp_gained?: number; finished?: boolean; overview?: ReadingOverview | null };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (!alive.current) return;
      if (json.overview && json.overview.book.slug === o.book.slug) {
        const updated = json.overview;
        setData((prev) => (prev ? { ...prev, overview: updated } : prev));
      }
      touched.current = { ...EMPTY_FIELDS };
      setForm(blankForm(json.overview?.today ?? o.today));
      setFromDraft(null);
      if (draft) clear(draft.id);
      const xp = json.xp_gained ?? 0;
      setMsg({ kind: "ok", text: json.finished ? `Saved · book finished · +${xp} XP` : `Saved${xp ? ` · +${xp} XP` : ""}` });
      void cachedJson(READING_URL, { check: checkReading }).then(show).catch(() => {});
    } catch (e) {
      if (alive.current) setMsg({ kind: "err", text: `Couldn't log the session: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  const inputCls =
    "mt-1 w-full min-h-11 px-3 text-[16px] font-mono tabular-nums bg-surface-sunken border border-border-subtle rounded-control text-text-primary placeholder:text-text-tertiary/60 focus:border-accent/60 outline-none disabled:opacity-40";
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

      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-4 border-t border-border-subtle pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className={labelCls}>Audio or paper session</h3>
          {anyMarked && (
            <span className="flex items-center gap-2">
              <DraftMark />
              <button type="button" onClick={dismissDraft} className="min-h-11 px-1 text-[12px] text-text-tertiary hover:text-text-primary underline underline-offset-2">
                Dismiss
              </button>
            </span>
          )}
        </div>

        {draftUnused && draft && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <DraftMark />
            <span className="font-mono text-text-secondary">{draftSummary(draft.value)}</span>
            <button type="button" onClick={() => applyDraft(true)} className="min-h-11 px-1 text-accent underline underline-offset-2">Use</button>
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
              disabled={saving}
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
              disabled={saving}
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
              disabled={saving}
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
                disabled={saving}
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
              disabled={saving}
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
              disabled={saving}
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
            disabled={saving}
            className="mt-1 w-full px-3 py-2 text-[16px] leading-relaxed bg-surface-sunken border border-border-subtle rounded-control text-text-primary placeholder:text-text-tertiary/60 focus:border-accent/60 outline-none disabled:opacity-40"
          />
        </label>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] text-text-tertiary">
            {day !== o.today ? `For ${fmtDate(day)}` : "For today"}
          </span>
          <LogSaveButton onClick={() => void save()} disabled={form.through.trim() === ""} saving={saving} />
        </div>
        {msg && (
          <p role={msg.kind === "err" ? "alert" : "status"} className={`mt-2 text-[13px] ${msg.kind === "ok" ? "text-up" : "text-down"}`}>
            {msg.text}
          </p>
        )}
      </form>
    </LogCard>
  );
}
