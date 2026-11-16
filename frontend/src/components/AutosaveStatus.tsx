"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import type { AutosaveState } from "@/lib/autosave";

/**
 * The one line every autosaving form shows instead of a Save button (lib/autosave.ts): "Saving…", "Saved" (in
 * text-up, the success colour), or what went wrong with a Retry. `incomplete` shows the form's own reason only
 * when `showIncomplete` (a blank field is not worth a message). Nothing at all while idle. `errorLabel` replaces the
 * "Not saved:" in front of an error, for a form that knows the save may have gone through (no clear answer came back).
 */
export function AutosaveStatus({
  state,
  onRetry,
  savedText = "Saved",
  showIncomplete = false,
  errorLabel = "Not saved:",
  className = "",
}: {
  state: AutosaveState;
  onRetry?: () => void;
  savedText?: string;
  showIncomplete?: boolean;
  errorLabel?: string;
  className?: string;
}) {
  const { status, error, retrying } = state;
  let body: ReactNode = null;
  if (status === "waiting" || status === "saving") {
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
          {errorLabel} {error ?? "save failed."}
          {retrying ? " Trying again…" : ""}
        </span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="min-h-11 px-1 text-text-secondary hover:text-text-primary underline underline-offset-2">
            Retry
          </button>
        )}
      </span>
    );
  } else if (status === "incomplete" && showIncomplete && error) {
    body = <span className="text-text-tertiary">{error}</span>;
  }
  return (
    <span role={status === "error" ? "alert" : "status"} aria-live="polite" className={`text-[12px] ${className}`}>
      {body}
    </span>
  );
}
