"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import DeferredMount from "@/components/DeferredMount";
import { clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import { navIntentProps } from "@/lib/warmup";
import { cardState, type CardView, type Metric, type Part, type Tone } from "@/lib/overview-views";
import { checkedFetch, cardSources, type OverviewSource } from "./sources";
import Spark from "./Spark";
import styles from "./Overview.module.css";

/**
 * One overview card. It renders its final-size skeleton at once and starts reading only when it comes near
 * the screen (one shared IntersectionObserver); its body then mounts through DeferredMount (one card per
 * frame), so a fast scroll or a tall desktop window never builds every card in one task. Data: the shared
 * client cache first (an instant revisit or reopen), then a revalidation unless the cached answer is still
 * fresh (lib/client-cache.ts rules; sources.ts lists the keys).
 */

const TONE: Record<Tone, string> = { up: "text-up", mid: "text-mid", down: "text-down" };
/** How far ahead of the screen a card starts reading. */
export const VIEW_MARGIN = "600px 0px";
/** Today's own panels load some of these keys on open; a card waits this long for that answer first. */
const TODAY_WAIT_MS = 2500;

// ---- in view: one observer for every card ----

const waiting = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;
function whenNear(el: Element, onNear: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") { onNear(); return () => {}; }
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const fn = waiting.get(e.target);
      waiting.delete(e.target);
      observer?.unobserve(e.target);
      fn?.();
    }
  }, { rootMargin: VIEW_MARGIN });
  waiting.set(el, onNear);
  observer.observe(el);
  return () => { waiting.delete(el); observer?.unobserve(el); };
}

// ---- data ----

function usable(s: OverviewSource, v: unknown): boolean {
  if (v === undefined || v === null) return false;
  try { s.check(v); return true; } catch { return false; }
}
function peekPart(s: OverviewSource): Part {
  const v = clientCache.peek(s.key);
  return usable(s, v) ? { state: "ready", value: v } : { state: "loading" };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Show the cached copy, then revalidate unless it is still fresh. Throws when the server could not answer. */
export async function loadSource(s: OverviewSource, show: (v: unknown) => void, alive: () => boolean): Promise<void> {
  const started = Date.now();
  const cached = await clientCache.read(s.key);
  const had = usable(s, cached);
  if (had) show(cached);
  if (!alive()) return;
  const freshAt = () => clientCache.fetchedAt(s.key);
  const at = freshAt();
  if (had && at !== undefined && Date.now() - at < s.freshMs) return;
  if (s.today) {
    // Today is probably fetching this key right now: use its answer instead of asking twice.
    for (let t = 0; t < TODAY_WAIT_MS; t += 250) {
      await pause(250);
      if (!alive()) return;
      const landed = freshAt();
      const v = clientCache.peek(s.key);
      if (landed !== undefined && landed >= started && usable(s, v)) { show(v); return; }
    }
  }
  const v = await clientCache.revalidate(s.key, checkedFetch(s), { persist: s.persist });
  if (!alive()) return;
  if (v === undefined) throw new Error("Gone");
  show(v);
}

function useCardParts(id: string, active: boolean): Part[] {
  const sources = useMemo(() => cardSources(id), [id]);
  const [parts, setParts] = useState<Part[]>(() => sources.map(peekPart));
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const set = (i: number, next: (p: Part) => Part) => setParts((prev) => {
      const p = next(prev[i]);
      if (p === prev[i]) return prev;
      const copy = prev.slice();
      copy[i] = p;
      return copy;
    });
    // A fresh answer replaces what is shown; an identical one keeps the same object so React skips the render.
    const show = (i: number) => (v: unknown) => set(i, (p) => (p.state === "ready" && !p.stale && sameJson(p.value, v) ? p : { state: "ready", value: v }));
    const stop = sources.map((s, i) => {
      clientCache.register(s.key, checkedFetch(s)); // a write elsewhere refetches it (AppData invalidation)
      return clientCache.subscribe(s.key, (v) => { if (alive && usable(s, v)) show(i)(v); });
    });
    sources.forEach((s, i) => {
      loadSource(s, show(i), () => alive).catch(() => {
        if (alive) set(i, (p) => (p.state === "ready" ? (p.stale ? p : { ...p, stale: true }) : { state: "error" }));
      });
    });
    return () => { alive = false; stop.forEach((fn) => fn()); };
  }, [active, sources]);
  return parts;
}

// ---- layout (one fixed height: the skeleton and the card are the same size) ----

export interface CardLink { href: string; label: string }

