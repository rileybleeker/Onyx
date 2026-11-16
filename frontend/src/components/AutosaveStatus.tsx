"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { AutosaveState } from "@/lib/autosave";

/**
 * The one line every autosaving form shows instead of a Save button (lib/autosave.ts). Four states, never confused:
 * "Not saved yet" (an entry waiting for the pause after typing), "Saving…" (the request is out), "Saved" (only once
 * the server answered; in text-up, the success colour, with a check mark) and "Not saved: <why>" with a Retry button
 * (a failure). `incomplete` shows the form's own reason only when `showIncomplete` (a blank field is not worth a
 * message). Nothing at all while idle.
 *
 * Screen readers (PROD-T01): each result is announced once, from its own polite live region that holds only "Saved"
 * or "Not saved: <why>" (every save the server confirms is read, also a second "Saved" in a row; a background retry
 * failing the same way again is not; "Saving…" never is), and Retry sits outside that region. The region is emptied
 * as soon as it holds no current result (a new edit, an incomplete entry, a reset). Pressing Retry takes the button
 * away while the save runs, so focus moves to this line (tabIndex -1) instead of falling to the page, and Retry is
 * the next stop if it fails again. `id` names the visible text only (never the live region), so a field pointing at
 * it with aria-describedby reads the current reason, never an old "Saved".
 */
/** "Not saved: <why>": the failure text, shown and announced. */
export function failureText(state: Pick<AutosaveState, "error">): string {
  return `Not saved: ${state.error ?? "save failed."}`;
}

/**
 * What the live region holds: the current result and a counter that changes with every new result. The text is
 * drawn in a child keyed by the counter, so a new result replaces the text node even when its words are the same
 * as before (two saves in a row are both read).
 */
export type Announcement = { text: string; kind: "" | "saved" | "error"; savedAt: number | null; seq: number };
export const NO_ANNOUNCEMENT: Announcement = { text: "", kind: "", savedAt: null, seq: 0 };

/**
 * The live region after a state change. A confirmed save (a new savedAt, or new words) and a new failure text are
 * new results; the same failure again (a background retry) is not. A retry under way keeps its failure; anything
 * else that is not a result (a new edit waiting, a save of a new edit, an incomplete entry, a reset to idle, also
 * when Autosaver.reset kept savedAt) empties the region.
 */
export function nextAnnouncement(prev: Announcement, state: Pick<AutosaveState, "status" | "error" | "savedAt">, savedText: string): Announcement {
  if (state.status === "saved") {
    if (prev.kind === "saved" && prev.text === savedText && prev.savedAt === state.savedAt) return prev;
    return { text: savedText, kind: "saved", savedAt: state.savedAt, seq: prev.seq + 1 };
  }
  if (state.status === "error") {
    const text = failureText(state);
    if (prev.kind === "error" && prev.text === text) return prev;
    return { text, kind: "error", savedAt: prev.savedAt, seq: prev.seq + 1 };
  }
  if (state.status === "saving" && prev.kind === "error") return prev;
  return prev.kind === "" ? prev : { text: "", kind: "", savedAt: prev.savedAt, seq: prev.seq };
}

export function AutosaveStatus({
  state,
  onRetry,
  savedText = "Saved",
  showIncomplete = false,
  errorLabel = "Not saved:",
  className = "",
  id,
}: {
  state: AutosaveState;
  onRetry?: () => void;
  savedText?: string;
  showIncomplete?: boolean;
  errorLabel?: string;
  className?: string;
  id?: string;
}) {
  const { status, error, retrying, savedAt } = state;
  const wrap = useRef<HTMLSpanElement | null>(null);
  const focusAfterRetry = useRef(false);
  const failure = failureText(state);

  // The live region: changes only when the result does (see nextAnnouncement()).
  const [announced, setAnnounced] = useState<Announcement>(NO_ANNOUNCEMENT);
  useEffect(() => {
    setAnnounced((prev) => nextAnnouncement(prev, { status, error, savedAt }, savedText));
  }, [status, error, savedAt, savedText]);

  // Retry pressed: its button leaves while the save runs; keep keyboard focus on this line, not on the page.
  useEffect(() => {
    if (!focusAfterRetry.current || status === "error") return;
    focusAfterRetry.current = false;
    if (typeof document === "undefined") return;
    const active = document.activeElement as (Element & { isConnected?: boolean }) | null;
    const lost = !active || active === document.body || active.isConnected === false;
    const el = wrap.current;
    if (lost && el && typeof el.focus === "function") el.focus({ preventScroll: true });
  }, [status]);

  const retry = () => {
    if (!onRetry) return;
    if (typeof document !== "undefined") {
      const el = wrap.current;
      focusAfterRetry.current = !!el && typeof el.contains === "function" && el.contains(document.activeElement);
    }
    onRetry();
  };

  let body: ReactNode = null;
  if (status === "waiting") {
    body = <span className="text-text-tertiary">Not saved yet</span>;
  } else if (status === "saving") {
    body = <span className="text-text-tertiary">Saving…</span>;
  } else if (status === "saved") {
    body = (
      <span className="inline-flex items-center gap-1 text-up">
        <Check size={13} aria-hidden="true" />
        {savedText}
      </span>
    );
  } else if (status === "error") {
    body = (
      <span className="inline-flex flex-wrap items-center gap-x-2 text-down">
        <span>
          {failure}
          {retrying ? " Trying again…" : ""}
        </span>
        {onRetry && (
          <button type="button" onClick={retry} className="min-h-11 px-1 text-text-secondary hover:text-text-primary underline underline-offset-2">
            Retry
          </button>
        )}
      </span>
    );
  } else if (status === "incomplete" && showIncomplete && error) {
    body = <span className="text-text-tertiary">{error}</span>;
  }
  return (
    <span ref={wrap} tabIndex={-1} data-autosave={status} className={`text-[12px] ${className}`}>
      <span id={id}>{body}</span>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        <span key={announced.seq}>{announced.text}</span>
      </span>
    </span>
  );
}
