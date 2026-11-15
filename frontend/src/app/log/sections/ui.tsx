import type { ReactNode } from "react";

// Shared pieces of the /log sections (AGENTS.md "Log screen"). Hook-free and without "use client", so the server
// loading screen (../loading.tsx) can use the skeletons too; a client section imports them as client code. It must
// not import lib/log-drafts.ts (React hooks): that breaks the server build of loading.tsx.

/** Same text as FROM_WHAT_YOU_SAID in lib/log-drafts.ts. */
const FROM_WHAT_YOU_SAID = "from what you said";

export type LogSkeletonId = "sayit" | "checkin" | "journal" | "supplements" | "ubereats" | "weight" | "reading";

export const LOG_SECTION_TITLES: Record<LogSkeletonId, string> = {
  sayit: "Say it",
  checkin: "Check-in",
  journal: "Journal",
  supplements: "Supplements",
  ubereats: "Uber Eats",
  weight: "Weight",
  reading: "Reading",
};

/** A section's card: heading (h2) with an optional control on the right, then the body. */
export function LogCard({ title, action, children, id }: { title: string; action?: ReactNode; children?: ReactNode; id?: string }) {
  const headingId = id ?? `log-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={headingId} className="rounded-card border border-border-subtle bg-surface-card shadow-card p-4">
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <h2 id={headingId} className="text-[15px] font-medium text-text-primary">{title}</h2>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** The mark next to a value that came from the Say it box (not saved until the section's Save). */
export function DraftMark({ className = "" }: { className?: string }) {
  return <span className={`text-[11px] font-mono text-accent/80 ${className}`}>{FROM_WHAT_YOU_SAID}</span>;
}

/** The section's primary action, same look as the check-in's Save. */
export function LogSaveButton({ onClick, disabled, saving, label = "Save" }: { onClick: () => void; disabled?: boolean; saving?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || saving}
      className="min-h-11 px-5 rounded-full text-[14px] font-semibold bg-accent text-on-accent disabled:opacity-40 transition-opacity"
    >
      {saving ? "Saving…" : label}
    </button>
  );
}

const Bar = ({ className }: { className: string }) => <div className={`skeleton ${className}`} />;

/** Rows of 44 px controls (answer buttons, inputs). */
function ControlRows({ rows, cols = 1 }: { rows: number; cols?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`grid gap-2 ${cols === 5 ? "grid-cols-5" : cols === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
          {Array.from({ length: cols }, (_, j) => <Bar key={j} className="h-11 rounded-control" />)}
        </div>
      ))}
    </div>
  );
}

/**
 * A section's loading state, shaped like the filled section so nothing moves when it arrives. Shown while the
 * section's code loads (LogClient) and while its data loads (each section uses the same id).
 */
export function SectionSkeleton({ section }: { section: LogSkeletonId }) {
  const title = LOG_SECTION_TITLES[section];
  if (section === "checkin") {
    // Same shape as the check-in's own loading state (heading, then question rows).
    return (
      <div className="max-w-xl space-y-3" aria-busy="true">
        <h2 className="text-[15px] font-medium text-text-primary">{title}</h2>
        <p role="status" className="sr-only">Loading {title}</p>
        <div aria-hidden="true" className="space-y-3">
          <Bar className="h-4 w-2/3" />
          {Array.from({ length: 8 }, (_, i) => <Bar key={i} className="h-12 rounded-control" />)}
        </div>
      </div>
    );
  }
  let body: ReactNode;
  switch (section) {
    case "sayit":
      body = (
        <>
          <Bar className="h-24 rounded-control" />
          <div className="mt-2 flex items-center gap-3"><Bar className="h-11 w-32 rounded-control" /><Bar className="h-3 w-16" /></div>
        </>
      );
      break;
    case "journal":
      // Same shape as the section: today's list, the entry box, Captured by, Save.
      body = (
        <>
          <Bar className="h-3 w-12" />
          <Bar className="mt-1 h-11 rounded-control" />
          <Bar className="mt-4 h-3 w-16" />
          <Bar className="mt-1 h-32 rounded-control" />
          <div className="mt-4 flex gap-1.5"><Bar className="h-11 w-20 rounded-control" /><Bar className="h-11 w-20 rounded-control" /></div>
          <Bar className="mt-4 h-11 w-24 rounded-full" />
        </>
      );
      break;
    case "supplements":
      body = (
        <>
          <ControlRows rows={1} cols={2} />
          <div className="mt-3 space-y-2">{Array.from({ length: 3 }, (_, i) => <Bar key={i} className="h-11 rounded-control" />)}</div>
        </>
      );
      break;
    case "ubereats":
      body = (
        <div className="space-y-4">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="space-y-2"><Bar className="h-4 w-1/2" /><ControlRows rows={1} cols={5} /></div>
          ))}
        </div>
      );
      break;
    case "weight":
      body = <div className="flex gap-2"><Bar className="h-11 flex-1 rounded-control" /><Bar className="h-11 w-24 rounded-full" /></div>;
      break;
    case "reading":
      body = (
        <>
          <Bar className="h-4 w-2/3" />
          <div className="mt-3"><ControlRows rows={2} cols={2} /></div>
        </>
      );
      break;
  }
  return (
    <LogCard title={title}>
      <p role="status" className="sr-only">Loading {title}</p>
      <div aria-hidden="true">{body}</div>
    </LogCard>
  );
}
