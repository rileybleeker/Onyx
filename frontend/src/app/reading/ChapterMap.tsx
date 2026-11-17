"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, CircleDashed, Lock } from "lucide-react";
import { clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import type { ReadingOverview } from "@/lib/reading";
import { bankUrl, classifyFlagAnswer, FLAG_URL, getJson, getJsonShared, postJson } from "@/lib/reading-practice-client";
import { chapterLabel, mapHeader, mapSignature, parseMap, recallLine, tileState, TILE_WORD, type MapChapter, type MapState, type TileState } from "@/lib/reading-map";
import { AlertLine } from "./PracticeCards";
import ChapterSheet from "./ChapterSheet";

/**
 * The chapter map (READ-QUIZ-01 S5; docs/reading-question-bank.md "Chapter map"): one tile per chapter, a header with
 * what Riley has recalled so far, and a tap on a tile opens the chapter's sheet.
 *
 * - Header: "Recalled 46 of 120 ideas · Kept 9", and the delayed recall, "7-day recall 78% (n 23)" and the 21-day
 *   one, with their n and the visible definition (a statistic, so it is not hidden behind an info button).
 * - Tiles (at least 44 px, 5 per row on a phone, 10 on desktop), each an icon plus a word, never color alone: Locked
 *   (lock), Building / Failed (dashed), Few sources (dashed + word), In progress (the recalled share in 4 steps),
 *   Covered (accent border + check: every core idea explained), Needs review (2 or more lapses in 7 days).
 * - A narrative book's locked chapters show no title. A chapter the spoiler gate keeps locked is not a button: its
 *   sheet would be refused anyway, and nothing about its ideas leaves the server.
 * - A "Not read yet" hold is named under the header with Restore (the hold's own flag; the answers stay).
 *
 * Reads: the bank GET (the same URL the Practice part reads, so the cache is shared; GET only), silently over what the
 * cache showed, again when the overview's bank numbers change. Nothing is written until a tap (Restore, or what the
 * sheet does), inside the continuous scroll too. The page draws this part only while the overview says the bank is on;
 * when the bank's read then answers 404 / 503 (its routes or SQL are not there yet) the part says so in one line
 * instead of leaving an empty frame in Personalize.
 */
export default function ChapterMap({ o, onChanged }: { o: ReadingOverview; onChanged: () => void }) {
  const slug = o.book.slug;
  const bUrl = bankUrl(slug);
  const [map, setMap] = useState<MapState | null>(() => parseMap(clientCache.peek(bUrl)));
  const [status, setStatus] = useState<"loading" | "ok" | "off" | "failed">(() => (map ? "ok" : "loading"));
  const [open, setOpen] = useState<number | null>(null);
  const [hold, setHold] = useState<{ saving: boolean; message: string | null; unsure: boolean }>({ saving: false, message: null, unsure: false });
  const alive = useRef(true);
  // The tile that opened the sheet: focus goes back to it when the sheet closes.
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // `shared`: the read at mount joins the Practice part's own read of the same URL (one request, not two); a read after
  // a Restore or a rebuild is a plain GET, so it never joins an answer from before the write.
  const load = useCallback(async (shared = false) => {
    const r = await (shared ? getJsonShared(bUrl) : getJson(bUrl));
    if (!alive.current) return;
    if (r.status === 200) {
      const parsed = parseMap(r.body);
      if (parsed) {
        clientCache.put(bUrl, r.body);
        setMap((prev) => (sameJson(prev, parsed) ? prev : parsed));
        setStatus("ok");
        return;
      }
    }
    if (r.status === 503 || r.status === 404) {
      clientCache.remove(bUrl);
      setMap(null);
      setStatus("off");
      return;
    }
    // Keep what is on screen when a read fails.
    setStatus((prev) => (prev === "ok" ? prev : "failed"));
  }, [bUrl]);

  // Mount, and whenever the overview's bank numbers move (an answer, a new chapter unlocked, a build finished).
  const signature = mapSignature(o.practice);
  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bUrl, signature]);

  async function restoreHold() {
    if (!map?.holdFlagKey || hold.saving) return;
    setHold({ saving: true, message: null, unsure: false });
    const r = await postJson(FLAG_URL, { flag_key: map.holdFlagKey, restore: true });
    if (!alive.current) return;
    const out = classifyFlagAnswer(r.status, r.body);
    if (out.kind === "saved") {
      setHold({ saving: false, message: null, unsure: false });
      onChanged();
      await load();
      return;
    }
    if (out.kind === "unknown") await load();
    if (!alive.current) return;
    setHold({ saving: false, message: out.message, unsure: out.kind === "unknown" });
  }

  if (!map) {
    if (status === "failed") return <MapFailed onRetry={() => void load()} />;
    return status === "off" ? <MapOff onRetry={() => void load()} /> : <MapSkeleton />;
  }

  const header = mapHeader(map, o.practice);
  const openChapter = open !== null ? map.chapters.find((c) => c.chapter === open) : undefined;

  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" data-testid="reading-chapter-map" aria-label="Chapter map">
      <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Chapters</h3>
      <p className="mt-1.5 font-mono text-[14px] text-text-primary" data-testid="map-recalled">
        Recalled {header.recalled} of {header.ideas} ideas · Kept {header.kept}
      </p>
      <p className="mt-0.5 font-mono text-[13px] text-text-secondary" data-testid="map-recall">
        {recallLine(7, header.recall7)} · {recallLine(21, header.recall21)}
      </p>
      <p className="mt-0.5 text-[11px] text-text-tertiary">Share of answers right when the idea was last answered right at least 7 (21) days earlier.</p>

      {map.holdChapter !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-control border border-border-subtle px-3 py-2 text-[13px] text-text-primary" data-testid="map-hold">
          <AlertTriangle aria-hidden="true" className="h-4 w-4 text-mid" />
          <span className="flex-1">Held at ch {map.holdChapter} · not read yet</span>
          {map.holdFlagKey && (
            <button
              type="button"
              aria-disabled={hold.saving || undefined}
              onClick={() => void restoreHold()}
              className="inline-flex min-h-11 items-center rounded-control border border-border-default px-3 text-[14px] text-text-primary"
            >
              {hold.saving ? "Restoring" : "Restore"}
            </button>
          )}
        </div>
      )}
      {hold.message && <AlertLine heading={hold.unsure ? "Not sure it was restored:" : "Not restored:"} message={hold.message} />}

      <ul aria-label="Chapters" className="mt-3 grid grid-cols-5 gap-2 md:grid-cols-10">
        {map.chapters.map((c) => (
          <li key={c.chapter}>
            <Tile
              c={c}
              narrative={map.narrative}
              active={open === c.chapter}
              onOpen={(el) => {
                opener.current = el;
                setOpen(c.chapter);
              }}
            />
          </li>
        ))}
      </ul>
      {map.chapters.length === 0 && <p className="mt-3 text-[13px] text-text-tertiary">No chapters yet.</p>}

      {open !== null && openChapter && !openChapter.locked && (
        <ChapterSheet
          key={open}
          slug={slug}
          chapter={open}
          title={openChapter.title}
          perChapterCents={map.perChapterCents}
          onClose={(changed) => {
            setOpen(null);
            if (changed) void load();
            // Back to the tile that opened the sheet (once it is out of the way).
            const el = opener.current;
            opener.current = null;
            if (el && typeof el.focus === "function") setTimeout(() => el.focus(), 0);
          }}
          onChanged={() => {
            onChanged();
            void load();
          }}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

const TILE_BASE = "relative flex min-h-[56px] w-full flex-col items-center justify-center gap-0.5 rounded-control border px-1 py-1.5 text-center";

function stateClasses(st: TileState): string {
  switch (st.kind) {
    case "locked":
      return "border-border-subtle text-text-tertiary";
    case "building":
      return "border-dashed border-border-default text-text-secondary";
    case "few":
      return "border-dashed border-border-default text-text-secondary";
    case "covered":
      return "border-accent text-text-primary";
    case "review":
      return "border-mid/60 text-mid";
    default:
      return "border-border-default text-text-primary";
  }
}

function StateIcon({ st }: { st: TileState }) {
  const cls = "h-3 w-3 shrink-0";
  if (st.kind === "locked") return <Lock aria-hidden="true" className={cls} />;
  if (st.kind === "building" || st.kind === "few") return <CircleDashed aria-hidden="true" className={cls} />;
  if (st.kind === "covered") return <Check aria-hidden="true" className={`${cls} text-accent`} />;
  if (st.kind === "review") return <AlertTriangle aria-hidden="true" className={cls} />;
  return null;
}

/** The word under a chapter number: the state's word, "Failed" for a build that failed, the recalled count in progress. */
function stateWord(st: TileState): string {
  if (st.kind === "building") return st.failed ? "Failed" : TILE_WORD.building;
  if (st.kind === "progress") return `${st.recalled}/${st.ideas}`;
  if (st.kind === "review") return "Review";
  return TILE_WORD[st.kind];
}

function stateName(st: TileState): string {
  if (st.kind === "progress") return `in progress, ${st.recalled} of ${st.ideas} ideas recalled`;
  if (st.kind === "building") return st.failed ? "build failed" : "being built";
  return TILE_WORD[st.kind].toLowerCase();
}

function Tile({ c, narrative, active, onOpen }: { c: MapChapter; narrative: boolean; active: boolean; onOpen: (el: HTMLElement) => void }) {
  const st = tileState(c);
  const label = chapterLabel(c, narrative);
  const body = (
    <>
      <span className="font-mono text-[13px] leading-none">{c.chapter}</span>
      <span className="flex max-w-full items-center justify-center gap-0.5 font-mono text-[10px] leading-tight">
        <StateIcon st={st} />
        <span className="break-words">{stateWord(st)}</span>
      </span>
      {st.kind === "progress" && (
        <span aria-hidden="true" className="mt-0.5 flex w-full gap-0.5 px-1">
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={`h-1 flex-1 rounded-full ${n <= st.step ? "bg-accent" : "bg-white/[0.08]"}`} />
          ))}
        </span>
      )}
    </>
  );
  const cls = `${TILE_BASE} ${stateClasses(st)}`;
  // A locked chapter cannot be opened (its sheet is refused by the server), so it is not a button.
  if (st.kind === "locked") {
    return (
      <div role="img" aria-label={`${label}, locked`} title={label} data-state="locked" className={cls}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={`${label}, ${stateName(st)}`}
      aria-haspopup="dialog"
      aria-expanded={active}
      title={label}
      data-state={st.kind}
      onClick={(e) => onOpen(e.currentTarget)}
      className={`${cls} hover:bg-white/[0.05]`}
    >
      {body}
    </button>
  );
}

function MapSkeleton() {
  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" aria-busy="true" aria-label="Chapter map">
      <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Chapters</h3>
      <div className="mt-3 h-24 rounded-control bg-white/[0.03]" />
    </section>
  );
}

/** The bank's routes or SQL are not there (404 / 503): one line, so the part is never an empty frame. */
function MapOff({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" aria-label="Chapter map" data-testid="map-off">
      <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Chapters</h3>
      <p className="mt-2 text-[13px] text-text-secondary">
        The chapter map is not available yet.{" "}
        <button type="button" onClick={onRetry} className="min-h-11 px-1 text-accent">
          Check again
        </button>
      </p>
    </section>
  );
}

function MapFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" aria-label="Chapter map">
      <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Chapters</h3>
      <p role="alert" className="mt-2 text-[13px] text-text-primary">
        <strong className="font-medium">Couldn&apos;t load:</strong> the chapter map could not be read.{" "}
        <button type="button" onClick={onRetry} className="min-h-11 px-1 text-accent">
          Try again
        </button>
      </p>
    </section>
  );
}