export function CardFrame({ id, title, icon: Icon, href, openLabel, children, busy }: {
  id: string; title: string; icon: LucideIcon; href: string | null; openLabel?: string; children: ReactNode; busy?: boolean;
}) {
  return (
    <section aria-labelledby={`overview-${id}-heading`} aria-busy={busy || undefined} data-card={id}
      className={`${styles.card} flex flex-col rounded-card border border-border-subtle bg-surface-card p-4 shadow-card`}>
      <div className="flex min-h-11 items-center justify-between gap-2">
        <h3 id={`overview-${id}-heading`} className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary">
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-accent" />
          <span className="truncate">{title}</span>
        </h3>
        {href && <Link href={href} {...navIntentProps(href)} aria-label={openLabel ?? `Open ${title}`}
          className="-mr-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-control px-2 text-xs text-accent hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent">
          Open <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>}
      </div>
      {children}
    </section>
  );
}

function MetricCell({ m }: { m: Metric }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">{m.label}</p>
      <p className={`mt-1 truncate whitespace-nowrap font-display text-2xl leading-none tabular-nums ${m.tone ? TONE[m.tone] : "text-text-primary"}`}>
        {m.value}{m.unit && <span className="ml-0.5 font-sans text-xs text-text-secondary">{m.unit}</span>}
      </p>
      {m.sub && <p className="mt-1 truncate text-[11px] text-text-secondary">{m.sub}</p>}
    </div>
  );
}

function Footer({ note, links, stale }: { note?: string; links: CardLink[]; stale?: boolean }) {
  return (
    <div className="mt-auto flex min-h-11 items-center justify-between gap-2">
      <p className={`min-w-0 truncate text-[11px] ${stale ? "text-mid" : "text-text-tertiary"}`}>
        {stale ? "Not refreshed: showing the last check." : note}
      </p>
      {links.length > 0 && <div className="-mr-2 flex shrink-0">
        {links.map((l) => <Link key={l.href} href={l.href} {...navIntentProps(l.href)}
          className="inline-flex min-h-11 items-center rounded-control px-2 text-[11px] text-text-secondary hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">{l.label}</Link>)}
      </div>}
    </div>
  );
}

export function CardBody({ view, links, stale }: { view: CardView; links: CardLink[]; stale: boolean }) {
  const lines = !!view.lines && view.lines.length > 0;
  return (
    <>
      <div className="mt-2 grid grid-cols-3 gap-3">{view.metrics.slice(0, 3).map((m) => <MetricCell key={m.label} m={m} />)}</div>
      <div className={`${styles.middle} mt-3`}>
        {view.chart ? <Spark chart={view.chart} />
          : lines ? <ul className="space-y-1.5">
            {view.lines!.slice(0, 2).map((l, i) => <li key={i} className={`truncate text-xs ${l.tone ? TONE[l.tone] : "text-text-primary"}`}>{l.text}</li>)}
          </ul>
          : view.note ? <p className="line-clamp-2 text-xs text-text-secondary">{view.note}</p> : null}
      </div>
      <Footer note={view.chart || lines ? view.note : undefined} links={links} stale={stale} />
    </>
  );
}

/** The skeleton: the same rows at the same heights, no animation. */
export function CardSkeleton({ links }: { links: CardLink[] }) {
  return (
    <div aria-hidden="true" className="contents">
      <div className="mt-2 grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => <div key={i}><div className="skeleton h-2.5 w-3/4" /><div className="skeleton mt-1.5 h-6 w-2/3" /><div className="skeleton mt-1.5 h-2.5 w-5/6" /></div>)}
      </div>
      <div className={`${styles.middle} mt-3`}><div className="skeleton h-full w-full" /></div>
      <Footer links={links} />
    </div>
  );
}

export default function OverviewCard({ id, title, icon, href, openLabel, links }: {
  id: string; title: string; icon: LucideIcon; href: string; openLabel?: string; links: CardLink[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    return whenNear(el, () => setNear(true));
  }, [near]);
  const parts = useCardParts(id, near);
  const state = cardState(id, parts, new Date());
  const skeleton = <CardSkeleton links={links} />;
  return (
    <div ref={ref} className="min-w-0">
      <CardFrame id={id} title={title} icon={icon} href={href} openLabel={openLabel} busy={state.kind === "loading"}>
        {!near || state.kind === "loading" ? skeleton
          : <DeferredMount placeholder={skeleton}>
            {state.kind === "error"
              ? <>
                <p className="mt-3 text-sm text-text-secondary">Couldn&apos;t load this summary.</p>
                <p className="mt-1 text-xs text-text-tertiary">Open the page for the full view, or refresh Today.</p>
                <Footer links={links} />
              </>
              : <CardBody view={state.view} links={links} stale={state.stale} />}
          </DeferredMount>}
      </CardFrame>
    </div>
  );
}
