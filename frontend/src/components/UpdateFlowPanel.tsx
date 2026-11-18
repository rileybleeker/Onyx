"use client";

import { Check } from "lucide-react";
import type { FlowAction, FlowView } from "@/lib/update-flow";

/** The guided update: a step list with the current step highlighted and, when stuck, one big next action. */
export default function UpdateFlowPanel({ view, onAction }: { view: FlowView; onAction?: (a: FlowAction) => void }) {
  if (!view.active) return null;
  const done = view.step === "done";
  return (
    <section aria-labelledby="update-flow-heading" className="rounded-card bg-surface-card border border-border-subtle shadow-card p-4 space-y-3">
      <h2 id="update-flow-heading" role="status" aria-live="polite" className={`text-base font-medium ${done ? "text-up" : view.failure ? "text-mid" : "text-text-primary"}`}>
        {view.title}
      </h2>
      {view.items.length > 0 && (
        <ol className="space-y-1.5">
          {view.items.map((it) => (
            <li key={it.id} aria-current={it.state === "current" ? "step" : undefined}
              className={`flex items-center gap-2 text-sm ${it.state === "current" ? "text-text-primary font-medium" : it.state === "done" ? "text-up" : "text-text-tertiary"}`}>
              <span aria-hidden="true" className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs ${it.state === "current" ? "border-accent text-accent" : it.state === "done" ? "border-up" : "border-border-subtle"}`}>
                {it.state === "done" ? <Check className="h-3 w-3" /> : ""}
              </span>
              {it.label}
            </li>
          ))}
        </ol>
      )}
      {view.webLine && <p className="text-sm text-text-secondary">{view.webLine}</p>}
      {view.action && (
        <a href={view.action.href} onClick={() => onAction?.(view.action as FlowAction)} className="min-h-12 flex items-center justify-center rounded-full bg-accent px-5 text-base font-medium text-on-accent">
          {view.action.label}
        </a>
      )}
    </section>
  );
}
