"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import InfoHint from "@/components/InfoHint";
import { usePartOrder } from "@/components/personalize/PartGrid";
import { VOICE_MAX_TEXT_CHARS } from "@/lib/checkin-voice";
import { sayItJournalDraft } from "@/lib/journal-file";
import { itemKey, itemSlots, newUuid } from "@/lib/drink-capture";
import { FROM_WHAT_YOU_SAID, reportCheckinFill, setLogDraft, setLogDrafts, useCheckinFill, type DrinkLogDraft, type LogDraftMap } from "@/lib/log-drafts";
import type { DrinkVoiceItem, LogVoiceResult } from "@/lib/log-voice";
import { LOG_PART_IDS, jumpToLogPart, type LogPartId } from "../jump";
import { LogCard } from "./ui";

/**
 * /log "Say it" box (AGENTS.md "Log screen"). Riley types or dictates a few sentences (the keyboard's own
 * microphone) and taps Fill:
 *   - the words go to the embedded Check-in as {checkin: {text}}, which runs its own read-only fill (daytime
 *     answers, last night's sleep) at once, and
 *   - POST /api/log/voice (one model call, read-only) returns drafts for Journal (the words verbatim, when they are
 *     a reflection or start with "journal:"), Supplements, Uber Eats, Weight and Reading.
 * Every draft is marked FROM_WHAT_YOU_SAID in its section and saved there on its own (autosave), except a journal
 * entry the model picked out as a reflection, which waits for Keep. Nothing is sent on page open or on scroll: only
 * the Fill tap starts it.
 *
 * The words and the last result stay in memory only (module variables, so scrolling away and back keeps them;
 * a reload drops them). They are never written to storage and never logged.
 */

/** This box replaces the check-in's own "Say it once" box on /log (./CheckIn.tsx leaves that part out). */
export const REPLACES_CHECKIN_SAY_IT_ONCE = true;

type Shown =
  | { kind: "filled"; result: LogVoiceResult & { unavailable?: string[]; error?: string } }
  | { kind: "error"; message: string };

// Memory only (see above).
let keptText = "";
let keptShown: Shown | null = null;
/** Words went to the check-in (its result is shown under the box until the box is cleared). */
let keptCheckinSent = false;
/**
 * The capture these words are (drinks, lib/drink-capture.ts): made at the Fill tap, BEFORE the request, and kept
 * while the words stay the same, so Fill again on the same words (a retry, a lost answer) gives the same drink keys
 * and the server answers with the drinks already saved. Changed words are a new capture: new keys. Memory only.
 */
interface Capture {
  text: string;
  id: string;
  at: number;
  /**
   * The drinks of the FIRST answer accepted for these words, with their keys, frozen: Fill again on the same words
   * replays exactly these (a model that now reads "two cans" as two items of one can, or resolves what it left
   * unresolved, can never add keys). Riley corrects them in the Drinks section; a new drink is a new capture
   * (changed words, Clear, or a "+ can" tap there). null until an answer was accepted.
   */
  drinks: DrinkLogDraft[] | null;
  drinkLines: string[];
}
let keptCapture: Capture | null = null;

function captureFor(words: string): Capture {
  if (!keptCapture || keptCapture.text !== words) keptCapture = { text: words, id: newUuid(), at: Date.now(), drinks: null, drinkLines: [] };
  return keptCapture;
}

/** The route's drinks with their stable keys (derived from the capture id, never fresh per answer). */
async function drinkDrafts(items: DrinkVoiceItem[], capture: Capture): Promise<DrinkLogDraft[]> {
  const slots = itemSlots(items);
  const keys = await Promise.all(slots.map((s) => itemKey(capture.id, s)));
  return items.map((d, i) => ({ ...d, key: keys[i], captured_at: capture.at }));
}

const SECTION_NAMES: Record<string, string> = { journal: "Journal", supplements: "Supplements", ubereats: "Uber Eats", weight: "Weight", reading: "Reading", drinks: "Drinks" };

