"use client";

import { useState, useSyncExternalStore, type DragEvent, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Ellipsis, Eye, EyeOff, GripVertical, ListX, Pin, PinOff, Plus } from "lucide-react";
import { NAV_ITEMS, NAV_SECTIONS, type NavItem } from "@/lib/nav";
import { goHint } from "@/lib/go-shortcuts";
import { isFeedExcluded } from "@/lib/feed-order";
import { AREAS_KEY, areaId, areaPrefsOf, arrangeNav } from "@/lib/nav-areas";
import {
  moveNavItem, moveNavItemBy, moveNavSection, moveNavSectionBy, movePinnedBy, setNavHidden, setPinned, setPinnedList,
  setScrollHidden, setTabSlots,
} from "@/lib/nav-arrange";
import { DEFAULT_TAB_SLOTS, MORE_SLOT, chooseTab, tabLabel, tabSlots } from "@/lib/mobile-tabs";
import { EMPTY_LAYOUT, type PageLayout } from "@/lib/personalize-layout";
import { moveBefore } from "@/lib/personalize-ops";
import { endEdit, layoutSnapshot, subscribe, updateDraftFor } from "@/lib/personalize-store";
import { announce } from "./editor-shared";

/**
 * Personalize mode for the side panel (desktop sidebar) and the phone drawer. Everything here is the app's area
 * layout (`layout.areas`, lib/nav-areas.ts), saved with the page's changes on Done:
 *   - the order (drag a page within its section, or a section by its name; the continuous scroll follows it);
 *   - Pin: a page goes to Quick access (and leads the scroll); drag it there, or within Quick access to reorder;
 *   - Hide from navigation (side panel + drawer; listed under "Show hidden") and Hide from scroll, separately;
 *   - the phone bottom bar's four slots around Log (drawer only).
 * Desktop: drag with an accent line where it lands, plus buttons for the keyboard. Phone: 44 px buttons.
 */

type Drag =
  | { kind: "item"; href: string; section: number }
  | { kind: "pin"; href: string }
  | { kind: "section"; index: number };
const DRAG_TYPE = "application/x-onyx-area";

function useAreasDraft() {
  return useSyncExternalStore(subscribe, () => layoutSnapshot(AREAS_KEY), () => EMPTY_LAYOUT);
}

/** The side panel as drafted: Quick access, sections without pinned / hidden pages, hidden pages, scroll-hidden ids. */
function useArranged() {
  const layout = useAreasDraft();
  const prefs = areaPrefsOf(layout);
  const arranged = arrangeNav(NAV_SECTIONS, prefs);
  const offScroll = new Set(prefs.scrollHidden);
  return { ...arranged, offScroll: (href: string) => offScroll.has(areaId(href)), tabs: prefs.tabs };
}

const labelOf = (href: string) => NAV_ITEMS.find((i) => i.href === href)?.label ?? href;

function change(fn: (l: PageLayout) => PageLayout, said: string) {
  updateDraftFor(AREAS_KEY, fn);
  announce(said);
}

function pin(href: string, on: boolean, beforeHref: string | null = null) {
  change((l) => setPinned(l, NAV_SECTIONS, href, on, beforeHref), `${labelOf(href)} ${on ? "pinned to Quick access" : "unpinned"}.`);
}

function hideFromNav(href: string, on: boolean) {
  change((l) => setNavHidden(l, NAV_SECTIONS, href, on), `${labelOf(href)} ${on ? "hidden from navigation" : "shown in navigation"}.`);
}

function hideFromScroll(href: string, on: boolean) {
  change((l) => setScrollHidden(l, NAV_SECTIONS, href, on), `${labelOf(href)} ${on ? "left out of the scroll" : "back in the scroll"}.`);
}

function moveItemBy(href: string, delta: number, shown?: (href: string) => boolean) {
  change((l) => moveNavItemBy(l, NAV_SECTIONS, href, delta, shown), `${labelOf(href)} moved ${delta < 0 ? "up" : "down"}.`);
}

function movePinBy(href: string, delta: number) {
  change((l) => movePinnedBy(l, NAV_SECTIONS, href, delta), `${labelOf(href)} moved ${delta < 0 ? "up" : "down"}.`);
}

