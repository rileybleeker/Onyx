"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { LayoutGrid, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { NAV_ITEMS } from "@/lib/nav";
import { clientCache, fetchJsonValue, GONE } from "@/lib/client-cache";
import { browserIdle, navIntentProps } from "@/lib/warmup";
import {
  MORE_CARD_ID, OVERVIEW_CARDS, OVERVIEW_PREF_KEY, mergeArrangement, moreHrefs, parseArrangement, sameArrangement, toStored, visibleIds,
  type Arrangement,
} from "@/lib/overview-cards";
import { UI_PREFS_PATH, parseUiPref } from "@/lib/ui-preferences";
import OverviewCard, { CardFrame, CardSkeleton, type CardLink } from "./OverviewCard";
import OverviewEditor, { type EditorCard } from "./OverviewEditor";
import { ARRANGEMENT_URL, cardSources, checkedFetch } from "./sources";
import styles from "./Overview.module.css";

/**
 * The overview under Today's panels: one card per area of the app, so the whole app can be read in one scroll.
 * Riley arranges it (Edit: order, show, hide); the arrangement is the UI preference "overview.cards"
 * (/api/ui/preferences), so the phone and the desktop app match. Opening Today writes nothing: the only
 * write is Done in Edit mode.
 *
 * Speed: cards render their skeleton at once and read only near the screen (OverviewCard); after the page
 * has settled, the cards further down are read in idle slots, one request at a time, so scrolling finds them
 * filled. Every read goes through the shared client cache.
 */

/** The idle warm-up skips any key fetched more recently than this. */
const WARM_FRESH_MS = 10 * 60_000;
/** Start the idle warm-up this long after the overview mounts (Today's own requests go first). */
const WARM_DELAY_MS = 2500;
/** Without an answer by then, show the default arrangement. */
const ARRANGEMENT_WAIT_MS = 1500;
/** Re-read the arrangement when the app comes back after this long (it may have changed on the other device). */
const RESYNC_AFTER_MS = 60_000;
const SHORT_LABEL: Record<string, string> = { "/financials/forecast": "Forecast" };

interface CardMeta extends EditorCard { href: string | null; openLabel?: string; links: CardLink[] }

const NAV = new Map(NAV_ITEMS.map((i) => [i.href, i]));
const CARDS: Record<string, CardMeta> = Object.fromEntries(OVERVIEW_CARDS.map((c) => {
  const nav = c.href ? NAV.get(c.href) : undefined;
  const icon: LucideIcon = nav?.icon ?? LayoutGrid;
  const links = (c.links ?? []).flatMap((h) => { const n = NAV.get(h); return n ? [{ href: h, label: SHORT_LABEL[h] ?? n.label }] : []; });
  return [c.id, { title: c.title, icon, href: c.href, openLabel: nav ? `Open ${nav.label}` : undefined, links }];
}));
const MORE = moreHrefs(NAV_ITEMS.map((i) => i.href)).flatMap((h) => { const n = NAV.get(h); return n ? [n] : []; });

/** The arrangement in a stored answer; undefined when the answer is not a valid preference. */
function arrangementOf(raw: unknown): Arrangement | undefined {
  try {
    return mergeArrangement(parseArrangement(parseUiPref(raw, OVERVIEW_PREF_KEY).value));
  } catch {
    return undefined;
  }
}
async function fetchArrangement(): Promise<unknown> {
  const raw = await fetchJsonValue(ARRANGEMENT_URL);
  if (raw !== GONE) parseUiPref(raw, OVERVIEW_PREF_KEY);
  return raw;
}

function MoreCard() {
  return (
    <div className="min-w-0">
      <CardFrame id={MORE_CARD_ID} title={CARDS[MORE_CARD_ID].title} icon={LayoutGrid} href={null}>
        <p className="mt-1 text-[11px] text-text-tertiary">Pages without a card of their own.</p>
        <ul className="mt-2 grid min-h-0 flex-1 grid-cols-2 content-start gap-1 overflow-y-auto sm:grid-cols-3" aria-label="More pages">
          {MORE.map((n) => {
            const Icon = n.icon;
            return <li key={n.href} className="min-w-0"><Link href={n.href} {...navIntentProps(n.href)}
              className="flex min-h-11 items-center gap-2 rounded-control border border-border-subtle px-2.5 text-xs text-text-primary hover:border-border-hover hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
              <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-tertiary" /><span className="truncate">{n.label}</span>
            </Link></li>;
          })}
        </ul>
      </CardFrame>
    </div>
  );
}

