"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Check, ChevronDown, Flame, Highlighter, Sparkles, Trophy, X } from "lucide-react";
import MetricRing from "@/components/MetricRing";
import InfoHint from "@/components/InfoHint";
import { CHECKPOINT_SIZE, CONCEPTS, checkpointOffer, type Checkpoint, type Highlight, type HighlightSource, type ReadingOverview, type Book } from "@/lib/reading";
import { clientCache } from "@/lib/client-cache";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { AutosaveRefused, saveRequest } from "@/lib/autosave";
import { highlightValue, ownRetriedHighlight, sameReadingValue, type HighlightValue } from "@/lib/reading-autosave";
import { useAutosave } from "@/lib/use-autosave";
import { sameJson } from "@/lib/format";
import { getJson } from "@/lib/reading-practice-client";
import { checkpointRefusal, checkpointUrl, hasUnrecordedAnswers, parseCheckpoint } from "@/lib/reading-map";
import { Part, PartGroup, PartGrid } from "@/components/personalize/PartGrid";
import LogLink from "@/components/LogLink";
import ReadingList from "./ReadingList";
import ReviewCard from "./ReviewCard";
import PracticePart from "./PracticePart";
import RetrievalSession from "./RetrievalSession";
import ChapterMap from "./ChapterMap";
import CheckpointQuiz from "./CheckpointQuiz";

/**
 * Which checkpoints held answers without a result, as last read, kept for the session (memory only, one entry per book
 * and checkpoint) so the page coming back into view (the continuous scroll mounts and unmounts it) does not read again.
 */
const UNRECORDED_TTL_MS = 120_000;
const unrecordedMemo = new Map<string, { at: number; pending: boolean }>();

const BurnupChart = dynamic(() => import("./BurnupChart"), { ssr: false, loading: () => <div className="h-[180px]" /> });