function moveSectionBy(index: number, delta: number, shown?: (index: number) => boolean) {
  change((l) => moveNavSectionBy(l, NAV_SECTIONS, index, delta, shown), `${NAV_SECTIONS[index]?.title ?? "Section"} moved ${delta < 0 ? "up" : "down"}.`);
}

/** Navigation stays possible with Ctrl / Cmd + click (BC); a plain click while arranging does nothing. */
function holdClick(e: MouseEvent) {
  if (!e.ctrlKey && !e.metaKey) e.preventDefault();
}

const tiny =
  "w-6 h-6 shrink-0 flex items-center justify-center rounded-control text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:invisible";
const option =
  "flex items-center gap-1.5 whitespace-nowrap rounded-control px-2 py-1 text-left text-[11px] text-text-secondary hover:bg-white/[0.06] hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40";

function Marker({ after }: { after: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-1 z-10 flex items-center"
      style={{ top: after ? "100%" : 0, transform: "translateY(-50%)" }}
    >
      <span className="h-2 w-2 rounded-full bg-accent" />
      <span className="h-0.5 flex-1 rounded-full bg-accent" />
    </span>
  );
}

/** The desktop sidebar's page lists while personalizing (replaces Quick access + All sections). */
export function SidebarArranger({ current }: { current: string }) {
  const { pinned, sections, hidden, offScroll } = useArranged();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const pinnedHrefs = pinned.map((i) => i.href);
  const hiddenHrefs = new Set(hidden.map((i) => i.href));
  const shownSection = (i: number) => sections.some((s) => s.index === i);
  const shownItem = (h: string) => !pinnedHrefs.includes(h) && !hiddenHrefs.has(h);

  function over(e: DragEvent, key: string, ok: boolean) {
    if (!ok) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    if (drop?.key !== key || drop.after !== after) setDrop({ key, after });
  }
  function end() {
    setDrag(null);
    setDrop(null);
  }
  function startDrag(e: DragEvent, d: Drag, text: string) {
    e.dataTransfer.setData(DRAG_TYPE, text);
    e.dataTransfer.effectAllowed = "move";
    setDrag(d);
  }

  /** Drop on Quick access: a pinned page is reordered, a page from a section is pinned at that spot. */
  function dropOnQuick(beforeHref: string | null) {
    if (drag?.kind === "pin") {
      const next = moveBefore(pinnedHrefs, drag.href, beforeHref);
      change((l) => setPinnedList(l, NAV_SECTIONS, next), `${labelOf(drag.href)} moved.`);
    } else if (drag?.kind === "item") {
      pin(drag.href, true, beforeHref);
    }
    end();
  }

  function link(item: NavItem, d: Drag | null, extra?: ReactNode) {
    const active = current === item.href;
    const Icon = item.icon;
    return (
      <Link
        href={item.href}
        onClick={holdClick}
        draggable={d !== null}
        onDragStart={d ? (e) => startDrag(e, d, item.href) : undefined}
        onDragEnd={end}
        title={d ? "Drag to move (Ctrl + click opens the page)" : "Ctrl + click opens the page"}
        className={`flex items-center gap-2 pl-1.5 pr-14 py-2 rounded-control text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          d ? "cursor-grab active:cursor-grabbing" : ""
        } ${active ? "bg-surface-raised text-text-primary" : "text-text-secondary hover:text-text-primary hover:bg-white/[0.03]"}`}
      >
        {d ? <GripVertical aria-hidden className="w-3.5 h-3.5 shrink-0 text-text-tertiary" /> : <span className="w-3.5 shrink-0" />}
        <Icon className={`w-[17px] h-[17px] shrink-0 ${active ? "text-accent" : "text-text-tertiary"}`} strokeWidth={1.75} />
        <span className="flex-1 truncate">{item.label}</span>
        {extra}
        {offScroll(item.href) && (
          <span title="Left out of the continuous scroll" className="shrink-0">
            <ListX aria-label="Not in the scroll" className="w-3.5 h-3.5 text-text-tertiary" />
          </span>
        )}
        <kbd className="sr-only">{goHint(item.shortcut)}</kbd>
      </Link>
    );
  }

  /** The options under a row (its ⋯ button): move, hide from navigation, hide from scroll. */
  function options(item: NavItem, move: { up: (() => void) | null; down: (() => void) | null }) {
    if (open !== item.href) return null;
    const scrollOff = offScroll(item.href);
    return (
      <div className="mx-1 mb-1 flex flex-col gap-0.5 rounded-control border border-border-subtle bg-surface-raised p-1" role="group" aria-label={`${item.label} options`}>
        <div className="flex gap-0.5">
          <button type="button" className={`${option} flex-1`} disabled={!move.up} onClick={() => move.up?.()}>
            <ArrowUp aria-hidden className="w-3 h-3" /> Move up
          </button>
          <button type="button" className={`${option} flex-1`} disabled={!move.down} onClick={() => move.down?.()}>
            <ArrowDown aria-hidden className="w-3 h-3" /> Move down
          </button>
        </div>
        <button type="button" className={option} onClick={() => { hideFromNav(item.href, true); setOpen(null); }}>
          <EyeOff aria-hidden className="w-3 h-3" /> Hide from navigation
        </button>
        {isFeedExcluded(item.href) ? (
          <p className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-tertiary">
            <ListX aria-hidden className="w-3 h-3" /> Never in the scroll
          </p>
        ) : (
          <button type="button" className={option} aria-pressed={scrollOff} onClick={() => hideFromScroll(item.href, !scrollOff)}>
            <ListX aria-hidden className="w-3 h-3" /> {scrollOff ? "Show in the scroll" : "Hide from scroll"}
          </button>
        )}
      </div>
    );
  }

  function rowButtons(item: NavItem, pinnedNow: boolean) {
    return (
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2">
        <button
          type="button"
          aria-label={pinnedNow ? `Unpin ${item.label}` : `Pin ${item.label} to Quick access`}
          aria-pressed={pinnedNow}
          title={pinnedNow ? "Unpin" : "Pin to Quick access (also first in the scroll)"}
          onClick={() => pin(item.href, !pinnedNow)}
          className={`${tiny} ${pinnedNow ? "text-accent" : ""}`}
        >
          {pinnedNow ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
        </button>
        <button
          type="button"
          aria-label={`${item.label} options`}
          aria-expanded={open === item.href}
          title="Move, hide from navigation, hide from scroll"
          onClick={() => setOpen((o) => (o === item.href ? null : item.href))}
          className={`${tiny} ${open === item.href ? "text-text-primary bg-white/[0.06]" : ""}`}
        >
          <Ellipsis className="w-3 h-3" />
        </button>
      </div>
    );
  }

  const quickKey = "quick:end";
  return (
    <>
      <nav
        aria-label="Quick access"
        className="relative shrink-0 px-2 py-3 border-b border-border-subtle space-y-0.5"
        onDragOver={(e) => over(e, quickKey, (drag?.kind === "item" || drag?.kind === "pin") && pinned.length === 0)}
        onDragLeave={() => { if (drop?.key === quickKey) setDrop(null); }}
        onDrop={(e) => {
          if (drag?.kind !== "item" && drag?.kind !== "pin") return;
          e.preventDefault();
          dropOnQuick(null);
        }}
      >
        <p className="px-1.5 pb-1 text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary" title="Pinned pages also come first in the continuous scroll">
          Quick access
        </p>
        {pinned.map((item, i) => {
          const key = `pin:${item.href}`;
          return (
            <div key={item.href}>
              <div
                className={`group relative rounded-control ${drag?.kind === "pin" && drag.href === item.href ? "opacity-50" : ""}`}
                onDragOver={(e) => over(e, key, (drag?.kind === "pin" && drag.href !== item.href) || drag?.kind === "item")}
                onDragLeave={() => { if (drop?.key === key) setDrop(null); }}
                onDrop={(e) => {
                  if (drag?.kind !== "item" && drag?.kind !== "pin") return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (drop) dropOnQuick(drop.after ? pinned[i + 1]?.href ?? null : item.href);
                  else end();
                }}
              >
                {drop?.key === key && <Marker after={drop.after} />}
                {link(item, { kind: "pin", href: item.href })}
                {rowButtons(item, true)}
              </div>
              {options(item, {
                up: i > 0 ? () => movePinBy(item.href, -1) : null,
                down: i < pinned.length - 1 ? () => movePinBy(item.href, 1) : null,
              })}
            </div>
          );
        })}
        {pinned.length === 0 && (
          <div className="relative rounded-control border border-dashed border-border-hover px-3 py-2 text-[11px] text-text-tertiary">
            {drop?.key === quickKey && <Marker after={false} />}
            Nothing pinned. Pin a page, or drag it here.
          </div>
        )}
      </nav>

      <nav aria-label="All sections (rearranging)" className="flex-1 min-h-0 px-2 py-3 overflow-y-auto">
        <p className="px-2 pb-2 text-[11px] leading-snug text-text-tertiary">
          Drag pages within a section, or a section by its name. Pin puts a page in Quick access. The continuous scroll follows this order.
        </p>
        {sections.map((section, si) => {
          const key = `section:${section.index}`;
          return (
            <div
              key={section.index}
              className={`relative mb-3 last:mb-0 rounded-control outline-1 outline-dashed outline-border-hover outline-offset-2 ${
                drag?.kind === "section" && drag.index === section.index ? "opacity-50" : ""
              }`}
              onDragOver={(e) => over(e, key, drag?.kind === "section" && drag.index !== section.index)}
              onDragLeave={() => { if (drop?.key === key) setDrop(null); }}
              onDrop={(e) => {
                if (drag?.kind !== "section") return;
                e.preventDefault();
                if (drop) {
                  const target = drop.after ? sections[si + 1]?.index ?? null : section.index;
                  change((l) => moveNavSection(l, NAV_SECTIONS, drag.index, target), `${NAV_SECTIONS[drag.index]?.title ?? "Section"} moved.`);
                }
                end();
              }}
            >
              {drop?.key === key && <Marker after={drop.after} />}
              <div className="group flex items-center">
                <p
                  draggable
                  onDragStart={(e) => startDrag(e, { kind: "section", index: section.index }, section.title)}
                  onDragEnd={end}
                  title="Drag to move this section"
                  className="flex flex-1 items-center gap-1 px-1.5 pb-1 pt-1 text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary cursor-grab active:cursor-grabbing"
                >
                  <GripVertical aria-hidden className="w-3 h-3" />
                  {section.title}
                </p>
                <button type="button" aria-label={`Move ${section.title} up`} disabled={si === 0} onClick={() => moveSectionBy(section.index, -1, shownSection)} className={tiny}>
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${section.title} down`}
                  disabled={si === sections.length - 1}
                  onClick={() => moveSectionBy(section.index, 1, shownSection)}
                  className={`${tiny} mr-1`}
                >
                  <ArrowDown className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-0.5">
                {section.items.map((item, ii) => {
                  const ikey = `item:${item.href}`;
                  return (
                    <div key={item.href}>
                      <div
                        className={`group relative rounded-control ${drag?.kind === "item" && drag.href === item.href ? "opacity-50" : ""}`}
                        onDragOver={(e) => over(e, ikey, drag?.kind === "item" && drag.section === section.index && drag.href !== item.href)}
                        onDragLeave={() => { if (drop?.key === ikey) setDrop(null); }}
                        onDrop={(e) => {
                          if (drag?.kind !== "item") return; // a section drop is the section's
                          e.preventDefault();
                          e.stopPropagation();
                          if (drag.section === section.index && drop) {
                            const before = drop.after ? section.items[ii + 1]?.href ?? null : item.href;
                            change((l) => moveNavItem(l, NAV_SECTIONS, drag.href, before), `${labelOf(drag.href)} moved.`);
                          }
                          end();
                        }}
                      >
                        {drop?.key === ikey && <Marker after={drop.after} />}
                        {link(item, { kind: "item", href: item.href, section: section.index })}
                        {rowButtons(item, false)}
                      </div>
                      {options(item, {
                        up: ii > 0 ? () => moveItemBy(item.href, -1, shownItem) : null,
                        down: ii < section.items.length - 1 ? () => moveItemBy(item.href, 1, shownItem) : null,
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            aria-expanded={showHidden}
            className="w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-control text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary hover:text-text-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {showHidden ? <ChevronDown className="w-3 h-3" aria-hidden /> : <ChevronRight className="w-3 h-3" aria-hidden />}
            Show hidden ({hidden.length})
          </button>
          {showHidden && (
            <div className="space-y-0.5">
              {hidden.length === 0 && <p className="px-2 py-1 text-[11px] text-text-tertiary">No hidden pages. Use ⋯ on a page to hide it.</p>}
              {hidden.map((item) => {
                const scrollOff = offScroll(item.href);
                return (
                  <div key={item.href} className="relative rounded-control opacity-80">
                    {link(item, null)}
                    <div className="absolute right-1 top-1/2 flex -translate-y-1/2">
                      <button
                        type="button"
                        aria-label={`Show ${item.label} in navigation`}
                        title="Show in navigation"
                        onClick={() => hideFromNav(item.href, false)}
                        className={tiny}
                      >
                        <Eye className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={scrollOff ? `Show ${item.label} in the scroll` : `Hide ${item.label} from the scroll`}
                        aria-pressed={scrollOff}
                        title={scrollOff ? "Show in the scroll" : "Hide from scroll"}
                        onClick={() => hideFromScroll(item.href, !scrollOff)}
                        className={`${tiny} ${scrollOff ? "text-accent" : ""}`}
                      >
                        <ListX className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </nav>
    </>
  );
}

const big =
  "w-11 h-11 shrink-0 flex items-center justify-center rounded-control text-text-secondary hover:text-text-primary hover:bg-white/[0.05] disabled:opacity-30";
const toggle =
  "min-h-11 flex flex-1 items-center justify-center gap-1.5 rounded-control border px-2 text-[12px] leading-tight";

/** The phone bottom bar's four slots around Log (Personalize, drawer). */
function TabSlotChooser({ saved }: { saved: string[] | null }) {
  const byHref = new Map(NAV_ITEMS.map((i) => [i.href, i] as const));
  const byId = new Map(NAV_ITEMS.map((i) => [areaId(i.href), i.href] as const));
  const exists = (href: string) => byHref.has(href);
  const savedHrefs = saved ? saved.map((id) => (id === MORE_SLOT ? MORE_SLOT : byId.get(id) ?? null)) : null;
  const slots = tabSlots(savedHrefs, exists);
  const name = (v: string) => (v === MORE_SLOT ? "More" : tabLabel(byHref.get(v) ?? { href: v, label: v }));
  const choose = (slot: number, value: string) => {
    const next = chooseTab(slots, slot, value);
    change((l) => setTabSlots(l, next, DEFAULT_TAB_SLOTS), `Bottom bar: ${name(value)} in slot ${slot + 1}.`);
  };
  const preview = [...slots.slice(0, 2).map((v, i) => ({ v, i })), null, ...slots.slice(2).map((v, i) => ({ v, i: i + 2 }))];
  return (
    <div className="mb-3 rounded-control border border-dashed border-border-hover p-2" role="group" aria-label="Bottom bar">
      <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary">Bottom bar</p>
      <div className="mb-2 grid grid-cols-5 rounded-control border border-border-subtle bg-surface-sunken py-1.5" aria-hidden="true">
        {preview.map((cell, k) => {
          if (!cell) {
            return (
              <span key="log" className="flex flex-col items-center gap-0.5 text-[10px] text-text-primary">
                <span className="w-6 h-6 rounded-full bg-accent text-on-accent flex items-center justify-center">
                  <Plus className="w-3.5 h-3.5" strokeWidth={2.25} />
                </span>
                Log
              </span>
            );
          }
          const item = byHref.get(cell.v);
          const Icon = item?.icon;
          return (
            <span key={k} className="flex flex-col items-center gap-0.5 truncate px-0.5 text-[10px] text-text-secondary">
              {Icon ? <Icon className="w-[18px] h-[18px]" strokeWidth={1.75} /> : <Ellipsis className="w-[18px] h-[18px]" />}
              <span className="max-w-full truncate">{name(cell.v)}</span>
            </span>
          );
        })}
      </div>
      {slots.map((value, slot) => (
        <label key={slot} className="flex min-h-11 items-center gap-2 px-1 text-[12px] text-text-secondary">
          <span className="w-16 shrink-0">{slot < 2 ? `Left ${slot + 1}` : `Right ${slot - 1}`}</span>
          <select
            value={value}
            aria-label={slot < 2 ? `Left ${slot + 1}` : `Right ${slot - 1}`}
            onChange={(e) => choose(slot, e.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-control border border-border-subtle bg-surface-card px-2 text-[13px] text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <option value={MORE_SLOT}>More (the menu)</option>
            {NAV_SECTIONS.map((section) => (
              <optgroup key={section.title} label={section.title}>
                {section.items.map((item) => (
                  <option key={item.href} value={item.href}>{item.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      ))}
      {!slots.includes(MORE_SLOT) && <p className="px-1 pt-1 text-[11px] text-text-tertiary">More is off the bar: the menu opens from the ☰ button at the top.</p>}
    </div>
  );
}

/** The phone drawer while personalizing: the bottom bar, Quick access, the pages (up / down, pin, hide), hidden pages. */
export function DrawerArranger() {
  const { pinned, sections, hidden, offScroll, tabs } = useArranged();
  const [open, setOpen] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const pinnedHrefs = pinned.map((i) => i.href);
  const hiddenHrefs = new Set(hidden.map((i) => i.href));
  const shownSection = (i: number) => sections.some((s) => s.index === i);
  const shownItem = (h: string) => !pinnedHrefs.includes(h) && !hiddenHrefs.has(h);

  function toggles(item: NavItem) {
    if (open !== item.href) return null;
    const pinnedNow = pinnedHrefs.includes(item.href);
    const scrollOff = offScroll(item.href);
    return (
      <div className="flex gap-1 px-1 pb-1" role="group" aria-label={`${item.label} options`}>
        <button
          type="button"
          aria-pressed={pinnedNow}
          onClick={() => pin(item.href, !pinnedNow)}
          className={`${toggle} ${pinnedNow ? "border-accent text-accent" : "border-border-subtle text-text-secondary"}`}
        >
          {pinnedNow ? <PinOff aria-hidden className="w-3.5 h-3.5" /> : <Pin aria-hidden className="w-3.5 h-3.5" />}
          {pinnedNow ? "Unpin" : "Pin"}
        </button>
        <button
          type="button"
          onClick={() => { hideFromNav(item.href, true); setOpen(null); }}
          className={`${toggle} border-border-subtle text-text-secondary`}
        >
          <EyeOff aria-hidden className="w-3.5 h-3.5" /> Hide from nav
        </button>
        <button
          type="button"
          aria-pressed={scrollOff}
          disabled={isFeedExcluded(item.href)}
          onClick={() => hideFromScroll(item.href, !scrollOff)}
          className={`${toggle} disabled:opacity-40 ${scrollOff ? "border-accent text-accent" : "border-border-subtle text-text-secondary"}`}
        >
          <ListX aria-hidden className="w-3.5 h-3.5" /> {isFeedExcluded(item.href) ? "Never in scroll" : scrollOff ? "Not in scroll" : "Hide from scroll"}
        </button>
      </div>
    );
  }

  function row(item: NavItem, up: (() => void) | null, down: (() => void) | null) {
    const Icon = item.icon;
    return (
      <div key={item.href} className="rounded-control hover:bg-white/[0.03]">
        <div className="flex items-center gap-2 pl-3">
          <Icon aria-hidden className="w-[17px] h-[17px] shrink-0 text-text-tertiary" strokeWidth={1.75} />
          <span className="flex-1 truncate text-[13px] text-text-secondary">{item.label}</span>
          {offScroll(item.href) && <ListX aria-label="Not in the scroll" className="w-3.5 h-3.5 shrink-0 text-text-tertiary" />}
          <button
            type="button"
            aria-label={`${item.label} options`}
            aria-expanded={open === item.href}
            onClick={() => setOpen((o) => (o === item.href ? null : item.href))}
            className={big}
          >
            <Ellipsis className="w-4 h-4" />
          </button>
          <button type="button" aria-label={`Move ${item.label} up`} disabled={!up} onClick={() => up?.()} className={big}>
            <ArrowUp className="w-4 h-4" />
          </button>
          <button type="button" aria-label={`Move ${item.label} down`} disabled={!down} onClick={() => down?.()} className={big}>
            <ArrowDown className="w-4 h-4" />
          </button>
        </div>
        {toggles(item)}
      </div>
    );
  }

  return (
    // data-pz-arranger: where the banner puts focus when Personalize starts inside the open drawer (banner-focus.ts).
    <div data-pz-arranger="" className="flex-1 overflow-y-auto px-2 py-3">
      <div className="mb-3 flex items-center gap-2 rounded-control border border-dashed border-border-emphasis bg-surface-raised/60 px-3 py-2">
        <p className="flex-1 text-[12px] leading-snug text-text-secondary">Reorder, pin and hide pages, and choose the bottom bar. The scroll follows this order.</p>
        <button type="button" onClick={() => endEdit(false)} className="min-h-11 rounded-control px-2 text-[12px] text-text-secondary hover:text-text-primary">
          Cancel
        </button>
        <button type="button" onClick={() => endEdit(true)} className="min-h-11 rounded-full bg-accent px-4 text-[12px] font-semibold text-on-accent">
          Done
        </button>
      </div>

      <TabSlotChooser saved={tabs} />

      <div className="mb-3 rounded-control border border-dashed border-border-hover p-1">
        <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary">Quick access · first in the scroll</p>
        {pinned.length === 0 && <p className="px-3 pb-2 text-[12px] text-text-tertiary">Nothing pinned. Use ⋯ on a page, then Pin.</p>}
        {pinned.map((item, i) =>
          row(item, i > 0 ? () => movePinBy(item.href, -1) : null, i < pinned.length - 1 ? () => movePinBy(item.href, 1) : null),
        )}
      </div>

      {sections.map((section, si) => (
        <div key={section.index} className="mb-3 last:mb-0 rounded-control border border-dashed border-border-hover p-1">
          <div className="flex items-center">
            <p className="flex-1 px-2 text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary">{section.title}</p>
            <button type="button" aria-label={`Move ${section.title} up`} disabled={si === 0} onClick={() => moveSectionBy(section.index, -1, shownSection)} className={big}>
              <ArrowUp className="w-4 h-4" />
            </button>
            <button
              type="button"
              aria-label={`Move ${section.title} down`}
              disabled={si === sections.length - 1}
              onClick={() => moveSectionBy(section.index, 1, shownSection)}
              className={big}
            >
              <ArrowDown className="w-4 h-4" />
            </button>
          </div>
          {section.items.map((item, ii) =>
            row(
              item,
              ii > 0 ? () => moveItemBy(item.href, -1, shownItem) : null,
              ii < section.items.length - 1 ? () => moveItemBy(item.href, 1, shownItem) : null,
            ),
          )}
        </div>
      ))}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowHidden((v) => !v)}
          aria-expanded={showHidden}
          className="min-h-11 w-full flex items-center gap-1.5 px-2 rounded-control text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary hover:text-text-secondary"
        >
          {showHidden ? <ChevronDown className="w-3 h-3" aria-hidden /> : <ChevronRight className="w-3 h-3" aria-hidden />}
          Show hidden ({hidden.length})
        </button>
        {showHidden && (
          <div className="rounded-control border border-dashed border-border-hover p-1">
            {hidden.length === 0 && <p className="px-3 py-2 text-[12px] text-text-tertiary">No hidden pages. Use ⋯ on a page, then Hide from nav.</p>}
            {hidden.map((item) => {
              const Icon = item.icon;
              const scrollOff = offScroll(item.href);
              return (
                <div key={item.href} className="flex items-center gap-2 pl-3 opacity-80">
                  <Icon aria-hidden className="w-[17px] h-[17px] shrink-0 text-text-tertiary" strokeWidth={1.75} />
                  <span className="flex-1 truncate text-[13px] text-text-secondary">{item.label}</span>
                  <button type="button" aria-label={`Show ${item.label} in navigation`} onClick={() => hideFromNav(item.href, false)} className={big}>
                    <Eye className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={scrollOff ? `Show ${item.label} in the scroll` : `Hide ${item.label} from the scroll`}
                    aria-pressed={scrollOff}
                    onClick={() => hideFromScroll(item.href, !scrollOff)}
                    className={`${big} ${scrollOff ? "text-accent" : ""}`}
                  >
                    <ListX className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