export default function Overview() {
  const [arrangement, setArrangement] = useState<Arrangement | null>(() => {
    const raw = clientCache.peek(ARRANGEMENT_URL);
    return raw === undefined ? null : arrangementOf(raw) ?? null;
  });
  const [editing, setEditing] = useState(false);
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Editing or saving: a server answer must not replace what Riley is arranging.
  const busy = useRef(false);
  useEffect(() => { busy.current = editing || save === "saving"; }, [editing, save]);
  const editButton = useRef<HTMLButtonElement>(null);

  // A server answer (fresh, cached or pushed by a write elsewhere) replaces the arrangement only while Riley
  // is not editing or saving it.
  const adopt = useCallback((raw: unknown, fallback: boolean) => {
    const next = arrangementOf(raw);
    setArrangement((prev) => {
      if (!next) return prev ?? (fallback ? mergeArrangement(null) : prev);
      if (prev && (busy.current || sameArrangement(prev, next))) return prev;
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    let lastRead = Date.now();
    clientCache.register(ARRANGEMENT_URL, fetchArrangement);
    const stop = clientCache.subscribe(ARRANGEMENT_URL, (v) => { if (alive && v !== undefined) adopt(v, false); });
    const fallback = setTimeout(() => { if (alive) setArrangement((prev) => prev ?? mergeArrangement(null)); }, ARRANGEMENT_WAIT_MS);
    const revalidate = () => {
      lastRead = Date.now();
      void clientCache.revalidate(ARRANGEMENT_URL, fetchArrangement)
        .then((v) => { if (alive) adopt(v ?? null, true); })
        .catch(() => { if (alive) setArrangement((prev) => prev ?? mergeArrangement(null)); });
    };
    void clientCache.read(ARRANGEMENT_URL).then((v) => { if (alive && v !== undefined) adopt(v, false); }).finally(() => { if (alive) revalidate(); });
    const onVisible = () => { if (document.visibilityState === "visible" && Date.now() - lastRead > RESYNC_AFTER_MS) revalidate(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; stop(); clearTimeout(fallback); document.removeEventListener("visibilitychange", onVisible); };
  }, [adopt]);

  const shown = useMemo(() => (arrangement ? visibleIds(arrangement) : null), [arrangement]);
  const shownKey = shown?.join(",") ?? "";

  // Idle warm-up of the cards further down: one request per idle slot, skipping anything fetched recently and
  // the keys Today's own panels load. Cancelled when Today unmounts or the arrangement changes.
  useEffect(() => {
    if (!shownKey || editing) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      for (const id of shownKey.split(",")) {
        for (const s of cardSources(id)) {
          if (cancelled) return;
          if (s.today) continue;
          const at = clientCache.fetchedAt(s.key);
          if (at !== undefined && Date.now() - at < Math.max(s.freshMs, WARM_FRESH_MS)) continue;
          await browserIdle();
          if (cancelled) return;
          await clientCache.revalidate(s.key, checkedFetch(s), { persist: s.persist }).catch(() => {});
        }
      }
    }, WARM_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [shownKey, editing]);

  const store = useCallback(async (next: Arrangement) => {
    busy.current = true;
    setSave("saving");
    try {
      const res = await fetch(UI_PREFS_PATH, {
        method: "PUT",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: OVERVIEW_PREF_KEY, value: toStored(next) }),
      });
      if (!res.ok) throw new Error("Save failed");
      const body = await res.json();
      parseUiPref(body, OVERVIEW_PREF_KEY);
      clientCache.put(ARRANGEMENT_URL, body);
      setSave("saved");
    } catch {
      setSave("error");
    }
  }, []);

  function finish(next: Arrangement | null) {
    setEditing(false);
    // Back to the Edit button, so keyboard and screen-reader focus is not lost with the editor.
    requestAnimationFrame(() => editButton.current?.focus());
    if (!next || (arrangement && sameArrangement(next, arrangement))) return;
    setArrangement(next);
    void store(next);
  }

  return (
    <section aria-labelledby="overview-heading" className={`${styles.overview} mt-2`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="rounded-md border border-border-default px-[7px] py-[5px] text-[10px] tabular-nums text-text-secondary">04</span>
            <h2 id="overview-heading" className="text-sm font-medium tracking-[-0.01em] text-text-primary">Everything else, at a glance</h2>
          </div>
          <p className="mt-2 text-xs text-text-secondary">A card for every area. Open one for the full page.</p>
        </div>
        {!editing && <button ref={editButton} type="button" onClick={() => setEditing(true)} disabled={!arrangement} aria-label="Edit the overview: order, show and hide cards"
          className="inline-flex min-h-11 items-center gap-2 rounded-control border border-border-default px-3.5 text-xs text-text-secondary hover:border-border-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40">
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" /> Edit
        </button>}
      </div>
      <p role="status" aria-live="polite" className={save === "error" ? "flex flex-wrap items-center gap-x-3 text-xs text-mid" : "sr-only"}>
        {save === "saving" ? "Saving the overview order…" : save === "saved" ? "Overview order saved." : save === "error" ? <>
          <span>Couldn&apos;t save the new order to your account. This screen keeps it until you leave.</span>
          {arrangement && <button type="button" onClick={() => void store(arrangement)} className="inline-flex min-h-11 items-center text-accent focus-visible:outline-2 focus-visible:outline-accent">Try again</button>}
        </> : ""}
      </p>
      {editing && arrangement
        ? <OverviewEditor initial={arrangement} cards={CARDS} onDone={finish} onCancel={() => finish(null)} />
        : <div className={styles.grid}>
          {(shown ?? visibleIds(mergeArrangement(null))).map((id) => {
            const c = CARDS[id];
            if (!c) return null;
            if (id === MORE_CARD_ID) return <MoreCard key={id} />;
            if (!shown) return <div key={id} className="min-w-0"><CardFrame id={id} title={c.title} icon={c.icon} href={c.href} openLabel={c.openLabel} busy><CardSkeleton links={c.links} /></CardFrame></div>;
            return <OverviewCard key={id} id={id} title={c.title} icon={c.icon} href={c.href!} openLabel={c.openLabel} links={c.links} />;
          })}
          {shown && shown.length === 0 && <p className="text-sm text-text-secondary">Every card is hidden. Use Edit to show some again.</p>}
        </div>}
    </section>
  );
}
