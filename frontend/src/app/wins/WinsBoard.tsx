"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CircleCheck, Info, Sparkles } from "lucide-react";
import StatCard from "@/components/StatCard";
import { groupByStage, labels, stageNotes, type Board, type Win, type WinState } from "@/lib/wins";

const filters = ["All", "Delivered", "In progress"] as const;
const inFilter = (filter: (typeof filters)[number], state: WinState) =>
  filter === "All" || (filter === "Delivered" ? state === "deployed" || state === "merged" : state === "review" || state === "draft");
const delivered = (state: WinState) => state === "deployed" || state === "merged";
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";

function note(win: Win) {
  if (win.state === "deployed") return "A production deployment made after this merge is recorded as successful.";
  if (win.state === "merged") return win.surface === "site" ? "Not confirmed live on the site yet." : "Behind the scenes: no website deployment to confirm.";
  return null;
}

function WinCard({ win }: { win: Win }) {
  const isDelivered = delivered(win.state);
  return (
    <article aria-labelledby={`win-${win.pr}`} className="min-w-0 rounded-card border border-border-subtle bg-surface-card p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <p className="font-medium text-text-secondary">{win.area}</p>
        <p className={isDelivered ? "text-up" : "text-text-secondary"}>{labels[win.state]}</p>
      </div>
      <h3 id={`win-${win.pr}`} className="mt-2 break-words text-lg font-semibold leading-snug text-text-primary">{win.title}</h3>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 sm:gap-6">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium text-text-secondary">{isDelivered ? "Merged change" : "Intended change (not verified as merged)"}</p>
          <p className="break-words text-sm leading-relaxed text-text-secondary">{win.summary}</p>
        </div>
        <div className="min-w-0 border-t border-border-subtle pt-4 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          <p className="mb-1 text-xs font-medium text-text-secondary">{isDelivered ? "Why it helps" : "Intended benefit"}</p>
          <p className="break-words text-sm leading-relaxed text-text-primary">{win.benefit}</p>
        </div>
      </div>
      <div className="mt-4 border-t border-border-subtle pt-3">
        {win.mergedAt && <p className="text-xs leading-relaxed text-text-secondary">Merged <time dateTime={win.mergedAt}>{win.mergedAt.slice(0, 10)}</time> (UTC). {note(win)}</p>}
        <a className={`mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-control text-sm text-accent underline underline-offset-4 ${focusRing}`} href={`https://github.com/rileybleeker/Onyx/pull/${win.pr}`} target="_blank" rel="noopener noreferrer">
          View evidence - PR #{win.pr}<ArrowUpRight size={14} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
    </article>
  );
}

