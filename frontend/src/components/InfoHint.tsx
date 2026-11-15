"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Info } from "lucide-react";

/**
 * Context that is useful but not needed every day: how a number is worked out, why it can be
 * stale, where the data comes from. Screens show headings, numbers and labels; this holds the
 * rest, closed by default (AGENTS.md, Conventions, "UI copy").
 *
 * - variant "popover" (default): a small "i" button that opens a floating note. The visible dot
 *   is 18 px; its hit area is 44 px (an absolutely positioned ::before) so it is a full touch
 *   target without moving the layout. Escape, a tap outside, or tabbing away closes it; focus
 *   moves into the note on open and back to the button on Escape.
 * - variant "disclosure": a full-width "About this" row that expands in place (native
 *   <details>), for longer notes at the foot of a card or page.
 *
 * Keep the button OUTSIDE heading elements: its accessible name ("About …") would otherwise
 * become part of the heading's name, which tests match.
 */
interface InfoHintProps {
  /** What the note is about. The button is announced as "About <label>". */
  label: string;
  children: ReactNode;
  variant?: "popover" | "disclosure";
  /** Disclosure row text. Default "About this". */
  summary?: string;
  className?: string;
}

const GAP = 8;
const MAX_WIDTH = 320;

export default function InfoHint({ label, children, variant = "popover", summary = "About this", className }: InfoHintProps) {
  if (variant === "disclosure") {
    return (
      <details className={clsx("group text-[12px] text-text-tertiary", className)}>
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-control pr-2 hover:text-text-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
          <Info aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span>{summary}</span>
          <span aria-hidden className="text-text-disabled transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="mb-2 space-y-2 leading-relaxed text-text-secondary">{children}</div>
      </details>
    );
  }
  return <InfoPopover label={label} className={className}>{children}</InfoPopover>;
}

function InfoPopover({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) buttonRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(MAX_WIDTH, vw - GAP * 2);
    const left = Math.min(Math.max(r.left + r.width / 2 - width / 2, GAP), vw - width - GAP);
    const height = noteRef.current?.offsetHeight ?? 0;
    const below = r.bottom + GAP;
    const top = below + height > vh - GAP && r.top - GAP - height >= GAP ? r.top - GAP - height : below;
    setPos({ top, left, width });
  }, []);

  // Measure once the note is in the DOM (its height decides above / below), then move focus in.
  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);
  useEffect(() => {
    if (open && pos) noteRef.current?.focus({ preventScroll: true });
    // Focus only when the note first gets a position, not on every reposition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pos !== null]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (noteRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    const onMove = () => place();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close, place]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        className={clsx(
          "relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors",
          "before:absolute before:-inset-[13px] before:content-['']",
          "hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent",
          open && "text-accent",
          className,
        )}
      >
        <Info aria-hidden className="h-3.5 w-3.5" />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={noteRef}
            id={id}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={(e) => {
              // The note is portaled to the end of <body>, so Tab past its last link (or Shift+Tab
              // past its start) would jump far away: close it and return to the button instead.
              if (e.key !== "Tab") return;
              const items = Array.from(
                noteRef.current?.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? [],
              );
              const active = document.activeElement;
              const leaving = e.shiftKey
                ? active === noteRef.current || active === items[0]
                : items.length === 0 || active === items[items.length - 1];
              if (leaving) {
                e.preventDefault();
                close(true);
              }
            }}
            onBlur={(e) => {
              const next = e.relatedTarget as Node | null;
              if (next && (noteRef.current?.contains(next) || buttonRef.current?.contains(next))) return;
              if (next) close(false);
            }}
            style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { top: 0, left: 0, width: MAX_WIDTH, visibility: "hidden" }}
            className="fixed z-[70] space-y-2 rounded-card border border-border-default bg-surface-raised p-3 text-left text-[12px] font-normal normal-case leading-relaxed tracking-normal text-text-secondary shadow-floating focus:outline-none"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
