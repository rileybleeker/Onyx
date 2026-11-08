"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { BookMarked, Check, ChevronDown, Flame, Headphones, Highlighter, Sparkles, Trophy, X } from "lucide-react";
import MetricRing from "@/components/MetricRing";
import { CONCEPTS, type Grade, type Highlight, type HighlightSource, type Medium, type ReadingOverview, type Book } from "@/lib/reading";

const BurnupChart = dynamic(() => import("./BurnupChart"), { ssr: false, loading: () => <div className="h-[180px]" /> });

/**
 * /reading — the reading quest (2026-11-07).
 *
 * One book at a time: progress ring + pace against the target date, session
 * streak, XP / level, badges, three checkpoints, a burn-up chart, today's
 * spaced-repetition review, and the two capture forms (session with a from-
 * memory recall note; highlight with a comment, or a pasted Kindle export).
 * Writes go to /api/reading/*; each write mirrors to the book's Notion
 * reading-log page server-side. All numbers are derived in lib/reading.ts.
 */

type Toast = { text: string; kind: "xp" | "ok" | "err" } | null;

const MEDIA: Array<{ key: Medium; label: string }> = [
  { key: "audio", label: "Audio" },
  { key: "kindle", label: "Kindle" },
  { key: "paper", label: "Paper" },
];
const SOURCES: Array<{ key: HighlightSource; label: string }> = [
  { key: "kindle", label: "Kindle" },
  { key: "audible", label: "Audible clip" },
  { key: "paper", label: "Paper" },
  { key: "manual", label: "Other" },
];

