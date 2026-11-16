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
 * Screen readers (PROD-T01): the result is announced once, from its own polite live region that holds only "Saved"
 * or "Not saved: <why>" (a background retry failing the same way again is not announced again; "Saving…" never is),
 * and Retry sits outside that region. Pressing Retry takes the button away while the save runs, so focus moves to
 * this line (tabIndex -1) instead of falling to the page, and Retry is the next stop if it fails again. `id` lets a
 * field point at the line with aria-describedby, so its reason is read with the field.
 */
/** "Not saved: <why>": the failure text, shown and announced. */
export function failureText(state: Pick<AutosaveState, "error">): string {
  return `Not saved: ${state.error ?? "save failed."}`;
}

/**
 * The live region's next text: the result ("Saved" / the failure), changed only when the result changes, so each
 * result is announced once (a background retry failing the same way again keeps the same text: nothing is read
 * again). Emptied when the form is reset (a new entry), so its first result is announced too.
 */
export function announcement(prev: string, state: Pick<AutosaveState, "status" | "error" | "savedAt">, savedText: string): string {
  if (state.status === "saved") return savedText;
  if (state.status === "error") return failureText(state);
  if (state.status === "idle" && state.savedAt === null) return "";
  return prev;
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

  // The live region's text: changes only when the result does (see announcement()).
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    setAnnounced((prev) => announcement(prev, { status, error, savedAt }, savedText));
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
    <span ref={wrap} id={id} tabIndex={-1} data-autosave={status} className={`text-[12px] ${className}`}>
      {body}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announced}
      </span>
    </span>
  );
}
