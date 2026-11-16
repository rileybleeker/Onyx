"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import MetricRing from "@/components/MetricRing";
import { clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import type { ReadingOverview } from "@/lib/reading";
import {
  APPROVAL_URL,
  bankNotice,
  bankUrl,
  capDollars,
  classifyApprovalAnswer,
  getJson,
  parseBank,
  parseRound,
  postJson,
  practiceUrl,
  roundForToday,
  roundProgress,
  weekday,
  type BankState,
  type PracticeRound,
} from "@/lib/reading-practice-client";
import BankApproval from "./BankApproval";

/** The runner is its own chunk: loaded on hover / focus of Start, and by the app's warm-up (components/AppData.tsx). */
const loadRunner = () => import("./PracticeRunner");
const PracticeRunner = dynamic(loadRunner, { ssr: false, loading: () => <div className="h-[320px]" aria-hidden="true" /> });
const prefetchRunner = () => {
  void loadRunner().catch(() => undefined);
};

/**
 * /reading Practice part (READ-QUIZ-01 S4): the `review` part's content.
 *
 * - The bank off for this book (or its SQL not applied, or its routes not deployed): the existing Review card
 *   (PROD-T03), exactly as before; with the bank's state readable and off, the approval card above it.
 * - On: today's round (a ring with its progress, "8 ready · about 4 min", Start, Quick 3, the chapter recall line,
 *   and one line about the bank itself: being built, few sources, paused for budget, failed), then the runner in
 *   place (desktop) or as a full-screen sheet (phone). The unlinked highlight reviews are in the round.
 *
 * Reads: two GETs in parallel on mount, both with no side effect and both cached (lib/client-cache.ts persists them:
 * book-derived content and schedules, no answers); a cached round is shown only for the overview's behavioral day.
 * Nothing is written and nothing is generated until a tap (inside the continuous scroll too). When the runner closes
 * after a change it re-reads the overview (`onChanged`) and the round once; when answers or flags were still on
 * their way, it waits for them first (the runner's `settled`, at most 10 s) and keeps Start waiting meanwhile, so a
 * reopened round never asks a question whose answer is still being stored. Start keeps waiting until the round has been
 * read again and replaced the one the runner was opened from; when that read fails the old round is dropped (and its
 * cached copy), never offered again: its answered cards would be asked, and sent, a second time.
 */
export default function PracticePart({ o, review, onChanged }: { o: ReadingOverview; review: ReactNode; onChanged: () => void }) {
  const slug = o.book.slug;
  const roundUrl = practiceUrl(slug);
  const bUrl = bankUrl(slug);
  const [round, setRound] = useState<PracticeRound | null>(() => roundForToday(parseRound(clientCache.peek(roundUrl)), o.today));
  const [bank, setBank] = useState<BankState | null>(() => parseBank(clientCache.peek(bUrl)));
  // "off": the practice API is not there (SQL not applied, route missing, book unknown): the Review card alone.
  const [avail, setAvail] = useState<"unknown" | "ok" | "off">(() => (round ? "ok" : "unknown"));
  const [loadFailed, setLoadFailed] = useState(false);
  const [runner, setRunner] = useState<{ round: PracticeRound; mode: "daily" | "quick" | "extra" } | null>(null);
  const [finishedKey, setFinishedKey] = useState<string | null>(null);
  const [extraN, setExtraN] = useState(1);
  const [extraState, setExtraState] = useState<"idle" | "loading" | "none" | "failed">("idle");
  const [allowMore, setAllowMore] = useState(false);
  const [menu, setMenu] = useState<"closed" | "open" | "confirm">("closed");
  const [offState, setOffState] = useState<{ saving: boolean; message: string | null; unsure: boolean }>({ saving: false, message: null, unsure: false });
  // Answers or flags from a closed runner still on their way: Start waits, and the round is re-read once they land.
  const [settling, setSettling] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadRound = useCallback(async (): Promise<PracticeRound | null> => {
    const r = await getJson(roundUrl);
    if (!alive.current) return null;
    if (r.status === 200) {
      const parsed = parseRound(r.body);
      if (parsed) {
        clientCache.put(roundUrl, r.body);
        setRound((prev) => (sameJson(prev, parsed) ? prev : parsed));
        setAvail("ok");
        setLoadFailed(false);
        return parsed;
      }
    }
    if (r.status === 503 || r.status === 404) {
      clientCache.remove(roundUrl);
      setRound(null);
      setAvail("off");
      return null;
    }
    setLoadFailed(true);
    return null;
  }, [roundUrl]);

  const loadBank = useCallback(async () => {
    const r = await getJson(bUrl);
    if (!alive.current) return;
    if (r.status === 200) {
      const parsed = parseBank(r.body);
      if (parsed) {
        clientCache.put(bUrl, r.body);
        setBank((prev) => (sameJson(prev, parsed) ? prev : parsed));
        return;
      }
    }
    if (r.status === 503 || r.status === 404) {
      clientCache.remove(bUrl);
      setBank(null);
    }
  }, [bUrl]);

  /** Both reads in parallel; the round (null when it could not be read). */
  const load = useCallback(async (): Promise<PracticeRound | null> => {
    const [fresh] = await Promise.all([loadRound(), loadBank()]);
    return fresh;
  }, [loadRound, loadBank]);

  // Mount (and a new behavioral day): read both, silently over what the cache showed.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.today]);

  const shown = roundForToday(round, o.today);
  const enabled = shown ? shown.enabled : bank?.enabled === true;
  const p = roundProgress(shown);
  const notice = bankNotice(bank);

  /**
   * After the runner: re-read the overview and the round (once what it left on its way has settled), then `then`.
   * Start and One more round wait (`settling`) through all of it, up to the new round replacing the old one: a
   * reopened round built from the old snapshot would ask the answered cards again and send them under new keys. A
   * round that could not be read again is dropped (state and cache) and the part says so, with Try again.
   */
  const afterRunner = useCallback(
    (changed: boolean, settled: Promise<void> | undefined, then?: () => void) => {
      if (!settled && !changed) {
        then?.();
        return;
      }
      setSettling(true);
      void (async () => {
        let fresh: PracticeRound | null = null;
        try {
          if (settled) await settled;
          if (!alive.current) return;
          onChanged();
          fresh = await load();
        } catch {
          fresh = null;
        }
        if (!alive.current) return;
        if (!fresh) {
          clientCache.remove(roundUrl);
          setRound(null);
        }
        try {
          then?.();
        } finally {
          setSettling(false);
        }
      })();
    },
    [onChanged, load, roundUrl],
  );

  const closeRunner = useCallback(
    (changed: boolean, finished: boolean, settled?: Promise<void>) => {
      const r = runner;
      setRunner(null);
      if (r && finished && r.mode !== "quick") setFinishedKey(r.round.round_key);
      if (r?.mode === "extra" && finished) setExtraN((n) => n + 1);
      afterRunner(changed, settled);
    },
    [runner, afterRunner],
  );

  // "One more round": the next extra round that still has cards (an extra round finished earlier today is skipped).
  const startExtra = useCallback(async () => {
    setExtraState("loading");
    for (let n = extraN, tries = 0; tries < 5 && n <= 50; n++, tries++) {
      const r = await getJson(practiceUrl(slug, "extra", n));
      if (!alive.current) return;
      const parsed = r.status === 200 ? parseRound(r.body) : null;
      if (!parsed) {
        setExtraState("failed");
        return;
      }
      if (parsed.cards.some((c) => !c.done)) {
        setExtraN(n);
        setExtraState("idle");
        setRunner({ round: parsed, mode: "extra" });
        return;
      }
      if (parsed.extra_available <= 0) break;
    }
    setExtraState("none");
  }, [extraN, slug]);

  const turnOff = async () => {
    if (offState.saving) return;
    setOffState({ saving: true, message: null, unsure: false });
    const r = await postJson(APPROVAL_URL, { book: slug, on: false, cap_cents: bank?.cap_cents ?? null }, { method: "PUT" });
    if (!alive.current) return;
    const out = classifyApprovalAnswer(r.status, r.body);
    if (out.kind === "saved") {
      setOffState({ saving: false, message: null, unsure: false });
      setMenu("closed");
      void load();
      return;
    }
    // An unknown outcome may have been stored: say so, and read the real state (the part follows it).
    setOffState({ saving: false, message: out.message, unsure: out.kind === "unknown" });
    if (out.kind === "unknown") void load();
  };

  // Off, unknown or not there: the Review card as before; the approval card above it when the bank can be turned on.
  if (avail === "off" || !enabled) {
    const canApprove = avail !== "off" && !!bank && !bank.enabled && bank.estimate_cents !== null && bank.cap_cents !== null;
    return (
      <div className="space-y-3">
        {canApprove && bank && <BankApproval slug={slug} bank={bank} onDone={() => void load()} onRecheck={load} />}
        {review}
      </div>
    );
  }

  const roundDone = !!shown && (p.ready === 0 || finishedKey === shown.round_key) && p.total > 0;
  const startButton = (mode: "daily" | "quick", label: string, primary: boolean) => (
    <button
      type="button"
      onPointerEnter={prefetchRunner}
      onFocus={prefetchRunner}
      aria-disabled={settling || undefined}
      onClick={() => {
        if (shown && !settling) setRunner({ round: shown, mode });
      }}
      className={`${
        primary
          ? "inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 text-[15px] font-medium text-on-accent"
          : "inline-flex min-h-11 items-center px-2 text-[14px] text-accent underline-offset-2 hover:underline"
      } ${settling ? "opacity-60" : ""}`}
    >
      {label}
    </button>
  );

  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" data-testid="reading-practice">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Practice</h3>
        {!runner && (
          <div className="relative">
            <button
              type="button"
              aria-label="Practice options"
              aria-haspopup="menu"
              aria-expanded={menu !== "closed"}
              onClick={() => setMenu((m) => (m === "closed" ? "open" : "closed"))}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-text-tertiary hover:text-text-secondary"
            >
              <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
            </button>
            {menu === "open" && (
              <div role="menu" aria-label="Practice options" className="absolute right-0 top-full z-10 w-60 rounded-control border border-border-default bg-surface-raised py-1 shadow-card">
                <button type="button" role="menuitem" onClick={() => setMenu("confirm")} className="flex min-h-11 w-full items-center px-3 text-left text-[14px] text-text-primary hover:bg-white/[0.05]">
                  Turn off questions for this book
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {menu === "confirm" && !runner && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-control border border-border-subtle p-3 text-[13px] text-text-primary">
          <span className="flex-1">Turn off? Building and grading stop; your answers stay.</span>
          <button
            type="button"
            aria-disabled={offState.saving || undefined}
            onClick={() => void turnOff()}
            className="inline-flex min-h-11 items-center rounded-control border border-border-default px-3 text-text-primary"
          >
            Turn off
          </button>
          <button type="button" onClick={() => setMenu("closed")} className="inline-flex min-h-11 items-center px-2 text-text-secondary">
            Cancel
          </button>
          {offState.message && (
            <p role="alert" className="w-full text-[12px] text-text-primary">
              <strong className="font-medium">{offState.unsure ? "Not sure it turned off:" : "Not turned off:"}</strong> {offState.message}
            </p>
          )}
        </div>
      )}

      {runner ? (
        <div className="mt-2">
          <PracticeRunner
            key={`${runner.round.round_key}:${runner.mode}`}
            round={runner.round}
            mode={runner.mode}
            onClose={closeRunner}
            onMore={(settled) => {
              // Offered on the summary only: this sitting finished its round.
              if (runner.mode === "daily") setFinishedKey(runner.round.round_key);
              setRunner(null);
              afterRunner(true, settled, () => void startExtra());
            }}
            onReread={async () => {
              if (runner.mode !== "extra") return loadRound();
              const r = await getJson(practiceUrl(slug, "extra", runner.round.n));
              return r.status === 200 ? parseRound(r.body) : null;
            }}
          />
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-4">
          <MetricRing value={p.done} max={Math.max(1, p.total)} size={88} thickness={8} centerValue={`${p.done}/${p.total}`} testId="practice-ring" />
          <div className="min-w-0 flex-1 space-y-2">
            {shown && roundDone ? (
              <>
                <p className="font-mono text-[14px] text-text-primary">
                  Done today · {p.done}/{p.total}
                </p>
                {shown.extra_available > 0 && (
                  <button
                    type="button"
                    onPointerEnter={prefetchRunner}
                    onFocus={prefetchRunner}
                    aria-disabled={extraState === "loading" || settling || undefined}
                    onClick={() => {
                      if (extraState !== "loading" && !settling) void startExtra();
                    }}
                    className="inline-flex min-h-11 items-center justify-center rounded-full border border-accent/60 px-4 text-[14px] text-accent"
                  >
                    One more round
                  </button>
                )}
                {extraState === "none" && <p className="text-[12px] text-text-tertiary">Nothing more today</p>}
                {extraState === "failed" && (
                  <p role="alert" className="text-[12px] text-text-primary">
                    <strong className="font-medium">Couldn&apos;t load:</strong> another round could not be read. Try again.
                  </p>
                )}
                {p.ready > 0 && startButton("daily", `Resume · ${p.ready} left`, false)}
              </>
            ) : shown && p.ready > 0 ? (
              <>
                <p className="font-mono text-[14px] text-text-primary">
                  {p.ready} ready · about {p.minutes} min
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {startButton("daily", "Start", true)}
                  {p.ready > 3 && startButton("quick", "Quick 3", false)}
                  {settling && (
                    <span role="status" className="text-[12px] text-text-secondary">
                      Saving
                    </span>
                  )}
                </div>
                {p.recallChapter !== null && (
                  <p className="text-[13px] text-text-secondary">
                    Ch {p.recallChapter} recall · say what you remember
                  </p>
                )}
              </>
            ) : !shown ? (
              loadFailed ? null : <p className="text-[14px] text-text-tertiary">Loading today&apos;s round</p>
            ) : (
              <p className="text-[14px] text-text-secondary">
                {notice?.kind === "building" && !shown?.cards.length
                  ? `Questions for ch ${notice.chapter} are being built`
                  : `Nothing due${bank?.next_due ? ` · next on ${weekday(bank.next_due)}` : ""}`}
              </p>
            )}
            {notice && !(notice.kind === "building" && !shown?.cards.length) && <NoticeLine notice={notice} onAllow={() => setAllowMore(true)} />}
            {notice?.kind === "paused" && notice.moreCents === null && bank?.cap_cents != null && (
              <p className="text-[12px] text-text-tertiary">Book cap {capDollars(bank.cap_cents)} reached</p>
            )}
            {loadFailed && !shown && (
              <p role="alert" className="text-[12px] text-text-primary">
                <strong className="font-medium">Couldn&apos;t load:</strong> today&apos;s round could not be read.{" "}
                <button type="button" onClick={() => void load()} className="min-h-11 px-1 text-accent">
                  Try again
                </button>
              </p>
            )}
          </div>
        </div>
      )}

      {allowMore && bank && !runner && (
        <div className="mt-3">
          <BankApproval
            slug={slug}
            bank={bank}
            mode="more"
            onDone={() => {
              setAllowMore(false);
              void load();
            }}
            onRecheck={load}
            onCancel={() => setAllowMore(false)}
          />
        </div>
      )}
    </section>
  );
}

function NoticeLine({ notice, onAllow }: { notice: NonNullable<ReturnType<typeof bankNotice>>; onAllow: () => void }) {
  if (notice.kind === "paused") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-[13px] text-text-secondary">
        <span>Paused · budget reached</span>
        {notice.moreCents !== null && (
          <button type="button" onClick={onAllow} className="inline-flex min-h-11 items-center px-1 text-accent">
            Allow {capDollars(notice.moreCents)} more
          </button>
        )}
      </p>
    );
  }
  if (notice.kind === "failed") {
    return (
      <p className="text-[13px] text-text-secondary">
        Building ch {notice.chapter} failed ·{" "}
        <Link href="/status" className="inline-flex min-h-11 items-center text-accent">
          Status
        </Link>
      </p>
    );
  }
  if (notice.kind === "building") return <p className="text-[13px] text-text-secondary">Questions for ch {notice.chapter} are being built</p>;
  return <p className="text-[13px] text-text-secondary">Few sources for ch {notice.chapter}</p>;
}