const fmtDate = (d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", ...opts }) : "—";

export default function ReadingClient() {
  const [overview, setOverview] = useState<ReadingOverview | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const showToast = useCallback((t: Toast) => {
    setToast(t);
    if (t) setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 3500);
  }, []);

  const load = useCallback(
    async (which: string | null = slug, silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/reading${which ? `?book=${encodeURIComponent(which)}` : ""}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setOverview(json.overview);
        setBooks(json.books ?? []);
        if (json.overview && !which) setSlug(json.overview.book.slug);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load");
      } finally {
        setLoading(false);
      }
    },
    [slug],
  );

  useEffect(() => {
    load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && !overview) {
    return (
      <div className="max-w-3xl space-y-3">
        <div className="h-8 w-40 bg-white/5 animate-pulse rounded" />
        <div className="h-44 bg-white/[0.03] animate-pulse rounded-[6px]" />
        <div className="h-28 bg-white/[0.03] animate-pulse rounded-[6px]" />
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="max-w-3xl">
        <h2 className="text-[28px] font-medium text-text-primary">Reading</h2>
        <p className="mt-3 text-sm text-red-400">{error}</p>
        <p className="mt-1 text-[12px] text-text-tertiary">If this is a fresh deploy, apply sql/reading_schema.sql in Supabase first.</p>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="max-w-3xl">
        <h2 className="text-[28px] font-medium text-text-primary">Reading</h2>
        <p className="mt-3 text-sm text-text-secondary">No book in progress. Add one with POST /api/reading/books or the chat.</p>
      </div>
    );
  }

  const o = overview;

  return (
    <div className="max-w-3xl pb-24">
      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Reading</h2>
          <p className="text-sm text-text-secondary mt-0.5">
            <span className="text-text-primary">{o.book.title}</span>
            {o.book.author && <span className="text-text-tertiary"> · {o.book.author}</span>}
          </p>
        </div>
        {books.length > 1 && (
          <select
            value={o.book.slug}
            onChange={(e) => {
              setSlug(e.target.value);
              load(e.target.value);
            }}
            className="bg-surface-card border border-border-subtle rounded-[6px] text-[12px] px-2 py-1.5 text-text-secondary"
          >
            {books.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <QuestCard o={o} />

      {/* Burn-up */}
      <section className="mt-4 bg-surface-card border border-border-subtle rounded-[6px] px-4 pt-3 pb-1">
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Chapters vs pace</h3>
          <span className="text-[11px] font-mono text-text-tertiary">
            {fmtDate(o.book.start_date)} → {fmtDate(o.book.target_date)}
          </span>
        </div>
        <BurnupChart data={o.burnup} today={o.today} total={o.totalChapters} />
      </section>

      <Checkpoints o={o} />

      <ReviewCard o={o} onGraded={(xp) => { if (xp) showToast({ text: `+${xp} XP · review day`, kind: "xp" }); load(slug, true); }} />

      <SessionForm o={o} onLogged={(xp, finished) => { showToast({ text: finished ? `Finished! +${xp} XP` : `+${xp} XP`, kind: "xp" }); load(slug, true); }} onError={(m) => showToast({ text: m, kind: "err" })} />

      <HighlightForm o={o} onAdded={(n) => { showToast({ text: n === 1 ? "+5 XP · highlight" : `${n} highlights imported`, kind: "ok" }); load(slug, true); }} onError={(m) => showToast({ text: m, kind: "err" })} />

      <Badges o={o} />

      <HighlightsList o={o} onChanged={() => load(slug, true)} onError={(m) => showToast({ text: m, kind: "err" })} />

      <SessionsList o={o} />

      {toast && (
        <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] md:bottom-6 left-1/2 -translate-x-1/2 z-20">
          <div
            className={`px-4 py-2 rounded-[8px] border shadow-lg text-[13px] font-medium backdrop-blur ${
              toast.kind === "xp" ? "bg-accent/15 border-accent/60 text-accent" : toast.kind === "err" ? "bg-red-500/10 border-red-500/50 text-red-300" : "bg-surface-raised border-border-default text-text-primary"
            }`}
          >
            {toast.kind === "xp" && <Sparkles className="inline w-3.5 h-3.5 mr-1.5 -mt-0.5" />}
            {toast.text}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function QuestCard({ o }: { o: ReadingOverview }) {
  const pace = o.pace;
  const paceText =
    o.book.status === "finished"
      ? `Finished ${fmtDate(o.book.finished_on)}`
      : pace.aheadBy === 0
        ? "Exactly on pace"
        : pace.aheadBy > 0
          ? `${pace.aheadBy} chapter${pace.aheadBy === 1 ? "" : "s"} ahead`
          : `${-pace.aheadBy} chapter${pace.aheadBy === -1 ? "" : "s"} behind`;
  const paceColor = o.book.status === "finished" || pace.aheadBy >= 0 ? "text-accent" : pace.aheadBy >= -2 ? "text-[var(--color-mid)]" : "text-[var(--color-down)]";

  return (
    <section className="bg-surface-card border border-border-subtle rounded-[6px] p-4" data-testid="reading-quest">
      <div className="flex gap-4 items-center">
        <MetricRing
          value={o.chaptersDone}
          max={Math.max(1, o.totalChapters)}
          size={116}
          thickness={9}
          color="var(--color-accent)"
          centerValue={<span className="text-[26px]">{o.chaptersDone}</span>}
          centerUnit={`/ ${o.totalChapters || "?"}`}
          sublabel="chapters"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">
              Level {o.level.n} · {o.level.title}
            </div>
            <div className="text-[12px] font-mono text-text-secondary">{o.xp.total} XP</div>
          </div>
          <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${(o.level.intoLevel / o.level.perLevel) * 100}%` }} />
          </div>
          <div className="mt-1 text-[11px] font-mono text-text-tertiary">
            {o.level.perLevel - o.level.intoLevel} XP to level {o.level.n + 1}
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <Stat
              icon={<Flame className={`w-3.5 h-3.5 ${o.streak.current > 0 ? "text-[var(--color-tick-causal)]" : "text-text-tertiary"}`} />}
              label="Streak"
              value={`${o.streak.current}d`}
              sub={o.streak.atRisk ? "at risk today" : o.streak.loggedToday ? "logged today" : `best ${o.streak.best}d`}
              subClass={o.streak.atRisk ? "text-[var(--color-mid)]" : undefined}
            />
            <Stat label="Pace" value={paceText} valueClass={`${paceColor} text-[13px]`} sub={o.book.status === "finished" ? "" : `expected ch ${pace.expectedToday}`} />
            <Stat
              label="Days left"
              value={o.book.status === "finished" ? "—" : String(pace.daysLeft)}
              sub={o.book.status === "finished" ? "" : `${pace.perDayNeeded}/day to finish`}
            />
          </div>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-border-subtle flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-text-tertiary">
        <span>{o.sessions.length} sessions</span>
        <span>{o.minutesTotal} min</span>
        <span>{o.highlights.length} highlights</span>
        <span>{o.badges.filter((b) => b.earned).length}/{o.badges.length} badges</span>
        {o.position?.chapter != null && (
          <span className="text-amber-300/80" title="Kindle reading position (Whispersync), as of the last harvest">
            Kindle: ch {o.position.chapter}
            {o.position.page != null ? ` · p. ${o.position.page}` : ""}
            {o.position.percent != null ? ` · ${o.position.percent}%` : ""}
          </span>
        )}
        <span className="ml-auto">target {fmtDate(o.book.target_date, { month: "short", day: "numeric" })}</span>
      </div>
    </section>
  );
}

function Stat({ icon, label, value, sub, valueClass, subClass }: { icon?: React.ReactNode; label: string; value: string; sub?: string; valueClass?: string; subClass?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
        {icon}
        {label}
      </div>
      <div className={`mt-0.5 font-mono text-[15px] text-text-primary truncate ${valueClass ?? ""}`}>{value}</div>
      {sub ? <div className={`text-[10px] font-mono truncate ${subClass ?? "text-text-tertiary"}`}>{sub}</div> : null}
    </div>
  );
}

function Checkpoints({ o }: { o: ReadingOverview }) {
  if (!o.checkpoints.length) return null;
  return (
    <section className="mt-4">
      <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2">Checkpoints</h3>
      <div className="grid grid-cols-3 gap-2">
        {o.checkpoints.map((c) => {
          const state = c.reached ? (c.onTime ? "done" : "late") : c.onTime === false ? "missed" : "upcoming";
          const border =
            state === "done" ? "border-accent/60" : state === "late" ? "border-[var(--color-mid)]/60" : state === "missed" ? "border-[var(--color-down)]/60" : "border-border-subtle";
          return (
            <div key={c.key} className={`bg-surface-card border ${border} rounded-[6px] px-3 py-2.5`}>
              <div className="text-[13px] font-medium text-text-primary">Ch {c.chapter}</div>
              <div className="text-[11px] font-mono text-text-tertiary">by {fmtDate(c.due)}</div>
              <div className="mt-1.5 text-[11px] font-mono">
                {state === "done" && <span className="text-accent">✓ on time</span>}
                {state === "late" && <span className="text-[var(--color-mid)]">✓ late</span>}
                {state === "missed" && <span className="text-[var(--color-down)]">missed</span>}
                {state === "upcoming" && <span className="text-text-tertiary">upcoming</span>}
              </div>
              <div className="mt-1 text-[11px] font-mono text-text-tertiary">
                {c.quiz ? (
                  <span className={c.quiz.score / c.quiz.total >= 0.8 ? "text-accent" : "text-text-secondary"}>
                    quiz {c.quiz.score}/{c.quiz.total}
                  </span>
                ) : c.reached ? (
                  <Link href="/chat" className="text-accent/80 underline underline-offset-2">
                    quiz me →
                  </Link>
                ) : (
                  "no quiz yet"
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-text-tertiary">
        Quizzes run in <Link href="/chat" className="underline underline-offset-2">Health Q&amp;A</Link>: &ldquo;quiz me on The Goal through chapter 12&rdquo;. The result is recorded here. 80% passes.
      </p>
    </section>
  );
}

function ReviewCard({ o, onGraded }: { o: ReadingOverview; onGraded: (xp: number) => void }) {
  const [queue, setQueue] = useState<Highlight[]>(o.dueReviews);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setQueue(o.dueReviews);
    setRevealed(false);
  }, [o.dueReviews]);

  const cur = queue[0];
  const nextDue = useMemo(() => {
    const future = o.highlights.map((h) => h.next_review).filter((d): d is string => !!d && d > o.today).sort();
    return future[0] ?? null;
  }, [o.highlights, o.today]);

  const grade = async (g: Grade) => {
    if (!cur || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/reading/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ highlight_id: cur.highlight_id, grade: g }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      setQueue((q) => q.slice(1));
      setRevealed(false);
      onGraded(json.xp_gained ?? 0);
    } catch {
      /* toast handled by parent reload */
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-4 bg-surface-card border border-border-subtle rounded-[6px] p-4" data-testid="reading-review">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Review</h3>
        <span className="text-[11px] font-mono text-text-tertiary">
          {queue.length ? `${queue.length} due` : o.reviewsToday ? `${o.reviewsToday} done today` : nextDue ? `next ${fmtDate(nextDue)}` : "nothing scheduled"}
        </span>
      </div>
      {cur ? (
        <div className="mt-2">
          <blockquote className="text-[14px] text-text-primary leading-relaxed border-l-2 border-accent/60 pl-3">{cur.passage}</blockquote>
          <div className="mt-2 text-[11px] font-mono text-text-tertiary">
            {cur.chapter != null ? `ch ${cur.chapter}` : ""} {cur.concept ? `· ${cur.concept}` : ""}
          </div>
          {!revealed ? (
            <button onClick={() => setRevealed(true)} className="mt-3 px-3 py-1.5 text-[13px] rounded-[6px] border border-border-subtle bg-white/[0.03] hover:bg-white/[0.06] text-text-secondary">
              Say what this means, then reveal your note
            </button>
          ) : (
            <>
              <p className="mt-3 text-[13px] text-text-secondary italic">{cur.comment || "No comment on this one. Add one below."}</p>
              <div className="mt-3 flex gap-2">
                <GradeBtn label="Again" sub="1d" onClick={() => grade("again")} disabled={busy} className="border-[var(--color-down)]/50 text-[var(--color-down)]" />
                <GradeBtn label="Good" sub={cur.interval_days ? `${Math.max(1, Math.round(cur.interval_days * Number(cur.ease)))}d` : "3d"} onClick={() => grade("good")} disabled={busy} className="border-border-default text-text-primary" />
                <GradeBtn label="Easy" sub="longer" onClick={() => grade("easy")} disabled={busy} className="border-accent/60 text-accent" />
              </div>
            </>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-text-tertiary">Nothing due. New highlights come up the next day, then at growing intervals based on your grades.</p>
      )}
    </section>
  );
}

function GradeBtn({ label, sub, onClick, disabled, className }: { label: string; sub: string; onClick: () => void; disabled: boolean; className: string }) {
  return (
    <button onClick={onClick} disabled={disabled} className={`flex-1 h-11 rounded-[6px] border bg-white/[0.02] disabled:opacity-40 ${className}`}>
      <div className="text-[13px] font-medium leading-none">{label}</div>
      <div className="text-[10px] font-mono opacity-70 mt-1">{sub}</div>
    </button>
  );
}

function SessionForm({ o, onLogged, onError }: { o: ReadingOverview; onLogged: (xp: number, finished: boolean) => void; onError: (m: string) => void }) {
  const suggested = Math.min(o.totalChapters || 9999, o.chaptersDone + 2);
  const [through, setThrough] = useState<string>(String(suggested));
  const [minutes, setMinutes] = useState<string>("");
  const [medium, setMedium] = useState<Medium>("audio");
  const [recall, setRecall] = useState("");
  const [question, setQuestion] = useState("");
  const [date, setDate] = useState(o.today);
  const [saving, setSaving] = useState(false);
  useEffect(() => setThrough(String(Math.min(o.totalChapters || 9999, o.chaptersDone + 2))), [o.chaptersDone, o.totalChapters]);
  useEffect(() => setDate(o.today), [o.today]);

  const recallOk = recall.trim().length >= 40;
  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/reading/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book: o.book.slug, date, chapter_through: Number(through), minutes: minutes ? Number(minutes) : null, medium, recall, question }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      setRecall("");
      setQuestion("");
      setMinutes("");
      onLogged(json.xp_gained ?? 0, !!json.finished);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't log the session");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-4 bg-surface-card border border-border-subtle rounded-[6px] p-4" data-testid="reading-session-form">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary flex items-center gap-1.5">
          <BookMarked className="w-3.5 h-3.5" /> Log a session
        </h3>
        <span className="text-[11px] font-mono text-text-tertiary">10 XP / chapter · 20 XP for a recall note</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">Through ch.</span>
          <input type="number" inputMode="numeric" min={0} max={o.totalChapters || undefined} value={through} onChange={(e) => setThrough(e.target.value)} className="mt-1 w-full bg-white/[0.03] border border-border-subtle rounded-[6px] px-2 py-2 text-[15px] font-mono text-text-primary" />
        </label>
        <label className="block">
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">Minutes</span>
          <input type="number" inputMode="numeric" min={0} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="31" className="mt-1 w-full bg-white/[0.03] border border-border-subtle rounded-[6px] px-2 py-2 text-[15px] font-mono text-text-primary" />
        </label>
        <label className="block">
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">Day</span>
          <input type="date" value={date} max={o.today} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full bg-white/[0.03] border border-border-subtle rounded-[6px] px-2 py-2 text-[13px] font-mono text-text-primary" />
        </label>
      </div>
      <div className="mt-2 flex gap-1.5">
        {MEDIA.map((m) => (
          <button key={m.key} onClick={() => setMedium(m.key)} aria-pressed={medium === m.key} className={`px-3 h-8 rounded-[6px] border text-[12px] inline-flex items-center gap-1 ${medium === m.key ? "bg-accent/15 border-accent/60 text-accent" : "border-border-subtle text-text-tertiary"}`}>
            {m.key === "audio" && <Headphones className="w-3.5 h-3.5" />}
            {m.label}
          </button>
        ))}
      </div>
      <label className="block mt-3">
        <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
          Recall, from memory <span className={recallOk ? "text-accent" : ""}>{recallOk ? "· +20 XP" : "· 3 sentences"}</span>
        </span>
        <textarea
          value={recall}
          onChange={(e) => setRecall(e.target.value)}
          rows={4}
          placeholder="What happened, what principle it showed, where it shows up in a BC implementation. Dictate it; don't open the book."
          className="mt-1 w-full bg-white/[0.03] border border-border-subtle rounded-[6px] px-3 py-2 text-[14px] text-text-primary leading-relaxed"
        />
      </label>
      <label className="block mt-2">
        <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">One question for a plant manager</span>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Optional" className="mt-1 w-full bg-white/[0.03] border border-border-subtle rounded-[6px] px-3 py-2 text-[14px] text-text-primary" />
      </label>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-text-tertiary">Also marks the &ldquo;{o.book.habit_name ?? "reading"}&rdquo; habit for {fmtDate(date)}.</span>
        <button onClick={submit} disabled={saving || through === ""} className="px-4 py-2 rounded-[6px] text-[14px] font-medium bg-accent text-black disabled:opacity-40">
          {saving ? "Saving…" : "Log session"}
        </button>
      </div>
    </section>
  );
}

function HighlightForm({ o, onAdded, onError }: { o: ReadingOverview; onAdded: (n: number) => void; onError: (m: string) => void }) {
  const [mode, setMode] = useState<"one" | "import">("one");
  const [passage, setPassage] = useState("");
  const [comment, setComment] = useState("");
  const [chapter, setChapter] = useState<string>("");
  const [concept, setConcept] = useState<string>("");
  const [customConcept, setCustomConcept] = useState("");
  const [source, setSource] = useState<HighlightSource>("kindle");
  const [importText, setImportText] = useState("");
  const [preview, setPreview] = useState<{ format: string; count: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const effectiveConcept = concept === "__custom" ? customConcept.trim() : concept;

  const addOne = async () => {
    if (saving || !passage.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/reading/highlights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book: o.book.slug, passage, comment, chapter: chapter ? Number(chapter) : null, concept: effectiveConcept || null, source }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      setPassage("");
      setComment("");
      onAdded(1);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't save the highlight");
    } finally {
      setSaving(false);
    }
  };

  const doPreview = async () => {
    if (!importText.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/reading/highlights/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ book: o.book.slug, text: importText, dry_run: true }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      setPreview({ format: json.format, count: json.count });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't parse");
    } finally {
      setSaving(false);
    }
  };

  const doImport = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/reading/highlights/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ book: o.book.slug, text: importText }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      setImportText("");
      setPreview(null);
      onAdded(json.created ?? 0);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-4 bg-surface-card border border-border-subtle rounded-[6px] p-4" data-testid="reading-highlight-form">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary flex items-center gap-1.5">
          <Highlighter className="w-3.5 h-3.5" /> Highlight + comment
        </h3>
        <div className="flex gap-1 text-[11px] font-mono">
          <button onClick={() => setMode("one")} className={`px-2 py-1 rounded-[4px] ${mode === "one" ? "bg-white/[0.08] text-text-primary" : "text-text-tertiary"}`}>
            one
          </button>
          <button onClick={() => setMode("import")} className={`px-2 py-1 rounded-[4px] ${mode === "import" ? "bg-white/[0.08] text-text-primary" : "text-text-tertiary"}`}>
            paste Kindle export
          </button>
        </div>
      </div>

      {mode === "one" ? (
        <>
          <textarea value={passage} onChange={(e) => setPassage(e.target.value)} rows={3} placeholder="The passage, as written." className="mt-3 w-full bg-white/[0.03] border border-border-subtle rounded-[6px] px-3 py-2 text-[14px] text-text-primary leading-relaxed" />
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Your comment. Why it matters, or where it shows up in BC." className="mt-2 w-full bg-white/[0.03] border border-border-subtle rounded-[6px] px-3 py-2 text-[14px] text-text-primary italic" />
          <div className="mt-2 grid grid-cols-[88px_1fr] gap-2">
            <input type="number" inputMode="numeric" min={0} value={chapter} onChange={(e) => setChapter(e.target.value)} placeholder="ch." className="bg-white/[0.03] border border-border-subtle rounded-[6px] px-2 py-2 text-[13px] font-mono text-text-primary" />
            <select value={concept} onChange={(e) => setConcept(e.target.value)} className="bg-white/[0.03] border border-border-subtle rounded-[6px] px-2 py-2 text-[13px] text-text-primary">
              <option value="">Concept (optional)</option>
              {CONCEPTS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__custom">Other…</option>
            </select>
          </div>
          {concept === "__custom" && <input value={customConcept} onChange={(e) => setCustomConcept(e.target.value)} placeholder="Concept name" className="mt-2 w-full bg-white/[0.03] border border-border-subtle rounded-[6px] px-3 py-2 text-[13px] text-text-primary" />}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SOURCES.map((s) => (
              <button key={s.key} onClick={() => setSource(s.key)} aria-pressed={source === s.key} className={`px-2.5 h-7 rounded-[6px] border text-[11px] ${source === s.key ? "bg-accent/15 border-accent/60 text-accent" : "border-border-subtle text-text-tertiary"}`}>
                {s.label}
              </button>
            ))}
            <button onClick={addOne} disabled={saving || !passage.trim()} className="ml-auto px-4 h-8 rounded-[6px] text-[13px] font-medium bg-accent text-black disabled:opacity-40">
              {saving ? "Saving…" : "Add highlight"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-[12px] text-text-tertiary">
            Kindle app → notebook → share → <span className="text-text-secondary">Export notebook</span>, then paste the email body here. My Clippings.txt from a Kindle device works too, as does a plain list separated by blank lines (a line starting with &ldquo;&gt;&rdquo; under a passage becomes its comment). Re-pasting the same export is safe.
          </p>
          <textarea
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value);
              setPreview(null);
            }}
            rows={6}
            placeholder="Paste here"
            className="mt-2 w-full bg-white/[0.03] border border-border-subtle rounded-[6px] px-3 py-2 text-[12px] font-mono text-text-primary"
          />
          <div className="mt-2 flex items-center gap-2">
            {preview && (
              <span className="text-[12px] font-mono text-text-secondary">
                {preview.count} highlight{preview.count === 1 ? "" : "s"} · {preview.format}
              </span>
            )}
            <button onClick={doPreview} disabled={saving || !importText.trim()} className="ml-auto px-3 h-8 rounded-[6px] text-[13px] border border-border-subtle text-text-secondary disabled:opacity-40">
              Preview
            </button>
            <button onClick={doImport} disabled={saving || !preview || preview.count === 0} className="px-4 h-8 rounded-[6px] text-[13px] font-medium bg-accent text-black disabled:opacity-40">
              Import
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Badges({ o }: { o: ReadingOverview }) {
  return (
    <section className="mt-4">
      <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2 flex items-center gap-1.5">
        <Trophy className="w-3.5 h-3.5" /> Badges
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {o.badges.map((b) => (
          <div key={b.key} title={b.description} className={`rounded-[6px] border px-3 py-2 ${b.earned ? "bg-accent/10 border-accent/50" : "bg-surface-card border-border-subtle opacity-60"}`}>
            <div className={`text-[12px] font-medium ${b.earned ? "text-accent" : "text-text-secondary"}`}>{b.label}</div>
            <div className="text-[10px] text-text-tertiary leading-snug mt-0.5">{b.description}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function HighlightsList({ o, onChanged, onError }: { o: ReadingOverview; onChanged: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const groups = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    for (const h of o.highlights) {
      const k = h.concept || "Untagged";
      m.set(k, [...(m.get(k) ?? []), h]);
    }
    return [...m.entries()].sort((a, b) => (a[0] === "Untagged" ? 1 : b[0] === "Untagged" ? -1 : a[0].localeCompare(b[0])));
  }, [o.highlights]);

  const saveComment = async (h: Highlight) => {
    try {
      const res = await fetch(`/api/reading/highlights/${h.highlight_id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comment: draft }) });
      if (!res.ok) throw new Error((await res.json()).error || "failed");
      setEditing(null);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't save");
    }
  };
  const archive = async (h: Highlight) => {
    try {
      const res = await fetch(`/api/reading/highlights/${h.highlight_id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error || "failed");
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't archive");
    }
  };

  return (
    <section className="mt-6">
      <button onClick={() => setOpen((s) => !s)} className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2">
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
        Highlights by concept ({o.highlights.length})
      </button>
      {open &&
        (groups.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">No highlights yet. Each one with a comment is 5 XP and enters the review queue tomorrow.</p>
        ) : (
          groups.map(([concept, items]) => (
            <div key={concept} className="mb-4">
              <div className="text-[12px] text-text-secondary mb-1.5">
                {concept} <span className="font-mono text-text-tertiary">· {items.length}</span>
              </div>
              <div className="rounded-[6px] border border-border-subtle divide-y divide-border-subtle bg-surface-card">
                {items.map((h) => (
                  <div key={h.highlight_id} className="px-3 py-2.5">
                    <p className="text-[13px] text-text-primary leading-relaxed">&ldquo;{h.passage}&rdquo;</p>
                    {editing === h.highlight_id ? (
                      <div className="mt-1.5 flex gap-2">
                        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} className="flex-1 bg-white/[0.03] border border-border-subtle rounded-[6px] px-2 py-1 text-[13px] italic text-text-primary" />
                        <button onClick={() => saveComment(h)} className="h-8 w-8 rounded-[6px] border border-accent/60 text-accent inline-flex items-center justify-center">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setEditing(null)} className="h-8 w-8 rounded-[6px] border border-border-subtle text-text-tertiary inline-flex items-center justify-center">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditing(h.highlight_id);
                          setDraft(h.comment ?? "");
                        }}
                        className="mt-1 text-left text-[13px] italic text-text-secondary hover:text-text-primary"
                      >
                        {h.comment || <span className="text-text-tertiary not-italic">+ add a comment</span>}
                      </button>
                    )}
                    <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-text-tertiary">
                      {h.chapter != null && <span>ch {h.chapter}</span>}
                      {h.location && <span>{h.location}</span>}
                      <span className="uppercase">{h.source}</span>
                      {h.next_review && <span>review {h.next_review <= o.today ? "due" : fmtDate(h.next_review)}</span>}
                      <span className={h.notion_block_id ? "text-accent/70" : ""}>{h.notion_block_id ? "notion ✓" : "notion …"}</span>
                      <button onClick={() => archive(h)} className="ml-auto hover:text-[var(--color-down)]">
                        archive
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        ))}
    </section>
  );
}

function SessionsList({ o }: { o: ReadingOverview }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-4">
      <button onClick={() => setOpen((s) => !s)} className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2">
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
        Session log ({o.sessions.length})
      </button>
      {open &&
        (o.sessions.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">No sessions yet.</p>
        ) : (
          <div className="rounded-[6px] border border-border-subtle divide-y divide-border-subtle bg-surface-card">
            {o.sessions.map((s) => (
              <div key={s.session_id} className="px-3 py-2.5">
                <div className="flex items-center gap-2 text-[12px] font-mono text-text-secondary">
                  <span className="text-text-primary">{fmtDate(s.session_date, { weekday: "short", month: "short", day: "numeric" })}</span>
                  <span>{s.chapter_through != null ? `ch ${s.chapter_from ?? "?"}–${s.chapter_through}` : s.in_chapter != null ? `in ch ${s.in_chapter}` : "ch ?"}</span>
                  {s.minutes ? <span>{s.minutes} min</span> : null}
                  {s.medium && s.source !== "kindle" && <span className="uppercase text-[10px]">{s.medium}</span>}
                  {s.source === "kindle" && (
                    <span className="uppercase text-[10px] text-amber-300/80" title="Derived from your Kindle highlights, notes and reading position">
                      kindle · auto{s.highlight_count ? ` · ${s.highlight_count} hl` : ""}
                    </span>
                  )}
                  <span className={`ml-auto text-[10px] ${s.notion_block_id ? "text-accent/70" : "text-text-tertiary"}`}>{s.notion_block_id ? "notion ✓" : ""}</span>
                </div>
                {s.recall && <p className="mt-1 text-[13px] text-text-primary leading-relaxed">{s.recall}</p>}
                {s.question && <p className="mt-1 text-[12px] text-text-secondary italic">Q: {s.question}</p>}
              </div>
            ))}
          </div>
        ))}
    </section>
  );
}