export default function SayItSection() {
  const [text, setText] = useState(keptText);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown | null>(keptShown);
  const [checkinSent, setCheckinSent] = useState(keptCheckinSent);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const show = (s: Shown | null) => {
    keptShown = s;
    if (mounted.current) setShown(s);
  };
  const edit = (v: string) => {
    const next = v.slice(0, VOICE_MAX_TEXT_CHARS);
    keptText = next;
    setText(next);
  };

  const fill = async () => {
    const words = text.trim();
    if (!words || busy) return;
    setBusy(true);
    show(null);
    const capture = captureFor(words);
    // The check-in reads the same words with its own questions straight away (in parallel with the call below);
    // its result replaces this "pending" under the box (reportCheckinFill in CheckInClient).
    reportCheckinFill({ pending: true, message: null });
    keptCheckinSent = true;
    setCheckinSent(true);
    setLogDraft("checkin", { text: words }, words);
    try {
      const res = await fetch("/api/log/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: words }),
      });
      const json = (await res.json().catch(() => null)) as (LogVoiceResult & { unavailable?: string[]; failed?: boolean; error?: string }) | null;
      if (!res.ok || !json || json.failed || !Array.isArray(json.supplements) || !Array.isArray(json.ubereats)) {
        const message = !res.ok && json?.error ? `Couldn't read that: ${json.error}` : "Couldn't read that for the journal, supplements, Uber Eats, weight and reading. Try again.";
        // A "journal:" note needs no model: its entry (the words after the prefix, verbatim) is still offered.
        if (!offerPrefixedJournal(words, message)) show({ kind: "error", message });
        return;
      }
      // Only sections the words filled get a draft: an empty answer leaves a section's earlier suggestion alone.
      const drafts: { [S in keyof LogDraftMap]?: LogDraftMap[S] } = {};
      if (json.journal) drafts.journal = json.journal;
      if (json.supplements.length) drafts.supplements = json.supplements;
      if (json.ubereats.length) drafts.ubereats = json.ubereats;
      if (json.weight) drafts.weight = json.weight;
      if (json.reading) drafts.reading = json.reading;
      // Drinks: resolved or not, each is shown in the Drinks section (an unknown one is never dropped). The first
      // accepted interpretation of these words is frozen and replayed on every later Fill of the same words.
      if (capture.drinks == null) {
        capture.drinks = await drinkDrafts(Array.isArray(json.drinks) ? json.drinks : [], capture);
        capture.drinkLines = json.summary?.drinks ?? [];
      }
      if (capture.drinks.length) drafts.drinks = capture.drinks;
      setLogDrafts(drafts, words);
      show({
        kind: "filled",
        result: { ...json, drinks: capture.drinks, summary: { ...json.summary, drinks: capture.drinkLines } },
      });
    } catch {
      const message = "Couldn't reach Onyx. Your words are still here.";
      if (!offerPrefixedJournal(words, message)) show({ kind: "error", message });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  // The fallback above: true when the words start with "journal:" and the Journal section got them as a draft.
  const offerPrefixedJournal = (words: string, error: string): boolean => {
    const journal = sayItJournalDraft(words, null);
    if (!journal) return false;
    setLogDrafts({ journal }, words);
    const n = journal.body.split(/\s+/).length;
    show({
      kind: "filled",
      result: {
        day: "",
        supplements: [],
        ubereats: [],
        weight: null,
        reading: null,
        journal,
        drinks: [],
        summary: { journal: [`Entry, ${n} word${n === 1 ? "" : "s"} of yours`], supplements: [], ubereats: [], weight: [], reading: [], drinks: [] },
        not_matched: [],
        error,
      },
    });
    return true;
  };

  const clear = () => {
    edit("");
    show(null);
    // Cleared on purpose: the same words typed again are a new capture (a deliberate second drink gets new keys).
    keptCapture = null;
    keptCheckinSent = false;
    setCheckinSent(false);
  };

  return (
    <LogCard
      title="Say it"
      action={
        <InfoHint label="Say it">
          Type, or use your keyboard&apos;s microphone. Fill reads it once and suggests answers in the check-in,
          journal, supplements, drinks, Uber Eats, weight and reading below, marked &ldquo;{FROM_WHAT_YOU_SAID}&rdquo;. Start
          with &ldquo;journal:&rdquo; to make the rest a journal entry. Each section saves what it filled on its own
          (Undo or change it there); a journal entry without &ldquo;journal:&rdquo; waits for Keep. The words go to
          Anthropic for that read and are not stored.
        </InfoHint>
      }
    >
      <textarea
        value={text}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void fill();
          }
        }}
        maxLength={VOICE_MAX_TEXT_CHARS}
        rows={3}
        aria-label="Say it"
        placeholder="Took my morning stack at 8, ate half the burrito, weighed 182, read two chapters…"
        className="w-full min-h-24 rounded-control border border-border-subtle bg-transparent p-3 text-[16px] leading-snug text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void fill()}
          disabled={busy || !text.trim()}
          className="min-h-11 px-5 rounded-full text-[14px] font-semibold bg-accent text-on-accent disabled:opacity-40 transition-opacity"
        >
          {busy ? "Filling…" : "Fill"}
        </button>
        {text && !busy ? (
          <button
            type="button"
            onClick={clear}
            className="min-h-11 px-3 rounded-control text-[13px] text-text-secondary hover:text-text-primary transition-colors"
          >
            Clear
          </button>
        ) : null}
        <span className="ml-auto text-[11px] font-mono text-text-tertiary">
          {text.length}/{VOICE_MAX_TEXT_CHARS}
        </span>
      </div>
      <div role="status" aria-live="polite">
        {shown?.kind === "error" ? (
          <>
            {checkinSent ? <ul className="mt-3"><CheckinRow /></ul> : null}
            <p className="mt-3 text-[13px] text-down">{shown.message}</p>
          </>
        ) : null}
        {shown?.kind === "filled" ? <Filled result={shown.result} /> : null}
        {busy && checkinSent ? <ul className="mt-3"><CheckinRow /></ul> : null}
      </div>
    </LogCard>
  );
}

