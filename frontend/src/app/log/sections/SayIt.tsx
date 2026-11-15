"use client";

import { useEffect, useRef, useState } from "react";
import InfoHint from "@/components/InfoHint";
import { VOICE_MAX_TEXT_CHARS } from "@/lib/checkin-voice";
import { FROM_WHAT_YOU_SAID, setLogDraft, setLogDrafts, type LogDraftMap } from "@/lib/log-drafts";
import type { LogVoiceResult } from "@/lib/log-voice";
import { LogCard } from "./ui";

/**
 * /log "Say it" box (AGENTS.md "Log screen"). Riley types or dictates a few sentences (the keyboard's own
 * microphone) and taps Fill:
 *   - the words go to the embedded Check-in as {checkin: {text}}, which runs its own read-only fill (daytime
 *     answers, last night's sleep, a journal draft of the words) at once, and
 *   - POST /api/log/voice (one model call, read-only) returns drafts for Supplements, Uber Eats, Weight and Reading.
 * Every draft is a suggestion marked FROM_WHAT_YOU_SAID in its section; nothing is stored until Riley taps that
 * section's own Save. Nothing is sent on page open or on scroll: only the Fill tap sends.
 *
 * The words and the last result stay in memory only (module variables, so scrolling away and back keeps them;
 * a reload drops them). They are never written to storage and never logged.
 */

/** This box replaces the check-in's own "Say it once" box on /log (./CheckIn.tsx leaves that part out). */
export const REPLACES_CHECKIN_SAY_IT_ONCE = true;

type Shown =
  | { kind: "filled"; result: LogVoiceResult & { unavailable?: string[] } }
  | { kind: "error"; message: string };

// Memory only (see above).
let keptText = "";
let keptShown: Shown | null = null;

const SECTION_NAMES: Record<string, string> = { supplements: "Supplements", ubereats: "Uber Eats", weight: "Weight", reading: "Reading" };

export default function SayItSection() {
  const [text, setText] = useState(keptText);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown | null>(keptShown);
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
    // The check-in reads the same words with its own questions straight away (in parallel with the call below).
    setLogDraft("checkin", { text: words }, words);
    try {
      const res = await fetch("/api/log/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: words }),
      });
      const json = (await res.json().catch(() => null)) as (LogVoiceResult & { unavailable?: string[]; failed?: boolean; error?: string }) | null;
      if (!res.ok || !json || json.failed || !Array.isArray(json.supplements) || !Array.isArray(json.ubereats)) {
        show({ kind: "error", message: !res.ok && json?.error ? `Couldn't read that: ${json.error}` : "Couldn't read that for supplements, Uber Eats, weight and reading. Try again." });
        return;
      }
      // Only sections the words filled get a draft: an empty answer leaves a section's earlier suggestion alone.
      const drafts: { [S in keyof LogDraftMap]?: LogDraftMap[S] } = {};
      if (json.supplements.length) drafts.supplements = json.supplements;
      if (json.ubereats.length) drafts.ubereats = json.ubereats;
      if (json.weight) drafts.weight = json.weight;
      if (json.reading) drafts.reading = json.reading;
      setLogDrafts(drafts, words);
      show({ kind: "filled", result: json });
    } catch {
      show({ kind: "error", message: "Couldn't reach Onyx. Your words are still here." });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const clear = () => {
    edit("");
    show(null);
  };

  return (
    <LogCard
      title="Say it"
      action={
        <InfoHint label="Say it">
          Type, or use your keyboard&apos;s microphone. Fill reads it once and suggests answers in the check-in,
          supplements, Uber Eats, weight and reading below, marked &ldquo;{FROM_WHAT_YOU_SAID}&rdquo;. Nothing is saved
          until you press each section&apos;s Save. The words go to Anthropic for that one read and are not stored.
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
        className="w-full min-h-24 rounded-control border border-border-subtle bg-transparent p-3 text-[16px] leading-snug text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40"
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
        {shown?.kind === "error" ? <p className="mt-3 text-[13px] text-down">{shown.message}</p> : null}
        {shown?.kind === "filled" ? <Filled result={shown.result} /> : null}
      </div>
    </LogCard>
  );
}

/** What one Fill suggested, per section. */
function Filled({ result }: { result: LogVoiceResult & { unavailable?: string[] } }) {
  const { summary } = result;
  const rows: Array<{ name: string; lines: string[] }> = [
    { name: "Check-in", lines: ["Filling the questions below"] },
    { name: "Supplements", lines: summary.supplements },
    { name: "Uber Eats", lines: summary.ubereats },
    { name: "Weight", lines: summary.weight },
    { name: "Reading", lines: summary.reading },
  ];
  const filled = rows.filter((r) => r.lines.length > 0);
  const empty = rows.filter((r) => r.lines.length === 0).map((r) => r.name);
  const unavailable = (result.unavailable ?? []).map((s) => SECTION_NAMES[s]).filter(Boolean);
  return (
    <div className="mt-3 space-y-2">
      <dl className="space-y-1.5">
        {filled.map((r) => (
          <div key={r.name} className="grid grid-cols-[96px_1fr] gap-x-3 text-[13px]">
            <dt className="text-text-tertiary">{r.name}</dt>
            <dd className="text-text-primary">
              {r.lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </dd>
          </div>
        ))}
        {result.not_matched.length > 0 ? (
          <div className="grid grid-cols-[96px_1fr] gap-x-3 text-[13px]">
            <dt className="text-text-tertiary">Not matched</dt>
            <dd className="text-mid">{result.not_matched.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      {unavailable.length > 0 ? <p className="text-[12px] text-mid">Couldn&apos;t load {unavailable.join(", ")}; not filled.</p> : null}
      <p className="text-[12px] text-text-secondary">
        {empty.length > 0 ? `Nothing for ${empty.map((n) => (n === "Uber Eats" ? n : n.toLowerCase())).join(", ")}. ` : ""}
        Check each section, then press its Save.
      </p>
    </div>
  );
}