/**
 * /reading — the reading quest (2026-11-07).
 *
 * One book at a time: progress ring + pace against the target date, session
 * streak, XP / level, badges, three checkpoints, a burn-up chart, today's
 * spaced-repetition review, and the highlight capture form (a comment, or a
 * pasted Kindle export), which saves as it is entered (lib/autosave.ts): created on
 * the first non-empty passage, then edited in place. Sessions are logged on /log
 * (one place to enter data).
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
  // The checkpoint quiz open on screen (READ-QUIZ-01 S5), and the checkpoints whose answers were stored without Done
  // (keyed by book and checkpoint, so another book's "ch12" is not this one's).
  const [quiz, setQuiz] = useState<Checkpoint | null>(null);
  const [unrecorded, setUnrecorded] = useState<Record<string, boolean>>({});
  // Checkpoints whose quiz read answered "not available" (the checkpoint SQL is not applied yet): no Start button for
  // them, so the tile never leads to a dead end.
  const [offerOff, setOfferOff] = useState<Record<string, boolean>>({});
  const markUnrecorded = useCallback((book: string, key: string, pending: boolean) => {
    unrecordedMemo.set(`${book}:${key}`, { at: Date.now(), pending });
    setUnrecorded((prev) => (prev[`${book}:${key}`] === pending ? prev : { ...prev, [`${book}:${key}`]: pending }));
  }, []);

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
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load");
        // The Review card's Refresh keeps its card blocked and says so (ReviewCard.tsx).
        return false;
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

  // Which offered checkpoints already hold answers without a recorded result ("Answered · record result"), read from
  // the stored answers rather than from this page's memory, so it survives a reload and shows on another device. One
  // light GET per offered checkpoint (no cards read, nothing written), all at once and after the page's own reads have
  // settled; the answer is kept for the session. The copy in the continuous scroll reads nothing: the routed page does.
  const offerBook = overview?.book.slug ?? null;
  const offered = overview ? overview.checkpoints.filter((c) => checkpointOffer(overview, c)).map((c) => `${c.key}:${c.chapter}`).join(",") : "";
  useEffect(() => {
    if (feed || !offerBook || !offered) return;
    let live = true;
    const run = async () => {
      await Promise.all(
        offered.split(",").map(async (part) => {
          const [key, chapter] = part.split(":");
          const seen = unrecordedMemo.get(`${offerBook}:${key}`);
          if (seen && Date.now() - seen.at < UNRECORDED_TTL_MS) {
            if (live) markUnrecorded(offerBook, key, seen.pending);
            return;
          }
          const r = await getJson(checkpointUrl(offerBook, Number(chapter), true));
          if (!live) return;
          // The quiz round is not available (the checkpoint SQL is missing): do not offer a quiz that cannot open.
          if (r.status !== 200 && checkpointRefusal(r.status, r.body).kind === "off") {
            setOfferOff((prev) => (prev[`${offerBook}:${key}`] === true ? prev : { ...prev, [`${offerBook}:${key}`]: true }));
            return;
          }
          const parsed = r.status === 200 ? parseCheckpoint(r.body) : null;
          if (parsed) markUnrecorded(offerBook, key, hasUnrecordedAnswers(parsed));
        }),
      );
    };
    const timer = setTimeout(() => void run(), 1200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [feed, offerBook, offered, markUnrecorded]);

  // Want to read (ReadingList.tsx): after a change, re-read the quest and the book list; a book Riley just started
  // is shown (his explicit choice). A queued book is never picked as the quest on its own.
  const onListChanged = useCallback(
    (e: { started?: string }) => {
      if (e.started) {
        setSlug(e.started);
        void load(e.started, true);
      } else void load(slug, true);
    },
    [load, slug],
  );
  const wantList = <ReadingList books={books} onChanged={onListChanged} />;

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
        <div className="mt-5">{wantList}</div>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="max-w-3xl pb-24">
        <h2 data-testid={headingTestId} className="text-[28px] font-medium text-text-primary">Reading</h2>
        <p className="mt-3 text-sm text-text-secondary">No book in progress.</p>
        <div className="mt-5">{wantList}</div>
      </div>
    );
  }

  const o = overview;
  // The switcher lists books with a quest; queued ones live on Want to read (the one on screen always stays).
  const questBooks = books.filter((b) => b.status !== "queued" || b.slug === o.book.slug);

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
        {questBooks.length > 1 && (
          <select
            value={o.book.slug}
            onChange={(e) => {
              setSlug(e.target.value);
              load(e.target.value);
            }}
            className="bg-surface-card border border-border-subtle rounded-control text-[12px] px-2 py-1.5 text-text-secondary"
          >
            {questBooks.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* The checkpoint quiz opens in place (a full-screen sheet on a phone) and closes back to the tiles. */}
      {quiz && (
        <CheckpointQuiz
          key={`${o.book.slug}:${quiz.key}`}
          slug={o.book.slug}
          checkpoint={quiz.key}
          chapter={quiz.chapter}
          onRecorded={(r) => {
            markUnrecorded(o.book.slug, quiz.key, false);
            showToast({ text: `Checkpoint ${r.score}/${r.total}${r.xp ? ` · +${r.xp} XP` : ""}`, kind: r.passed ? "xp" : "ok" });
            void load(slug, true);
          }}
          onClose={(r) => {
            const book = o.book.slug;
            const key = quiz.key;
            setQuiz(null);
            if (r.unrecorded) void r.unrecorded.then((v) => markUnrecorded(book, key, v));
            else markUnrecorded(book, key, false);
            if (r.changed) void Promise.resolve(r.settled).then(() => load(slug, true));
          }}
        />
      )}

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
            <CheckpointTile c={c} offer={quiz === null && checkpointOffer(o, c) && offerOff[`${o.book.slug}:${c.key}`] !== true} pendingRecord={quiz === null && unrecorded[`${o.book.slug}:${c.key}`] === true} onStart={() => setQuiz(c)} />
          </Part>
        ))}
      </PartGroup>

      {/* Chapters (READ-QUIZ-01 S5): the chapter map, once the book's questions are on. */}
      {o.practice?.enabled && (
        <PartGroup id="section-chapters" title="Chapters">
          <Part id="chapter-map" title="Chapter map">
            <ChapterMap key={o.book.slug} o={o} onChanged={() => load(slug, true)} />
          </Part>
        </PartGroup>
      )}

      <PartGroup id="section-practice" title="Review & capture">
        {/* Practice (READ-QUIZ-01): the chapter question round when the book's questions are on; otherwise the Review
            card as before (with the approval card above it). The part keeps its id so saved layouts keep their place. */}
        <Part id="review" title="Practice">
          <PracticePart
            key={o.book.slug}
            o={o}
            onChanged={() => load(slug, true)}
            review={<ReviewCard o={o} onGraded={(xp) => { if (xp) showToast({ text: `+${xp} XP · review day`, kind: "xp" }); load(slug, true); }} onRefresh={() => load(slug, true)} />}
          />
        </Part>

        <Part id="retrieval" title="Practice from memory">
          <RetrievalSession key={o.book.slug} o={o} />
        </Part>

        {/* Sessions are logged on Log (one place to enter data); the Session log below lists them. */}
        <Part id="log-session" title="Log a session">
          <div className="flex justify-end">
            <LogLink part="reading">Log a reading session on Log</LogLink>
          </div>
        </Part>

        <Part id="add-highlight" title="Highlight + comment">
          <HighlightForm key={o.book.slug} o={o} onAdded={(n) => { showToast({ text: n === 1 ? "+5 XP · highlight" : `${n} highlights imported`, kind: "ok" }); load(slug, true); }} onSaved={() => load(slug, true)} onError={(m) => showToast({ text: m, kind: "err" })} />
        </Part>
      </PartGroup>

      <PartGroup id="section-want-list" title="Want to read">
        <Part id="want-to-read" title="Want to read">
          {wantList}
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

