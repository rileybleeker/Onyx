"use client";

import type { ReactNode, RefObject } from "react";
import { AlertTriangle, Check, Minus, X } from "lucide-react";
import type { CardFormat, Verdict } from "@/lib/reading-recall";
import {
  FORMAT_WORD,
  highlightLabel,
  safeHref,
  TONE_CLASS,
  VERDICT_VIEW,
  type CoveredIdea,
  type PracticeSource,
  type Tone,
} from "@/lib/reading-practice-client";

/**
 * The pieces of a practice card (READ-QUIZ-01 S4), drawn by PracticeRunner.tsx. Presentational only: no request, no
 * timer, no storage. Every model-written or source text is rendered as plain React text (never HTML or Markdown);
 * links open only http(s), in a new tab, with rel="noopener noreferrer nofollow". A verdict is always an icon plus a
 * word, never color alone.
 */

const TONE_ICON: Record<Tone, typeof Check> = { up: Check, mid: Minus, down: X };

/** "Right" / "Partly" / "Not quite" with its icon. */
export function VerdictWord({ verdict, className = "" }: { verdict: Verdict; className?: string }) {
  const v = VERDICT_VIEW[verdict];
  const Icon = TONE_ICON[v.tone];
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${TONE_CLASS[v.tone]} ${className}`}>
      <Icon aria-hidden="true" className="h-4 w-4" />
      <span>{v.word}</span>
    </span>
  );
}

/**
 * "Ch 7 · Recall · Sources 2". The Sources chip opens "Where this comes from" only once the card is answered; then it
 * is a button with a 44 px tap target (the plain chips stay small).
 */
export function CardChips({
  chapter,
  format,
  sourceCount,
  onSources,
}: {
  chapter: number | null;
  format: CardFormat;
  sourceCount: number;
  /** Set once the card is answered (the sources can state the answer). */
  onSources?: () => void;
}) {
  const base = "inline-flex items-center rounded px-2 text-[11px] font-mono text-text-secondary bg-white/[0.04] border border-border-subtle";
  const chip = `${base} min-h-7`;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chapter != null && chapter >= 1 && <span className={chip}>Ch {chapter}</span>}
      {chapter === 0 && <span className={chip}>Whole book</span>}
      <span className={chip}>{FORMAT_WORD[format]}</span>
      {sourceCount > 0 &&
        (onSources ? (
          <button type="button" onClick={onSources} className={`${base} min-h-11 hover:text-text-primary`}>
            Sources <span className="ml-1">{sourceCount}</span>
          </button>
        ) : (
          <span className={chip}>
            Sources <span className="ml-1">{sourceCount}</span>
          </span>
        ))}
    </div>
  );
}

/**
 * Rows for a typed or dictated answer: grows with the text (16 px so iOS never zooms the page). Ctrl/Cmd+Enter
 * checks it (the runner's window key handler).
 */
export const answerRows = (text: string) => Math.max(3, Math.min(10, text.split("\n").length + Math.floor(text.length / 60)));

export function AnswerBox({
  value,
  onChange,
  disabled,
  inputRef,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  label: string;
}) {
  return (
    <textarea
      ref={inputRef}
      aria-label={label}
      value={value}
      readOnly={disabled}
      rows={answerRows(value)}
      onChange={(e) => onChange(e.target.value)}
      autoCapitalize="sentences"
      className="w-full resize-none rounded-control border border-border-subtle bg-white/[0.03] px-3 py-2 text-[16px] leading-snug text-text-primary placeholder:text-text-disabled focus:border-accent focus:outline-none read-only:opacity-80"
      placeholder="Type or dictate your answer"
    />
  );
}

/**
 * Four options (after "Show choices"): 48 px rows, keys 1-4 on a desktop (by place on screen). `order` lists the
 * option indexes in the order they are offered (lib/reading-practice-client.ts choiceOrder: shuffled, so the stored
 * position of the right one is no hint); `picked`, `correct` and onPick use the stored indexes. After Check the right
 * one is marked.
 */
export function ChoiceList({
  options,
  order,
  picked,
  onPick,
  disabled,
  correct,
  answered,
}: {
  options: string[];
  order?: number[];
  picked: number | null;
  onPick: (i: number) => void;
  disabled: boolean;
  correct: number | null;
  answered: boolean;
}) {
  const shown = order && order.length === options.length ? order : options.map((_, i) => i);
  return (
    <div role="radiogroup" aria-label="Choices" className="space-y-2">
      {shown.map((i, place) => {
        const opt = options[i];
        const isPicked = picked === i;
        const isRight = answered && correct === i;
        return (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={isPicked}
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (!disabled) onPick(i);
            }}
            className={`flex min-h-12 w-full items-center gap-3 rounded-control border px-3 py-2 text-left text-[15px] ${
              isPicked ? "border-accent bg-accent/10 text-text-primary" : "border-border-subtle bg-white/[0.02] text-text-primary"
            } ${disabled && !isPicked ? "opacity-70" : ""}`}
          >
            <span aria-hidden="true" className="w-4 shrink-0 font-mono text-[12px] text-text-tertiary">
              {place + 1}
            </span>
            <span className="flex-1">{opt}</span>
            {isRight && (
              <span className="inline-flex items-center gap-1 text-[12px] text-up">
                <Check aria-hidden="true" className="h-4 w-4" />
                Answer
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Put steps in order by tapping chips: a tap on an offered step appends it, a tap on a placed step takes it (and
 * everything after it) back. `offered` lists the step indexes in the order they are shown.
 */
export function OrderPicker({
  steps,
  offered,
  picked,
  onChange,
  disabled,
}: {
  steps: string[];
  offered: number[];
  picked: number[];
  onChange: (next: number[]) => void;
  disabled: boolean;
}) {
  const left = offered.filter((i) => !picked.includes(i));
  return (
    <div className="space-y-3">
      <ol aria-label="Your order" className="space-y-1.5">
        {picked.map((i, n) => (
          <li key={i}>
            <button
              type="button"
              aria-label={`${n + 1}. ${steps[i]}. Tap to take back`}
              aria-disabled={disabled || undefined}
              onClick={() => {
                if (!disabled) onChange(picked.slice(0, n));
              }}
              className="flex min-h-11 w-full items-center gap-3 rounded-control border border-accent/50 bg-accent/10 px-3 py-2 text-left text-[15px] text-text-primary"
            >
              <span className="w-5 shrink-0 font-mono text-[12px] text-accent">{n + 1}</span>
              <span className="flex-1">{steps[i]}</span>
            </button>
          </li>
        ))}
      </ol>
      {left.length > 0 && (
        <div aria-label="Steps to place" className="flex flex-wrap gap-2">
          {left.map((i) => (
            <button
              key={i}
              type="button"
              aria-disabled={disabled || undefined}
              onClick={() => {
                if (!disabled) onChange([...picked, i]);
              }}
              className="min-h-11 rounded-control border border-border-subtle bg-white/[0.03] px-3 py-2 text-left text-[14px] text-text-primary"
            >
              {steps[i]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One source: a site (title links out) with its cited snippet, or Riley's highlight with its passage. */
export function SourcesList({ sources }: { sources: PracticeSource[] }) {
  if (!sources.length) return null;
  return (
    <ul className="space-y-2">
      {sources.map((s, i) => {
        if (s.kind === "highlight") {
          return (
            <li key={`h${s.highlight_id ?? i}`} className="text-[13px]">
              <div className="font-mono text-[11px] text-text-tertiary">{highlightLabel(s)}</div>
              {s.passage && <blockquote className="mt-0.5 border-l-2 border-accent/50 pl-2 text-text-secondary">{s.passage}</blockquote>}
            </li>
          );
        }
        const href = safeHref(s.url);
        return (
          <li key={`w${i}`} className="text-[13px]">
            <div className="font-mono text-[11px] text-text-tertiary">{s.domain ?? "Web source"}</div>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-text-primary underline decoration-border-default underline-offset-2">
                {s.title || href}
              </a>
            ) : (
              s.title && <span className="text-text-primary">{s.title}</span>
            )}
            {s.cited_text && <p className="mt-0.5 text-text-secondary">{s.cited_text}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** "Where this comes from": sources, chapter and the question version. A closed disclosure until opened. */
export function WhereFrom({
  sources,
  chapter,
  version,
  open,
  onToggle,
}: {
  sources: PracticeSource[];
  chapter: number | null;
  version: number | null;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  return (
    <details open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)} className="text-[13px]">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-text-secondary hover:text-text-primary [&::-webkit-details-marker]:hidden">
        Where this comes from
      </summary>
      <div className="space-y-2 pb-1">
        <SourcesList sources={sources} />
        <p className="font-mono text-[11px] text-text-tertiary">
          {chapter != null && chapter >= 1 ? `Ch ${chapter}` : chapter === 0 ? "Whole book" : ""}
          {version != null ? ` · question v${version}` : ""}
        </p>
      </div>
    </details>
  );
}

const HIT_VIEW: Record<"yes" | "partial" | "no", { word: string; tone: Tone }> = {
  yes: { word: "Covered", tone: "up" },
  partial: { word: "Partly", tone: "mid" },
  no: { word: "Missed", tone: "down" },
};

/** The key points of an explain card; once graded, each with its mark (icon + word). */
export function KeyPoints({ points, hits }: { points: { id: string; text: string; must: boolean }[]; hits: { id: string; hit: "yes" | "partial" | "no" }[] | null }) {
  return (
    <ul className="space-y-1.5">
      {points.map((p) => {
        const h = hits?.find((x) => x.id === p.id)?.hit ?? null;
        const view = h ? HIT_VIEW[h] : null;
        const Icon = view ? TONE_ICON[view.tone] : null;
        return (
          <li key={p.id} className="flex items-start gap-2 text-[14px] text-text-primary">
            <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-text-tertiary" />
            <span className="flex-1">
              {p.text}
              {p.must && <span className="ml-1.5 font-mono text-[11px] text-text-tertiary">key</span>}
            </span>
            {view && Icon && (
              <span className={`inline-flex shrink-0 items-center gap-1 text-[12px] ${TONE_CLASS[view.tone]}`}>
                <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                {view.word}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A chapter recall result: what was covered, and each missed idea's statement with where it comes from. */
export function CoveredList({ covered, missed }: { covered: CoveredIdea[]; missed: CoveredIdea[] }) {
  if (!covered.length && !missed.length) return null;
  return (
    <div className="space-y-3" data-testid="recall-covered">
      {covered.length > 0 && (
        <div>
          <h4 className="inline-flex items-center gap-1.5 text-[12px] font-medium text-up">
            <Check aria-hidden="true" className="h-4 w-4" />
            Covered <span className="font-mono">{covered.length}</span>
          </h4>
          <ul className="mt-1 space-y-0.5 text-[13px] text-text-secondary">
            {covered.map((i) => (
              <li key={i.idea_id}>{i.title}</li>
            ))}
          </ul>
        </div>
      )}
      {missed.length > 0 && (
        <div>
          <h4 className="inline-flex items-center gap-1.5 text-[12px] font-medium text-down">
            <X aria-hidden="true" className="h-4 w-4" />
            Missed <span className="font-mono">{missed.length}</span>
          </h4>
          <ul className="mt-1 space-y-2">
            {missed.map((i) => (
              <li key={i.idea_id} className="text-[13px]">
                <div className="text-text-primary">{i.title}</div>
                <p className="text-text-secondary">{i.statement}</p>
                <details className="mt-0.5">
                  <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-[12px] text-text-tertiary [&::-webkit-details-marker]:hidden">
                    Sources <span className="ml-1 font-mono">{i.source_count}</span>
                  </summary>
                  <SourcesList sources={i.sources} />
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A line with an icon and a word (a failure, a refusal): role=alert, never color alone. */
export function AlertLine({ heading, message, children }: { heading: string; message: string; children?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-text-primary">
      <span className="inline-flex items-center gap-1.5">
        <AlertTriangle aria-hidden="true" className="h-4 w-4 text-down" />
        <span>
          <strong className="font-medium">{heading}</strong> {message}
        </span>
      </span>
      {children}
    </div>
  );
}
