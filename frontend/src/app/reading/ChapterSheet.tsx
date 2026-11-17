"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { X } from "lucide-react";
import {
  classifyFlagAnswer,
  FLAG_LABEL,
  FLAG_URL,
  getJson,
  parseRound,
  postJson,
  type FlagKind,
  type PracticeRound,
} from "@/lib/reading-practice-client";
import {
  BANK_RUN_URL,
  builtDate,
  chapterRoundUrl,
  classifyRunAnswer,
  dollars,
  parseSheet,
  sheetRecalled,
  sheetUrl,
  stageWord,
  type SheetIdea,
  type SheetState,
} from "@/lib/reading-map";
import { AlertLine } from "./PracticeCards";

const PracticeRunner = dynamic(() => import("./PracticeRunner"), { ssr: false, loading: () => <div className="h-[320px]" aria-hidden="true" /> });

/**
 * One chapter's sheet (READ-QUIZ-01 S5; docs/reading-question-bank.md "Chapter map"): a bottom sheet on the phone, a
 * side panel on desktop, drawn in document.body so it is never inside the page's own stacking context. It shows the
 * chapter's title, how many of its ideas are recalled, Practice 5, the ideas with their stage (an idea's statement
 * shows only once it was asked, so the sheet never answers a question before it is asked), source counts, the
 * questions Riley flagged with Restore, when the chapter was built and with which prompt version, and Rebuild chapter
 * (with a confirm that shows its cost). It reads one GET (/api/reading/bank/chapter/N, 404 while the chapter is
 * locked) and writes only on a tap: Restore (POST /api/reading/practice/flag {flag_key, restore}), Rebuild (POST
 * /api/reading/bank/run), and the answers of Practice 5, which run in the same runner as the daily round ("chapter"
 * mode, in place on desktop and as the runner's own full-screen sheet on a phone).
 *
 * Dialog behavior: role=dialog + aria-modal, focus moves to the heading on open and is kept inside while it is open,
 * Esc closes it (the runner takes its own Esc while Practice 5 is running), and focus returns to the tile that opened
 * it. Every control is a 44 px target; every state is a word plus an icon, never color alone.
 */

const PHONE_QUERY = "(max-width: 767px)";
const phoneQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
const PHONE_PANEL = "fixed inset-x-0 bottom-0 z-50 flex max-h-[88vh] flex-col overflow-y-auto rounded-t-card border-t border-border-default bg-surface-card pb-[env(safe-area-inset-bottom)] shadow-card";
const DESKTOP_PANEL = "fixed right-0 top-0 z-50 flex h-full w-[420px] max-w-full flex-col overflow-y-auto border-l border-border-default bg-surface-card shadow-card";
const PRIMARY = "inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 text-[15px] font-medium text-on-accent";
const SECONDARY = "inline-flex min-h-11 items-center justify-center rounded-control border border-border-default px-3 text-[14px] text-text-primary";
const IMPORTANCE_WORD = { core: "Core", supporting: "Supporting", detail: "Detail" } as const;

export interface ChapterSheetProps {
  slug: string;
  chapter: number;
  /** The map's title for the chapter (null for a narrative book's chapter): shown while the sheet loads. */
  title: string | null;
  /** What rebuilding one chapter is expected to cost, when the bank GET reports it. */
  perChapterCents: number | null;
  /** Close the sheet (focus goes back to the tile). `changed`: something was stored or flagged. */
  onClose: (changed: boolean) => void;
  /** Re-read the map and the overview (an answer, a Restore, a rebuild changed something). */
  onChanged: () => void;
}

function StageDots({ stage }: { stage: number }) {
  return (
    <span role="img" aria-label={`Stage: ${stageWord(stage)}`} title={stageWord(stage)} className="flex shrink-0 items-center gap-0.5">
      {[1, 2, 3, 4].map((n) => (
        <span key={n} aria-hidden="true" className={`h-2 w-2 rounded-full ${n <= stage ? "bg-accent" : "border border-border-default"}`} />
      ))}
    </span>
  );
}

