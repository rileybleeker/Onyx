"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { labels, type Board } from "@/lib/wins";

const filters = ["All", "Merged", "In progress"] as const;
export default function WinsBoard({ board }: { board: Board }) {
  const [filter, setFilter] = useState<(typeof filters)[number]>("All");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const merged = board.wins.filter((win) => win.state === "merged").length;
  const unavailable = board.wins.some((win) => win.state === "unknown");
  const visible = board.wins.filter((win) => filter === "All" || (filter === "Merged" ? win.state === "merged" : win.state === "review" || win.state === "draft"));
  return <div className="mx-auto max-w-5xl space-y-7">
    <header className="rounded-2xl border border-border-subtle bg-surface-card p-6 sm:p-8">
      <div className="mb-3 flex items-center gap-2 text-accent"><Sparkles size={18} aria-hidden="true" /><span className="text-xs uppercase tracking-widest">Small wins. Better Onyx.</span></div>
      <h1 className="text-3xl font-semibold text-text-primary">Worth celebrating</h1>
      <p className="mt-3 max-w-2xl text-text-secondary">A place to see the care going into Onyx. Real improvements, work still taking shape, and the evidence behind each one.</p>
      <p className="mt-5 text-sm text-text-secondary">{merged > 0 ? `${merged} selected improvements merged.` : "Every improvement starts somewhere."} Merged means the code is in the main branch, not that deployment has been verified.</p>
    </header>
    <section aria-label="Progress board" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter progress" className="flex flex-wrap gap-2">{filters.map((name) => <button key={name} type="button" aria-pressed={filter === name} onClick={() => setFilter(name)} className={`rounded-full border px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent ${filter === name ? "border-accent text-accent" : "border-border-subtle text-text-secondary"}`}>{name}</button>)}</div>
        <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())} className="text-sm text-accent underline underline-offset-4 disabled:opacity-50">{pending ? "Checking..." : "Check again"}</button>
      </div>
      <p className="text-xs text-text-tertiary">Selected highlights, not a complete activity log. GitHub status is cached for up to five minutes.{board.checkedAt ? ` Source checked: ${new Date(board.checkedAt).toISOString().replace("T", " ").slice(0, 16)} UTC.` : " No check time available."}</p>
      {unavailable && <p role="status" className="rounded-xl border border-border-subtle p-4 text-sm text-text-secondary">Some statuses could not be verified. Those cards are not counted as merged. Follow the evidence link for the latest status.</p>}
      <div className="grid gap-4 md:grid-cols-2">{visible.map((win) => <article key={win.pr} className="flex flex-col rounded-2xl border border-border-subtle bg-surface-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="text-text-tertiary">{win.area}</span><span className={`rounded-full border px-3 py-1 ${win.state === "merged" ? "border-accent text-accent" : "border-border-subtle text-text-secondary"}`}>{labels[win.state]}</span></div>
        <h2 className="mt-4 text-lg font-medium text-text-primary">{win.title}</h2>
        <p className="mt-2 flex-1 text-sm leading-relaxed text-text-secondary">{win.summary}</p>
        {win.mergedAt && <p className="mt-4 text-xs text-text-tertiary">Merged {win.mergedAt.slice(0, 10)} (UTC)</p>}
        <a className="mt-5 inline-flex items-center gap-1 self-start text-sm text-accent underline underline-offset-4" href={`https://github.com/rileybleeker/Onyx/pull/${win.pr}`} target="_blank" rel="noopener noreferrer">View evidence Â· PR #{win.pr}<ArrowUpRight size={14} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
      </article>)}</div>
      {visible.length === 0 && <p role="status" className="rounded-xl border border-border-subtle p-6 text-text-secondary">No verified highlights in this view yet. Try All to see the full board.</p>}
    </section>
    <footer className="flex flex-wrap gap-5 text-sm text-text-secondary"><Link href="/today" className="underline underline-offset-4">Back to Today</Link><Link href="/agents" className="underline underline-offset-4">Open agent conversations</Link></footer>
  </div>;
}
