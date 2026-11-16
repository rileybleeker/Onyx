"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { LayoutGrid, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { NAV_ITEMS } from "@/lib/nav";
import { clientCache } from "@/lib/client-cache";
import { browserIdle, navIntentProps } from "@/lib/warmup";
import { MORE_CARD_ID, OVERVIEW_CARDS, moreHrefs } from "@/lib/overview-cards";
import { AREAS_KEY, areaId } from "@/lib/nav-areas";
import { Part, PartGrid, usePartOrder } from "@/components/personalize/PartGrid";
import { personalizeNow } from "@/components/personalize/start";
import OverviewCard, { CardFrame, type CardLink } from "./OverviewCard";
import { cardSources, checkedFetch } from "./sources";
import styles from "./Overview.module.css";

/**
 * The overview under Today's panels: one card per area of the app, so the whole app can be read in one scroll.
 * The cards follow the app's ONE area order (`layout.areas`, Personalize): the order the side panel and the
 * continuous scroll use too. Rearranging is Personalize mode (drag, menu, Hide also hides the area from the scroll);
 * the old arrangement ("overview.cards") was copied into layout.areas the first time it was read.
 *
 * Speed: the order comes from this device's copy in the first render (no request); cards render their skeleton at
 * once and read only near the screen (OverviewCard); a hidden card is not rendered and reads nothing. After the
 * page has settled, the shown cards further down are read in idle slots, one request at a time.
 */

/** The idle warm-up skips any key fetched more recently than this. */
const WARM_FRESH_MS = 10 * 60_000;
/** Start the idle warm-up this long after the overview mounts (Today's own requests go first). */
const WARM_DELAY_MS = 2500;
const SHORT_LABEL: Record<string, string> = { "/financials/forecast": "Forecast" };

interface CardMeta {
  id: string;
  /** The card's part id: the area id of the page it opens (the "More pages" card keeps its own id). */
  part: string;
  title: string;
  icon: LucideIcon;
  href: string | null;
  openLabel?: string;
  links: CardLink[];
}

const NAV = new Map(NAV_ITEMS.map((i) => [i.href, i]));
const CARDS: CardMeta[] = OVERVIEW_CARDS.map((c) => {
  const nav = c.href ? NAV.get(c.href) : undefined;
  const links = (c.links ?? []).flatMap((h) => {
    const n = NAV.get(h);
    return n ? [{ href: h, label: SHORT_LABEL[h] ?? n.label }] : [];
  });
  return {
    id: c.id,
    part: c.href ? areaId(c.href) : c.id,
    title: c.title,
    icon: nav?.icon ?? LayoutGrid,
    href: c.href,
    openLabel: nav ? `Open ${nav.label}` : undefined,
    links,
  };
});
const PART_IDS = CARDS.map((c) => c.part);
const CARD_BY_PART = new Map(CARDS.map((c) => [c.part, c] as const));
const MORE = moreHrefs(NAV_ITEMS.map((i) => i.href)).flatMap((h) => {
  const n = NAV.get(h);
  return n ? [n] : [];
});

function MoreCard() {
  const more = CARDS.find((c) => c.id === MORE_CARD_ID);
  return (
    <div className="min-w-0">
      <CardFrame id={MORE_CARD_ID} title={more?.title ?? "More pages"} icon={LayoutGrid} href={null}>
        <p className="mt-1 text-[11px] text-text-tertiary">Pages without a card of their own.</p>
        <ul className="mt-2 grid min-h-0 flex-1 grid-cols-2 content-start gap-1 overflow-y-auto sm:grid-cols-3" aria-label="More pages">
          {MORE.map((n) => {
            const Icon = n.icon;
            return (
              <li key={n.href} className="min-w-0">
                <Link
                  href={n.href}
                  {...navIntentProps(n.href)}
                  className="flex min-h-11 items-center gap-2 rounded-control border border-border-subtle px-2.5 text-xs text-text-primary hover:border-border-hover hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                  <span className="truncate">{n.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardFrame>
    </div>
  );
}

export default function Overview() {
  // The cards on screen, in the area order (hidden ones left out).
  const shownParts = usePartOrder("/today", PART_IDS, "main", AREAS_KEY);
  const shownKey = shownParts.join(",");

  // Idle warm-up of the cards further down: one request per idle slot, skipping anything fetched recently and
  // the keys Today's own panels load. Cancelled when Today unmounts or the shown cards change.
  useEffect(() => {
    if (!shownKey) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      for (const part of shownKey.split(",")) {
        const card = CARD_BY_PART.get(part);
        if (!card) continue;
        for (const s of cardSources(card.id)) {
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
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [shownKey]);

  const cards = useMemo(
    () =>
      CARDS.map((c) => (
        <Part key={c.part} id={c.part} title={c.title}>
          {c.id === MORE_CARD_ID ? (
            <MoreCard />
          ) : (
            <OverviewCard id={c.id} title={c.title} icon={c.icon} href={c.href as string} openLabel={c.openLabel} links={c.links} />
          )}
        </Part>
      )),
    [],
  );

  return (
    <section aria-labelledby="overview-heading" className={`${styles.overview} mt-2`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="rounded-md border border-border-default px-[7px] py-[5px] text-[10px] tabular-nums text-text-secondary">04</span>
            <h2 id="overview-heading" className="text-lg font-semibold tracking-[-0.02em] text-text-primary sm:text-xl">Everything else, at a glance</h2>
          </div>
          <p className="mt-2 text-xs text-text-secondary">A card for every area, in the same order as the scroll and the side panel.</p>
        </div>
        <button
          type="button"
          onClick={() => personalizeNow()}
          aria-label="Personalize: order, show and hide the cards (the scroll and the side panel follow)"
          className="inline-flex min-h-11 items-center gap-2 rounded-control border border-border-default px-3.5 text-xs text-text-secondary hover:border-border-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
        >
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" /> Personalize
        </button>
      </div>
      <PartGrid
        page="/today"
        storeKey={AREAS_KEY}
        title="Today"
        target={false}
        bare
        className={styles.grid}
        widths={[]}
        hideLabel="Hide (also from the scroll)"
      >
        {cards}
      </PartGrid>
      {shownParts.length === 0 && <p className="text-sm text-text-secondary">Every card is hidden. Use Personalize to show some again.</p>}
    </section>
  );
}