function IdeaRow({ idea }: { idea: SheetIdea }) {
  return (
    <li className="rounded-control border border-border-subtle px-3 py-2" data-testid="sheet-idea">
      <div className="flex items-center gap-2">
        <StageDots stage={idea.stage} />
        <span className="min-w-0 flex-1 text-[14px] text-text-primary">{idea.title}</span>
        <span className="shrink-0 font-mono text-[11px] text-text-tertiary">{IMPORTANCE_WORD[idea.importance]}</span>
      </div>
      {idea.statement && <p className="mt-1 text-[13px] text-text-secondary">{idea.statement}</p>}
      <p className="mt-1 font-mono text-[11px] text-text-tertiary">
        {stageWord(idea.stage)} · Sources {idea.sources}
      </p>
    </li>
  );
}

export default function ChapterSheet({ slug, chapter, title, perChapterCents, onClose, onChanged }: ChapterSheetProps) {
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [load, setLoad] = useState<"loading" | "ok" | "gone" | "failed">("loading");
  const [practice, setPractice] = useState<PracticeRound | null>(null);
  const [practiceState, setPracticeState] = useState<"idle" | "loading" | "none" | "failed">("idle");
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [rebuild, setRebuild] = useState<{ saving: boolean; ok: boolean; message: string | null }>({ saving: false, ok: false, message: null });
  const [phone, setPhone] = useState(() => phoneQuery()?.matches === true);
  const alive = useRef(true);
  const changed = useRef(false);
  // Practice 5's own close guard (the runner fills it), and whether the sheet is closing behind it.
  const runnerClose = useRef<((after?: () => void) => void) | null>(null);
  const leaving = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const read = useCallback(async () => {
    const r = await getJson(sheetUrl(slug, chapter));
    if (!alive.current) return;
    if (r.status === 200) {
      const parsed = parseSheet(r.body);
      if (parsed) {
        setSheet(parsed);
        setLoad("ok");
        return;
      }
    }
    // 404: locked (a "Not read yet" hold, or the book moved); 503: the bank's SQL is gone.
    if (r.status === 404 || r.status === 503) {
      setSheet(null);
      setLoad("gone");
      return;
    }
    setLoad((prev) => (prev === "ok" ? prev : "failed"));
  }, [slug, chapter]);

  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [read]);

  // Focus the heading when the sheet opens, once its heading is there.
  useEffect(() => {
    headingRef.current?.focus?.();
  }, []);

  // Phone or desktop, live (a phone turned to landscape gets the side panel).
  useEffect(() => {
    const mq = phoneQuery();
    if (!mq) return;
    const update = () => setPhone(mq.matches);
    update();
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", update);
    else mq.addListener?.(update);
    return () => {
      if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", update);
      else mq.removeListener?.(update);
    };
  }, []);

  // The x and the backdrop. While Practice 5 runs they go through the runner's own guard first: with a typed answer not
  // checked yet it asks "Leave without checking?", and the sheet closes behind the runner once it really closes.
  const close = () => {
    if (practice && runnerClose.current) {
      runnerClose.current(() => {
        leaving.current = true;
      });
      return;
    }
    onClose(changed.current);
  };

  // Esc closes the sheet (the runner takes its own Esc while Practice 5 is running); Tab stays inside.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      if (practice) return;
      if (e.isComposing === true || e.keyCode === 229) return;
      e.preventDefault?.();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const root = rootRef.current;
    if (!root || typeof root.querySelectorAll !== "function") return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not([aria-disabled="true"]), a[href], [tabindex]:not([tabindex="-1"]), textarea, input, select')).filter((el) => !el.hasAttribute("disabled"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (e.shiftKey && (active === first || active === root || active === headingRef.current)) {
      e.preventDefault?.();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault?.();
      first.focus();
    }
  };
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const h = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  async function startPractice() {
    if (practiceState === "loading") return;
    setPracticeState("loading");
    const r = await getJson(chapterRoundUrl(slug, chapter));
    if (!alive.current) return;
    const round = r.status === 200 ? parseRound(r.body) : null;
    if (!round) {
      setPracticeState("failed");
      return;
    }
    if (!round.cards.some((c) => !c.done)) {
      setPracticeState("none");
      return;
    }
    setPracticeState("idle");
    setPractice(round);
  }

  async function restore(flagKey: string) {
    if (restoring) return;
    setRestoring(flagKey);
    setRestoreMessage(null);
    const r = await postJson(FLAG_URL, { flag_key: flagKey, restore: true });
    if (!alive.current) return;
    const out = classifyFlagAnswer(r.status, r.body);
    setRestoring(null);
    if (out.kind === "saved") {
      changed.current = true;
      onChanged();
      await read();
      return;
    }
    // An unknown outcome may have been stored: read the sheet again and say so.
    if (out.kind === "unknown") await read();
    setRestoreMessage(out.kind === "unknown" ? `Not sure it was restored: ${out.message}` : `Not restored: ${out.message}`);
  }

  async function rebuildChapter() {
    if (rebuild.saving) return;
    setRebuild({ saving: true, ok: false, message: null });
    const r = await postJson(BANK_RUN_URL, { book: slug, chapter, rebuild: true });
    if (!alive.current) return;
    const out = classifyRunAnswer(r.status, r.body);
    setRebuild({ saving: false, ok: out.ok, message: out.message });
    setConfirm(false);
    if (out.ok) {
      changed.current = true;
      onChanged();
    }
  }

  const recalled = sheet ? sheetRecalled(sheet) : null;
  const heading = `Ch ${chapter}${(sheet?.title ?? title) ? ` · ${sheet?.title ?? title}` : ""}`;
  const built = sheet ? builtDate(sheet.builtAt) : null;
  const canPractice = !!sheet && sheet.ideas.length > 0;

  const view = (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Chapter ${chapter}`}
      data-testid="chapter-sheet"
      data-layout={phone ? "sheet" : "panel"}
      className={phone ? PHONE_PANEL : DESKTOP_PANEL}
    >
      <div className="flex shrink-0 items-start gap-3 px-4 pb-2 pt-3">
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 text-[17px] font-medium text-text-primary outline-none" data-testid="sheet-heading">
          {heading}
        </h2>
        <button type="button" aria-label="Close chapter" onClick={close} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-text-secondary hover:text-text-primary">
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>

      <div className="space-y-4 px-4 pb-5">
        {load === "loading" && <p className="text-[14px] text-text-tertiary">Loading chapter</p>}
        {load === "failed" && (
          <p role="alert" className="text-[13px] text-text-primary">
            <strong className="font-medium">Couldn&apos;t load:</strong> this chapter could not be read.{" "}
            <button type="button" onClick={() => void read()} className="min-h-11 px-1 text-accent">
              Try again
            </button>
          </p>
        )}
        {load === "gone" && <p className="text-[14px] text-text-secondary">This chapter is locked. Keep reading to open it.</p>}

        {sheet && recalled && practice === null && (
          <>
            <div>
              <p className="font-mono text-[14px] text-text-primary" data-testid="sheet-recalled">
                Recalled {recalled.recalled} of {recalled.ideas} ideas
              </p>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
                <div className="h-full bg-accent" style={{ width: `${recalled.ideas ? (100 * recalled.recalled) / recalled.ideas : 0}%` }} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-disabled={!canPractice || practiceState === "loading" || undefined}
                onClick={() => {
                  if (canPractice) void startPractice();
                }}
                className={`${PRIMARY} ${canPractice ? "" : "opacity-40"}`}
              >
                Practice 5
              </button>
              {practiceState === "loading" && (
                <span role="status" className="text-[12px] text-text-secondary">
                  Loading
                </span>
              )}
              {practiceState === "none" && <span className="text-[13px] text-text-tertiary">Nothing to practise here yet</span>}
            </div>
            {practiceState === "failed" && <AlertLine heading="Couldn't load:" message="The chapter round could not be read. Try again." />}

            {sheet.ideas.length === 0 ? (
              <p className="text-[14px] text-text-secondary">{sheet.status === "pending" ? "Questions for this chapter are being built." : "No ideas in this chapter yet."}</p>
            ) : (
              <ul aria-label="Ideas in this chapter" className="space-y-2">
                {sheet.ideas.map((i) => (
                  <IdeaRow key={i.ideaId} idea={i} />
                ))}
              </ul>
            )}

            {sheet.flags.length > 0 && (
              <section aria-label="Flagged questions" className="space-y-2">
                <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Flagged</h3>
                <ul className="space-y-2">
                  {sheet.flags.map((f) => (
                    <li key={f.flagKey} className="flex items-start gap-2 rounded-control border border-border-subtle px-3 py-2" data-testid="sheet-flag">
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-[11px] text-text-tertiary">{FLAG_LABEL[f.kind as FlagKind]}</p>
                        <p className="text-[13px] text-text-primary">{f.prompt}</p>
                      </div>
                      <button
                        type="button"
                        aria-disabled={restoring !== null || undefined}
                        onClick={() => {
                          if (restoring === null) void restore(f.flagKey);
                        }}
                        className={SECONDARY}
                      >
                        {restoring === f.flagKey ? "Restoring" : "Restore"}
                      </button>
                    </li>
                  ))}
                </ul>
                {restoreMessage && <AlertLine heading="Flag:" message={restoreMessage} />}
              </section>
            )}

            <div className="space-y-2 border-t border-border-subtle pt-3">
              <p className="font-mono text-[11px] text-text-tertiary" data-testid="sheet-built">
                {built ? `Built ${built}` : "Not built yet"}
                {sheet.promptVersion ? ` · prompt ${sheet.promptVersion}` : ""}
                {sheet.rebuilds > 0 ? ` · rebuilt ${sheet.rebuilds}×` : ""}
              </p>
              {confirm ? (
                <div role="group" aria-label="Rebuild chapter" className="space-y-2 rounded-control border border-border-subtle p-3 text-[13px] text-text-primary">
                  <p>
                    Rebuild chapter {chapter}? {perChapterCents !== null ? <span className="font-mono">About {dollars(perChapterCents)}</span> : "It uses part of this book's spending cap"}. The chapter&apos;s ideas and questions are replaced and start again at New; earlier chapter-recall answers for it stop counting.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      aria-disabled={rebuild.saving || undefined}
                      onClick={() => {
                        if (!rebuild.saving) void rebuildChapter();
                      }}
                      className={PRIMARY}
                    >
                      Rebuild
                    </button>
                    <button type="button" onClick={() => setConfirm(false)} className={SECONDARY}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirm(true)} className={SECONDARY}>
                  Rebuild chapter
                </button>
              )}
              {rebuild.message &&
                (rebuild.ok ? (
                  <p role="status" className="text-[13px] text-text-secondary">
                    {rebuild.message}
                  </p>
                ) : (
                  <AlertLine heading="Not rebuilt:" message={rebuild.message} />
                ))}
            </div>
          </>
        )}

        {practice && (
          <PracticeRunner
            key={practice.round_key}
            round={practice}
            mode="chapter"
            closeRef={runnerClose}
            onClose={(didChange, _finished, settled) => {
              setPractice(null);
              if (didChange) changed.current = true;
              // The sheet's own x or backdrop asked: the sheet closes too, once the answers on their way have landed.
              const leaveSheet = leaving.current;
              leaving.current = false;
              void Promise.resolve(settled).then(() => {
                if (!alive.current) return;
                if (leaveSheet) {
                  // onChanged re-reads the map and the overview itself; a plain close re-reads the map only when something changed.
                  if (didChange) onChanged();
                  onClose(changed.current && !didChange);
                  return;
                }
                if (didChange) onChanged();
                void read();
              });
            }}
            onReread={async () => {
              const r = await getJson(chapterRoundUrl(slug, chapter));
              return r.status === 200 ? parseRound(r.body) : null;
            }}
          />
        )}
      </div>
    </div>
  );

  const backdrop = <div aria-hidden="true" data-testid="sheet-backdrop" onClick={close} className="fixed inset-0 z-40 bg-black/50" />;
  const both = (
    <>
      {backdrop}
      {view}
    </>
  );
  const portalTo = typeof document !== "undefined" && document.body?.nodeType === 1 ? document.body : null;
  return portalTo ? createPortal(both, portalTo) : both;
}