export default function WinsBoard({ board }: { board: Board }) {
  const [filter, setFilter] = useState<(typeof filters)[number]>("All");
  const count = (state: WinState) => board.wins.filter((win) => win.state === state).length;
  const live = count("deployed");
  const merged = count("merged");
  const proposed = count("review") + count("draft");
  const unknown = count("unknown");
  const closed = count("closed");
  const visible = board.wins.filter((win) => inFilter(filter, win.state));
  const groups = groupByStage(visible);
  const filterCounts = { All: board.wins.length, Delivered: live + merged, "In progress": proposed };

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-5">
        <div>
          <div className="mb-2 flex items-center gap-2 text-text-secondary"><Sparkles size={16} aria-hidden="true" /><span className="text-xs font-medium">Small wins. Better Onyx.</span></div>
          <h1 data-testid="page-heading" className="text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">Worth celebrating</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-text-secondary">A place to see the care going into Onyx. Real improvements, work still taking shape, and the evidence behind each one.</p>
        </div>
        <div role="group" aria-label="Progress overview" className="grid grid-cols-3 gap-2 sm:gap-4">
          <StatCard label="Live on the site" value={live} className="flex flex-col justify-between" />
          <StatCard label="Merged" value={merged} className="flex flex-col justify-between" />
          <StatCard label="In progress" value={proposed} className="flex flex-col justify-between" />
        </div>
        <div className="space-y-2 text-xs leading-relaxed text-text-secondary">
          <p>{live + merged === 0 && "Every improvement starts somewhere. "}Each stage is kept apart: proposals and drafts are not merged, and merged is not the same as live on the site.</p>
          {(closed > 0 || unknown > 0) && <p>{closed > 0 && `${closed} closed without merging.`}{closed > 0 && unknown > 0 && " "}{unknown > 0 && `${unknown} with status unavailable.`} Included in All.</p>}
        </div>
      </header>

      <section aria-label="Progress board" className="space-y-6">
        <div className="space-y-4 border-y border-border-subtle py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="group" aria-label="Filter progress" className="flex flex-wrap gap-2">
              {filters.map((name) => (
                <button key={name} type="button" aria-pressed={filter === name} onClick={() => setFilter(name)} className={`inline-flex min-h-11 items-center gap-2 rounded-control border px-3 py-2 text-sm ${focusRing} ${filter === name ? "border-border-emphasis bg-accent-muted text-accent" : "border-border-subtle text-text-secondary hover:bg-surface-hover hover:text-text-primary"}`}>
                  {name}<span aria-hidden="true" className="font-mono text-xs tabular-nums">{filterCounts[name]}</span>
                </button>
              ))}
            </div>
            <p role="status" aria-live="polite" className="text-xs text-text-secondary">Showing {visible.length} of {board.wins.length} highlights.</p>
          </div>
          <div className="flex items-start gap-2 text-xs leading-relaxed text-text-secondary">
            <Info size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
            <div>
              <p>Selected highlights, not a complete activity log. Status is a cached snapshot and may be older than five minutes.</p>
              <p className="mt-1">{board.checkedAt ? <>Source checked: <time dateTime={board.checkedAt}>{new Date(board.checkedAt).toISOString().replace("T", " ").slice(0, 16)} UTC</time>.</> : "No check time available."}</p>
            </div>
          </div>
        </div>

        {unknown > 0 && <p role="status" className="rounded-card border border-border-subtle bg-surface-card p-4 text-sm leading-relaxed text-text-secondary">Some statuses could not be verified. Those cards are not counted as delivered. Follow the evidence link for the latest status.</p>}

        {groups.map((group) => (
          <section key={group.state} aria-labelledby={`stage-${group.state}`} className="grid min-w-0 gap-4 border-t border-border-subtle pt-6 first-of-type:border-t-0 first-of-type:pt-0 xl:grid-cols-[220px_minmax(0,1fr)] xl:gap-6">
            <div className="min-w-0">
              <h2 id={`stage-${group.state}`} className="flex items-start gap-2 text-base font-semibold text-text-primary">
                {delivered(group.state) && <CircleCheck size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-up" />}
                <span>{labels[group.state]} <span className="font-mono text-sm font-normal text-text-secondary">({group.wins.length})</span></span>
              </h2>
              <p className="mt-2 max-w-2xl text-xs leading-relaxed text-text-secondary">{stageNotes[group.state]}</p>
            </div>
            <div className="min-w-0 space-y-4">{group.wins.map((win) => <WinCard key={win.pr} win={win} />)}</div>
          </section>
        ))}

        {visible.length === 0 && <div className="rounded-card border border-border-subtle bg-surface-card p-6 text-sm text-text-secondary">
          <p>No verified highlights in this view yet. Try All to see the full board.</p>
          {filter !== "All" && <button type="button" onClick={() => setFilter("All")} className={`mt-3 inline-flex min-h-11 items-center rounded-control px-3 text-accent underline underline-offset-4 ${focusRing}`}>Show all highlights</button>}
        </div>}
      </section>

      <footer className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border-subtle pt-4 text-sm text-text-secondary">
        <Link href="/today" className={`inline-flex min-h-11 items-center rounded-control underline underline-offset-4 hover:text-text-primary ${focusRing}`}>Back to Today</Link>
        <Link href="/agents" className={`inline-flex min-h-11 items-center rounded-control underline underline-offset-4 hover:text-text-primary ${focusRing}`}>Open agent conversations</Link>
      </footer>
    </div>
  );
}