function CheckpointTile({ c, offer, pendingRecord, onStart }: { c: ReadingOverview["checkpoints"][number]; offer: boolean; pendingRecord: boolean; onStart: () => void }) {
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
          <span className={c.quiz.verification !== "invalidated" && c.quiz.score / c.quiz.total >= 0.8 ? "text-accent" : "text-text-secondary"}>
            quiz {c.quiz.score}/{c.quiz.total}
            {/* A question in it was corrected later (lib/reading-questions.ts): kept, earns no XP. Unverified = recorded
                without its per-question answers, so the score can't be checked (still counted). */}
            {c.quiz.verification === "invalidated" ? " · corrected" : c.quiz.verification === "unverified" ? " · unverified" : ""}
          </span>
        ) : offer || pendingRecord ? (
          "no result yet"
        ) : c.reached ? (
          <Link href="/chat" className="text-accent/80 underline underline-offset-2">
            quiz me →
          </Link>
        ) : (
          "no quiz yet"
        )}
      </div>
      {/* The quiz in the app (READ-QUIZ-01): offered once the book's questions are on and the chapter is quizzable. */}
      {(offer || pendingRecord) && (
        <button
          type="button"
          onClick={onStart}
          className="mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-full border border-accent/60 px-2 py-1.5 text-center text-[12px] leading-tight text-accent"
        >
          {pendingRecord ? "Answered · record result" : `Start checkpoint · ${CHECKPOINT_SIZE} questions`}
        </button>
      )}
    </div>
  );
}

/**
 * "Highlight + comment". One highlight, saved as it is entered: created (POST /api/reading/highlights, idempotent
 * on the passage) once the passage is not empty and Riley pauses or leaves a field, then every later edit updates
 * the same highlight (PATCH /api/reading/highlights/[id]). A passage that was already saved (e.g. by the Kindle
 * harvester) is attached as it is: later edits write only the comment, chapter and concept filled in here (never
 * its source, never a clear), and changing its passage starts a new highlight. "New highlight" starts the next one; "Remove" archives the one
 * just made. The Kindle export paste stays a Preview / Import action.
 */