/** The Log screen's parts Riley has not hidden in Personalize. */
function useShownParts(): Set<string> {
  return new Set(usePartOrder("/log", LOG_PART_IDS));
}

const ROW = "grid grid-cols-[96px_1fr_16px] gap-x-3 py-1.5 text-[13px]";

/**
 * One section's line under the box. The whole row is a button that scrolls to the section, where what was filled
 * is saved on its own. A section hidden in Personalize says so (its suggestion stays for when it shows).
 */
function SectionRow({ name, part, lines, tone = "text-text-primary" }: { name: string; part: LogPartId; lines: string[]; tone?: string }) {
  const shown = useShownParts().has(part);
  const body = (
    <>
      <span className="text-text-tertiary">{name}</span>
      <span className={tone}>
        {lines.map((l, i) => (
          <span key={i} className="block">{l}</span>
        ))}
        {!shown ? <span className="block text-mid">Hidden on this screen (Personalize).</span> : null}
      </span>
    </>
  );
  if (!shown) return <li className={ROW}>{body}</li>;
  return (
    <li>
      <button
        type="button"
        onClick={() => jumpToLogPart(part, { smooth: true })}
        aria-label={`${name}: ${lines.join(" ")} Go to ${name}.`}
        className={`${ROW} w-full min-h-11 items-start rounded-control text-left hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent/60`}
      >
        {body}
        <ChevronDown aria-hidden="true" className="mt-0.5 h-4 w-4 text-text-tertiary" />
      </button>
    </li>
  );
}

/** What the embedded check-in did with the words (its own read-only fill), live. */
function CheckinRow() {
  const fill = useCheckinFill();
  const shown = useShownParts().has("check-in");
  if (!shown) {
    return (
      <li className={ROW}>
        <span className="text-text-tertiary">Check-in</span>
        <span className="text-mid">Not filled: the check-in is hidden on this screen (Personalize).</span>
      </li>
    );
  }
  const done = !!fill && !fill.pending && !!fill.message;
  const line = done ? fill!.message! : "Filling the questions below…";
  const tone = done && /couldn't/i.test(line) ? "text-down" : "text-text-primary";
  return <SectionRow name="Check-in" part="check-in" lines={[line]} tone={tone} />;
}

/** What one Fill suggested, per section. */
function Filled({ result }: { result: LogVoiceResult & { unavailable?: string[]; error?: string } }) {
  const { summary } = result;
  const rows: Array<{ name: string; part: LogPartId; lines: string[] }> = [
    { name: "Journal", part: "journal", lines: summary.journal ?? [] },
    { name: "Supplements", part: "supplements", lines: summary.supplements },
    { name: "Drinks", part: "drinks", lines: summary.drinks ?? [] },
    { name: "Uber Eats", part: "uber-eats", lines: summary.ubereats },
    { name: "Weight", part: "weight", lines: summary.weight },
    { name: "Reading", part: "reading", lines: summary.reading },
  ];
  const filled = rows.filter((r) => r.lines.length > 0);
  const empty = rows.filter((r) => r.lines.length === 0).map((r) => r.name);
  const unavailable = (result.unavailable ?? []).map((s) => SECTION_NAMES[s]).filter(Boolean);
  return (
    <div className="mt-3 space-y-2">
      <ul>
        <CheckinRow />
        {filled.map((r) => (
          <SectionRow key={r.name} name={r.name} part={r.part} lines={r.lines} />
        ))}
        {result.not_matched.length > 0 ? (
          <li className={ROW}>
            <span className="text-text-tertiary">Not matched</span>
            <span className="text-mid">{result.not_matched.join(", ")}</span>
          </li>
        ) : null}
      </ul>
      {result.error ? <p className="text-[13px] text-down">{result.error}</p> : null}
      {unavailable.length > 0 ? <p className="text-[12px] text-mid">Couldn&apos;t load {unavailable.join(", ")}; not filled.</p> : null}
      <p className="text-[12px] text-text-secondary">
        {!result.error && empty.length > 0 ? `Nothing for ${empty.map((n) => (n === "Uber Eats" ? n : n.toLowerCase())).join(", ")}. ` : ""}
        Each section saves what it filled on its own. Tap a line to go there and check or undo it.
      </p>
    </div>
  );
}
