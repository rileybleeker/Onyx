"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Check, ChevronDown, Flame, Highlighter, Sparkles, Trophy, X } from "lucide-react";
import MetricRing from "@/components/MetricRing";
import InfoHint from "@/components/InfoHint";
import { CONCEPTS, type Grade, type Highlight, type HighlightSource, type ReadingOverview, type Book } from "@/lib/reading";
import { clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import { Part, PartGroup, PartGrid } from "@/components/personalize/PartGrid";
import LogLink from "@/components/LogLink";

const BurnupChart = dynamic(() => import("./BurnupChart"), { ssr: false, loading: () => <div className="h-[180px]" /> });

/**
 * /reading — the reading quest (2026-11-07).
 *
 * One book at a time: progress ring + pace against the target date, session
 * streak, XP / level, badges, three checkpoints, a burn-up chart, today's
 * spaced-repetition review, and the highlight capture form (a comment, or a
 * pasted Kindle export). Sessions are logged on /log (one place to enter data).
 * Writes go to /api/reading/*; each write mirrors to the book's Notion
 * reading-log page server-side. All numbers are derived in lib/reading.ts.
 */

type Toast = { text: string; kind: "xp" | "ok" | "err" } | null;

const SOURCES: Array<{ key: HighlightSource; label: string }> = [
  { key: "kindle", label: "Kindle" },
  { key: "audible", label: "Audible clip" },
  { key: "paper", label: "Paper" },
  { key: "manual", label: "Other" },
];

const fmtDate = (d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", ...opts }) : "—";

type ReadingAnswer = { overview: ReadingOverview | null; books?: Book[] };
const readingUrl = (which: string | null) => `/api/reading${which ? `?book=${encodeURIComponent(which)}` : ""}`;
function cachedReading(raw: unknown): ReadingAnswer | null {
  const v = raw as ReadingAnswer | undefined;
  return v && "overview" in v && (v.overview === null || !!v.overview?.book?.slug) ? v : null;
}

/** `feed`: drawn inside the continuous scroll (FeedSection.tsx); the heading is then marked feed-page-heading. */
export default function ReadingClient({ feed = false }: { feed?: boolean } = {}) {
  const headingTestId = feed ? "feed-page-heading" : "page-heading";
  // Start from the cached answer (Today and the warm-up read the same URL), then revalidate.
  const [seed] = useState(() => cachedReading(clientCache.peek(readingUrl(null))));
  const [overview, setOverview] = useState<ReadingOverview | null>(seed?.overview ?? null);
  const [books, setBooks] = useState<Book[]>(seed?.books ?? []);
  const [slug, setSlug] = useState<string | null>(seed?.overview?.book.slug ?? null);
  const [loading, setLoading] = useState(!seed);
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
        const res = await fetch(readingUrl(which), { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        clientCache.put(readingUrl(which), json);
        setOverview((prev) => (sameJson(prev, json.overview) ? prev : json.overview));
        setBooks((prev) => (sameJson(prev, json.books ?? []) ? prev : json.books ?? []));
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
    // With a cached answer on screen the first load is silent (no skeleton).
    load(null, !!seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && !overview) {
    return (
      <div className="max-w-3xl space-y-3">
        <div className="h-8 w-40 bg-white/5 animate-pulse rounded" />
        <div className="h-44 bg-white/[0.03] animate-pulse rounded-control" />
        <div className="h-28 bg-white/[0.03] animate-pulse rounded-control" />
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="max-w-3xl">
        <h2 data-testid={headingTestId} className="text-[28px] font-medium text-text-primary">Reading</h2>
        <p className="mt-3 text-sm text-red-400">{error}</p>
        <p className="mt-1 text-[12px] text-text-tertiary">If this is a fresh deploy, apply sql/reading_schema.sql in Supabase first.</p>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="max-w-3xl">
        <h2 data-testid={headingTestId} className="text-[28px] font-medium text-text-primary">Reading</h2>
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
          <h2 data-testid={headingTestId} className="text-[28px] font-medium text-text-primary">Reading</h2>
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
            className="bg-surface-card border border-border-subtle rounded-control text-[12px] px-2 py-1.5 text-text-secondary"
          >
            {books.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Personalize: every card, checkpoint tile and list is its own part; sections have no extra heading on screen. */}
      <PartGrid page="/reading" title="Reading" gap={16}>
      <PartGroup id="section-quest" title="Quest & pace">
        <Part id="quest" title="Quest (progress, level, streak)">
          <QuestCard o={o} />
        </Part>

        {/* Burn-up */}
        <Part id="burnup" title="Chapters vs pace">
          <section className="bg-surface-card border border-border-subtle rounded-card shadow-card px-4 pt-3 pb-1">
            <div className="flex items-baseline justify-between mb-1">
              <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Chapters vs pace</h3>
              <span className="text-[11px] font-mono text-text-tertiary">
                {fmtDate(o.book.start_date)} → {fmtDate(o.book.target_date)}
              </span>
            </div>
            <BurnupChart data={o.burnup} today={o.today} total={o.totalChapters} />
          </section>
        </Part>
      </PartGroup>

      {/* Checkpoints: one tile each (ids by position, so a layout carries over to the next book), three across like before. */}
      <PartGroup
        id="section-checkpoints"
        title="Checkpoints"
        gridClassName="grid grid-cols-3 gap-2"
        header={o.checkpoints.length ? <CheckpointsHeader /> : null}
      >
        {o.checkpoints.map((c, i) => (
          <Part key={c.key} id={`checkpoint-${i + 1}`} title={`Checkpoint ${i + 1} (ch ${c.chapter})`}>
            <CheckpointTile c={c} />
          </Part>
        ))}
      </PartGroup>

      <PartGroup id="section-practice" title="Review & capture">
        <Part id="review" title="Review">
          <ReviewCard o={o} onGraded={(xp) => { if (xp) showToast({ text: `+${xp} XP · review day`, kind: "xp" }); load(slug, true); }} />
        </Part>

        {/* Sessions are logged on Log (one place to enter data); the Session log below lists them. */}
        <Part id="log-session" title="Log a session">
          <div className="flex justify-end">
            <LogLink part="reading">Log a reading session on Log</LogLink>
          </div>
        </Part>

        <Part id="add-highlight" title="Highlight + comment">
          <HighlightForm o={o} onAdded={(n) => { showToast({ text: n === 1 ? "+5 XP · highlight" : `${n} highlights imported`, kind: "ok" }); load(slug, true); }} onError={(m) => showToast({ text: m, kind: "err" })} />
        </Part>
      </PartGroup>

      <PartGroup id="section-history" title="Badges & history">
        <Part id="badges" title="Badges">
          <Badges o={o} />
        </Part>

        <Part id="highlights" title="Highlights by concept">
          <HighlightsList o={o} onChanged={() => load(slug, true)} onError={(m) => showToast({ text: m, kind: "err" })} />
        </Part>

        <Part id="session-log" title="Session log">
          <SessionsList o={o} />
        </Part>
      </PartGroup>
      </PartGrid>

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
  const paceColor = o.book.status === "finished" || pace.aheadBy >= 0 ? "text-up" : pace.aheadBy >= -2 ? "text-[var(--color-mid)]" : "text-[var(--color-down)]";

  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" data-testid="reading-quest">
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

function CheckpointsHeader() {
  return (
    <div className="mb-2">
      <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Checkpoints</h3>
      <p className="mt-0.5 text-[11px] text-text-tertiary">
        Quiz in <Link href="/chat" className="underline underline-offset-2">Health Q&amp;A</Link> (&ldquo;quiz me through chapter 12&rdquo;). 80% passes.
      </p>
    </div>
  );
}

function CheckpointTile({ c }: { c: ReadingOverview["checkpoints"][number] }) {
  const state = c.reached ? (c.onTime ? "done" : "late") : c.onTime === false ? "missed" : "upcoming";
  const border =
    state === "done" ? "border-accent/60" : state === "late" ? "border-[var(--color-mid)]/60" : state === "missed" ? "border-[var(--color-down)]/60" : "border-border-subtle";
  return (
    <div className={`bg-surface-card border ${border} rounded-control px-3 py-2.5`}>
      <div className="text-[13px] font-medium text-text-primary">Ch {c.chapter}</div>
      <div className="text-[11px] font-mono text-text-tertiary">by {fmtDate(c.due)}</div>
      <div className="mt-1.5 text-[11px] font-mono">
        {state === "done" && <span className="text-up">✓ on time</span>}
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
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" data-testid="reading-review">
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
            <button onClick={() => setRevealed(true)} className="mt-3 px-3 py-1.5 text-[13px] rounded-control border border-border-subtle bg-white/[0.03] hover:bg-white/[0.06] text-text-secondary">
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
    <button onClick={onClick} disabled={disabled} className={`flex-1 h-11 rounded-control border bg-white/[0.02] disabled:opacity-40 ${className}`}>
      <div className="text-[13px] font-medium leading-none">{label}</div>
      <div className="text-[10px] font-mono opacity-70 mt-1">{sub}</div>
    </button>
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
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" data-testid="reading-highlight-form">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary flex items-center gap-1.5">
          <Highlighter className="w-3.5 h-3.5" /> Highlight + comment
        </h3>
        <div className="flex gap-1 text-[11px] font-mono">
          <button onClick={() => setMode("one")} className={`px-2 py-1 rounded-control ${mode === "one" ? "bg-white/[0.08] text-text-primary" : "text-text-tertiary"}`}>
            one
          </button>
          <button onClick={() => setMode("import")} className={`px-2 py-1 rounded-control ${mode === "import" ? "bg-white/[0.08] text-text-primary" : "text-text-tertiary"}`}>
            paste Kindle export
          </button>
        </div>
      </div>

      {mode === "one" ? (
        <>
          <textarea value={passage} onChange={(e) => setPassage(e.target.value)} rows={3} placeholder="The passage, as written." className="mt-3 w-full bg-white/[0.03] border border-border-subtle rounded-control px-3 py-2 text-[14px] text-text-primary leading-relaxed" />
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Your comment. Why it matters, or where it shows up in BC." className="mt-2 w-full bg-white/[0.03] border border-border-subtle rounded-control px-3 py-2 text-[14px] text-text-primary italic" />
          <div className="mt-2 grid grid-cols-[88px_1fr] gap-2">
            <input type="number" inputMode="numeric" min={0} value={chapter} onChange={(e) => setChapter(e.target.value)} placeholder="ch." className="bg-white/[0.03] border border-border-subtle rounded-control px-2 py-2 text-[13px] font-mono text-text-primary" />
            <select value={concept} onChange={(e) => setConcept(e.target.value)} className="bg-white/[0.03] border border-border-subtle rounded-control px-2 py-2 text-[13px] text-text-primary">
              <option value="">Concept (optional)</option>
              {CONCEPTS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__custom">Other…</option>
            </select>
          </div>
          {concept === "__custom" && <input value={customConcept} onChange={(e) => setCustomConcept(e.target.value)} placeholder="Concept name" className="mt-2 w-full bg-white/[0.03] border border-border-subtle rounded-control px-3 py-2 text-[13px] text-text-primary" />}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SOURCES.map((s) => (
              <button key={s.key} onClick={() => setSource(s.key)} aria-pressed={source === s.key} className={`px-2.5 h-7 rounded-control border text-[11px] ${source === s.key ? "bg-accent/15 border-accent/60 text-accent" : "border-border-subtle text-text-tertiary"}`}>
                {s.label}
              </button>
            ))}
            <button onClick={addOne} disabled={saving || !passage.trim()} className="ml-auto px-4 h-8 rounded-control text-[13px] font-medium bg-accent text-black disabled:opacity-40">
              {saving ? "Saving…" : "Add highlight"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            <p className="text-[12px] text-text-tertiary">Paste a Kindle notebook export, My Clippings.txt or a plain list.</p>
            <InfoHint label="Importing highlights">
              <p>
                Kindle app → notebook → share → <span className="text-text-primary">Export notebook</span>, then paste the
                email body. In a plain list, separate passages with blank lines; a line starting with &ldquo;&gt;&rdquo; under a
                passage becomes its comment. Re-pasting the same export is safe.
              </p>
            </InfoHint>
          </div>
          <textarea
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value);
              setPreview(null);
            }}
            rows={6}
            placeholder="Paste here"
            className="mt-2 w-full bg-white/[0.03] border border-border-subtle rounded-control px-3 py-2 text-[12px] font-mono text-text-primary"
          />
          <div className="mt-2 flex items-center gap-2">
            {preview && (
              <span className="text-[12px] font-mono text-text-secondary">
                {preview.count} highlight{preview.count === 1 ? "" : "s"} · {preview.format}
              </span>
            )}
            <button onClick={doPreview} disabled={saving || !importText.trim()} className="ml-auto px-3 h-8 rounded-control text-[13px] border border-border-subtle text-text-secondary disabled:opacity-40">
              Preview
            </button>
            <button onClick={doImport} disabled={saving || !preview || preview.count === 0} className="px-4 h-8 rounded-control text-[13px] font-medium bg-accent text-black disabled:opacity-40">
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
    <section>
      <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2 flex items-center gap-1.5">
        <Trophy className="w-3.5 h-3.5" /> Badges
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {o.badges.map((b) => (
          <div key={b.key} title={b.description} className={`rounded-control border px-3 py-2 ${b.earned ? "bg-accent/10 border-accent/50" : "bg-surface-card border-border-subtle opacity-60"}`}>
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
    <section className="pt-2">
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
              <div className="rounded-control border border-border-subtle divide-y divide-border-subtle bg-surface-card">
                {items.map((h) => (
                  <div key={h.highlight_id} className="px-3 py-2.5">
                    <p className="text-[13px] text-text-primary leading-relaxed">&ldquo;{h.passage}&rdquo;</p>
                    {editing === h.highlight_id ? (
                      <div className="mt-1.5 flex gap-2">
                        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} className="flex-1 bg-white/[0.03] border border-border-subtle rounded-control px-2 py-1 text-[13px] italic text-text-primary" />
                        <button onClick={() => saveComment(h)} className="h-8 w-8 rounded-control border border-accent/60 text-accent inline-flex items-center justify-center">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setEditing(null)} className="h-8 w-8 rounded-control border border-border-subtle text-text-tertiary inline-flex items-center justify-center">
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
                      <span className={h.notion_block_id ? "text-up/70" : ""}>{h.notion_block_id ? "notion ✓" : "notion …"}</span>
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
    <section>
      <button onClick={() => setOpen((s) => !s)} className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2">
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
        Session log ({o.sessions.length})
      </button>
      {open &&
        (o.sessions.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">No sessions yet.</p>
        ) : (
          <div className="rounded-control border border-border-subtle divide-y divide-border-subtle bg-surface-card">
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
                  <span className={`ml-auto text-[10px] ${s.notion_block_id ? "text-up/70" : "text-text-tertiary"}`}>{s.notion_block_id ? "notion ✓" : ""}</span>
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