function HighlightForm({ o, onAdded, onSaved, onError }: { o: ReadingOverview; onAdded: (n: number) => void; onSaved: () => void; onError: (m: string) => void }) {
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
  const [highlightId, setHighlightIdState] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);
  // The highlight this form made or attached to: its id, whether it existed before, and its saved passage.
  const hlRef = useRef<{ id: number; existing: boolean; passage: string } | null>(null);
  // A create this form sent without hearing back (network error, timeout): its passage and when it was first sent.
  // A retry that finds that row is this form's own highlight, not one saved before (ownRetriedHighlight).
  const unconfirmed = useRef<{ passage: string; at: number } | null>(null);
  const fields = useRef({ passage, comment, chapter, concept, customConcept, source });
  const oRef = useRef(o);
  oRef.current = o;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const setHighlight = (h: { id: number; existing: boolean; passage: string } | null) => {
    hlRef.current = h;
    setHighlightIdState(h?.id ?? null);
  };

  const autosave = useAutosave<HighlightValue>("reading-highlight", {
    delayMs: 1500,
    ready: (v) => v.reason,
    same: sameReadingValue,
    save: async (v, { keepalive }) => {
      if (!v.body) return;
      const hl = hlRef.current;
      // A new highlight, or a different passage after attaching to one saved before: create.
      if (!hl || (hl.existing && v.body.passage !== hl.passage)) {
        if (unconfirmed.current?.passage !== v.body.passage) unconfirmed.current = { passage: v.body.passage, at: Date.now() };
        const json = await saveRequest("/api/reading/highlights", { method: "POST", body: { ...v.body, book: oRef.current.book.slug }, keepalive });
        const h = json.highlight as { highlight_id?: number; passage?: string; created_at?: string } | undefined;
        const own = !!json.created || (!!h && ownRetriedHighlight(h, unconfirmed.current));
        unconfirmed.current = null;
        if (!h?.highlight_id) return;
        setHighlight({ id: h.highlight_id, existing: !own, passage: h.passage ?? v.body.passage });
        if (own && !json.created) {
          // The retry found the row this form's lost send made: it is ours, so it takes the values on screen.
          const body = { passage: v.body.passage, comment: v.body.comment, chapter: v.body.chapter, concept: v.body.concept, source: v.body.source };
          await saveRequest(`/api/reading/highlights/${h.highlight_id}`, { method: "PATCH", body, keepalive });
        }
        if (own) onAdded(1);
        else onSaved();
        return;
      }
      let body: Record<string, unknown>;
      if (hl.existing) {
        // Saved before (e.g. by the harvester): only what is filled in here is written, like the POST's re-import
        // rule, so an empty field never clears its stored comment, chapter or concept.
        body = {};
        if (v.body.comment.trim()) body.comment = v.body.comment;
        if (v.body.chapter !== null) body.chapter = v.body.chapter;
        if (v.body.concept) body.concept = v.body.concept;
        if (!Object.keys(body).length) return;
      } else {
        body = { passage: v.body.passage, comment: v.body.comment, chapter: v.body.chapter, concept: v.body.concept, source: v.body.source };
      }
      try {
        await saveRequest(`/api/reading/highlights/${hl.id}`, { method: "PATCH", body, keepalive });
      } catch (e) {
        if (e instanceof AutosaveRefused && /no longer exists/i.test(e.message)) {
          if (hlRef.current?.id === hl.id) setHighlight(null);
          throw new AutosaveRefused("That highlight was removed elsewhere. Retry saves it again.");
        }
        throw e;
      }
      if (hlRef.current?.id === hl.id && !hl.existing) hlRef.current = { ...hl, passage: v.body.passage };
      onSaved();
    },
  });

  const commit = (patch: Partial<typeof fields.current>) => {
    const f = { ...fields.current, ...patch };
    fields.current = f;
    const blank = !f.passage.trim() && !f.comment.trim() && !f.chapter.trim();
    if (blank && !hlRef.current) {
      autosave.reset();
      return;
    }
    autosave.change(highlightValue({ passage: f.passage, comment: f.comment, chapter: f.chapter, concept: f.concept === "__custom" ? f.customConcept : f.concept, source: f.source }));
  };

  const startNew = () => {
    setHighlight(null);
    unconfirmed.current = null;
    autosave.reset();
    fields.current = { ...fields.current, passage: "", comment: "" };
    setPassage("");
    setComment("");
  };

  const removeHighlight = async () => {
    const hl = hlRef.current;
    if (!hl || removing) return;
    autosave.reset();
    setRemoving(true);
    try {
      const res = await fetch(`/api/reading/highlights/${hl.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
      if (!alive.current) return;
      startNew();
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? `Couldn't remove the highlight: ${e.message}` : "Couldn't remove the highlight");
    } finally {
      if (alive.current) setRemoving(false);
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

  const st = autosave.state.status;
  const busy = st === "saving" || removing;

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
        <div onBlur={() => void autosave.flush()}>
          <textarea
            value={passage}
            onChange={(e) => {
              setPassage(e.target.value);
              commit({ passage: e.target.value });
            }}
            rows={3}
            placeholder="The passage, as written."
            className="mt-3 w-full bg-white/[0.03] border border-border-subtle rounded-control px-3 py-2 text-[14px] text-text-primary leading-relaxed"
          />
          <textarea
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              commit({ comment: e.target.value });
            }}
            rows={2}
            placeholder="Your comment. Why it matters, or where it shows up in BC."
            className="mt-2 w-full bg-white/[0.03] border border-border-subtle rounded-control px-3 py-2 text-[14px] text-text-primary italic"
          />
          <div className="mt-2 grid grid-cols-[88px_1fr] gap-2">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={chapter}
              onChange={(e) => {
                setChapter(e.target.value);
                commit({ chapter: e.target.value });
              }}
              placeholder="ch."
              className="bg-white/[0.03] border border-border-subtle rounded-control px-2 py-2 text-[13px] font-mono text-text-primary"
            />
            <select
              value={concept}
              onChange={(e) => {
                setConcept(e.target.value);
                commit({ concept: e.target.value });
              }}
              className="bg-white/[0.03] border border-border-subtle rounded-control px-2 py-2 text-[13px] text-text-primary"
            >
              <option value="">Concept (optional)</option>
              {CONCEPTS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__custom">Other…</option>
            </select>
          </div>
          {concept === "__custom" && (
            <input
              value={customConcept}
              onChange={(e) => {
                setCustomConcept(e.target.value);
                commit({ customConcept: e.target.value });
              }}
              placeholder="Concept name"
              className="mt-2 w-full bg-white/[0.03] border border-border-subtle rounded-control px-3 py-2 text-[13px] text-text-primary"
            />
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {SOURCES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  setSource(s.key);
                  commit({ source: s.key });
                }}
                aria-pressed={source === s.key}
                className={`px-2.5 h-7 rounded-control border text-[11px] ${source === s.key ? "bg-accent/15 border-accent/60 text-accent" : "border-border-subtle text-text-tertiary"}`}
              >
                {s.label}
              </button>
            ))}
            {highlightId !== null && (
              <span className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void removeHighlight()}
                  disabled={busy}
                  className="px-2 h-8 text-[12px] text-text-tertiary hover:text-[var(--color-down)] underline underline-offset-2 disabled:opacity-40"
                >
                  {removing ? "Removing…" : "Remove"}
                </button>
                <button
                  type="button"
                  onClick={() => void autosave.flush().then((ok) => { if (ok && alive.current) startNew(); })}
                  disabled={busy || st === "error"}
                  className="px-3 h-8 rounded-control text-[13px] font-medium border border-border-subtle text-text-secondary hover:text-text-primary disabled:opacity-40"
                >
                  New highlight
                </button>
              </span>
            )}
          </div>
          <p className="mt-2 text-[11px]">
            <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} />
          </p>
        </div>
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
