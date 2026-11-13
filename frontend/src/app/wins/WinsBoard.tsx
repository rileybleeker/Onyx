"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { groupByStage, labels, stageNotes, type Board, type Win, type WinState } from "@/lib/wins";

const filters = ["All", "Delivered", "In progress"] as const;
const inFilter = (filter: (typeof filters)[number], state: WinState) =>
  filter === "All" || (filter === "Delivered" ? state === "deployed" || state === "merged" : state === "review" || state === "draft");
const delivered = (state: WinState) => state === "deployed" || state === "merged";

function note(win: Win) {
  if (win.state === "deployed") return "A production deployment made after this merge is recorded as successful.";
  if (win.state === "merged") return win.surface === "site" ? "Not confirmed live on the site yet." : "Behind the scenes: no website deployment to confirm.";
  return null;
}

export default function WinsBoard({ board }: { board: Board }) {
  const [filter, setFilter] = useState<(typeof filters)[number]>("All");
  const count = (state: WinState) => board.wins.filter((win) => win.state === state).length;
  const live = count("deployed");
  const merged = count("merged");
  const proposed = count("review") + count("draft");
  const unavailable = count("unknown") > 0;
  const visible = board.wins.filter((win) => inFilter(filter, win.state));
  const groups = groupByStage(visible);
  return <div className="mx-auto max-w-5xl space-y-7">
    <header className="rounded-2xl border border-border-subtle bg-surface-card p-6 sm:p-8">
      <div className="mb-3 flex items-center gap-2 text-accent"><Sparkles size={18} aria-hidden="true" /><span className="text-xs uppercase tracking-widest">Small wins. Better Onyx.</span></div>
      <h1 data-testid="page-heading" className="text-3xl font-semibold text-text-primary">Worth celebrating</h1>
      <p className="mt-3 max-w-2xl text-text-secondary">A place to see the care going into Onyx. Real improvements, work still taking shape, and the evidence behind each one.</p>
      <p className="mt-5 text-sm text-text-secondary">{live + merged > 0 ? `${live} live on the site, ${merged} merged, ${proposed} proposed or in draft.` : "Every improvement starts somewhere."} Each stage is kept apart: proposals and drafts are not merged, and merged is not the same as live on the site.</p>
    </header>
    <section aria-label="Progress board" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter progress" className="flex flex-wrap gap-2">{filters.map((name) => <button key={name} type="button" aria-pressed={filter === name} onClick={() => setFilter(name)} className={`rounded-full border px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent ${filter === name ? "border-accent text-accent" : "border-border-subtle text-text-secondary"}`}>{name}</button>)}</div>
      </div>
      <p className="text-xs text-text-secondary">Selected highlights, not a complete activity log. Status is a cached snapshot and may be older than five minutes.{board.checkedAt ? ` Source checked: ${new Date(board.checkedAt).toISOString().replace("T", " ").slice(0, 16)} UTC.` : " No check time available."}</p>
      {unavailable && <p role="status" className="rounded-xl border border-border-subtle p-4 text-sm text-text-secondary">Some statuses could not be verified. Those cards are not counted as delivered. Follow the evidence link for the latest status.</p>}
      <p role="status" aria-live="polite" className="sr-only">Showing {visible.length} of {board.wins.length} highlights.</p>
      {groups.map((group) => <section key={group.state} aria-labelledby={`stage-${group.state}`} className="space-y-3">
        <div>
          <h2 id={`stage-${group.state}`} className="text-base font-medium text-text-primary">{labels[group.state]} <span className="text-text-secondary">({group.wins.length})</span></h2>
          <p className="text-xs text-text-secondary">{stageNotes[group.state]}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">{group.wins.map((win) => <article key={win.pr} className="flex flex-col rounded-2xl border border-border-subtle bg-surface-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="text-text-secondary">{win.area}</span><span className={`rounded-full border px-3 py-1 ${delivered(win.state) ? "border-accent text-accent" : "border-border-subtle text-text-secondary"}`}>{labels[win.state]}</span></div>
          <h3 className="mt-4 text-lg font-medium text-text-primary">{win.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary"><span className="font-medium">{delivered(win.state) ? "Merged change: " : "Intended change (not verified as merged): "}</span>{win.summary}</p>
          <p className="mt-2 flex-1 text-sm leading-relaxed text-text-secondary"><span className="font-medium">{delivered(win.state) ? "Why it helps: " : "Intended benefit: "}</span>{win.benefit}</p>
          {win.mergedAt && <p className="mt-4 text-xs text-text-secondary">Merged {win.mergedAt.slice(0, 10)} (UTC). {note(win)}</p>}
          <a className="mt-5 inline-flex items-center gap-1 self-start text-sm text-accent underline underline-offset-4" href={`https://github.com/rileybleeker/Onyx/pull/${win.pr}`} target="_blank" rel="noopener noreferrer">View evidence - PR #{win.pr}<ArrowUpRight size={14} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
        </article>)}</div>
      </section>)}
      {visible.length === 0 && <p className="rounded-xl border border-border-subtle p-6 text-text-secondary">No verified highlights in this view yet. Try All to see the full board.</p>}
    </section>
    <footer className="flex flex-wrap gap-5 text-sm text-text-secondary"><Link href="/today" className="underline underline-offset-4">Back to Today</Link><Link href="/agents" className="underline underline-offset-4">Open agent conversations</Link></footer>
  </div>;
}
