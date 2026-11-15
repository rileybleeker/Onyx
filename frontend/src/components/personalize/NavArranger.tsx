"use client";

import { useState, useSyncExternalStore, type DragEvent, type MouseEvent } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { NAV_SECTIONS, type NavItem } from "@/lib/nav";
import { goHint } from "@/lib/go-shortcuts";
import { AREAS_KEY, QUICK_ACCESS, orderNav } from "@/lib/nav-areas";
import { moveNavItem, moveNavItemBy, moveNavSection, moveNavSectionBy } from "@/lib/nav-arrange";
import { EMPTY_LAYOUT } from "@/lib/personalize-layout";
import { endEdit, layoutSnapshot, subscribe, updateDraftFor } from "@/lib/personalize-store";
import { announce } from "./editor-shared";

/**
 * Personalize mode for the side panel (desktop sidebar) and the phone drawer. Rearranging writes the app's area
 * order (`layout.areas`), which the continuous scroll follows too; saved with the page's changes on Done.
 * Desktop: drag an item within its section, or a section by its name, with an accent line where it lands
 * (plus up / down buttons for the keyboard). Phone: up / down buttons, 44 px.
 */

type Drag = { kind: "item"; href: string; section: number } | { kind: "section"; index: number };
const DRAG_TYPE = "application/x-onyx-area";
const quick = new Set(QUICK_ACCESS);

function useAreasDraft() {
  return useSyncExternalStore(subscribe, () => layoutSnapshot(AREAS_KEY), () => EMPTY_LAYOUT);
}

function useOrdered() {
  const layout = useAreasDraft();
  const saved = layout.grids?.main?.order ?? null;
  return orderNav(NAV_SECTIONS, saved && saved.length ? saved : null);
}

const labelOf = (href: string) => NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.href === href)?.label ?? href;

function moveItemBy(href: string, delta: number, shown?: (href: string) => boolean) {
  updateDraftFor(AREAS_KEY, (l) => moveNavItemBy(l, NAV_SECTIONS, href, delta, shown));
  announce(`${labelOf(href)} moved ${delta < 0 ? "up" : "down"}.`);
}

function moveSectionBy(index: number, delta: number, shown?: (index: number) => boolean) {
  updateDraftFor(AREAS_KEY, (l) => moveNavSectionBy(l, NAV_SECTIONS, index, delta, shown));
  announce(`${NAV_SECTIONS[index]?.title ?? "Section"} moved ${delta < 0 ? "up" : "down"}.`);
}

/** Navigation stays possible with Ctrl / Cmd + click (BC); a plain click while arranging does nothing. */
function holdClick(e: MouseEvent) {
  if (!e.ctrlKey && !e.metaKey) e.preventDefault();
}

const tiny =
  "w-6 h-6 flex items-center justify-center rounded-control text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:invisible";

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
  const ordered = useOrdered();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(null);
  const pinned = QUICK_ACCESS.flatMap((h) => NAV_SECTIONS.flatMap((s) => s.items).filter((i) => i.href === h));
  const sections = ordered.map((s) => ({ ...s, items: s.items.filter((i) => !quick.has(i.href)) })).filter((s) => s.items.length > 0);
  const shownSection = (i: number) => sections.some((s) => s.index === i);
  const shownItem = (h: string) => !quick.has(h);

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

  function link(item: NavItem, draggableItem: boolean) {
    const active = current === item.href;
    const Icon = item.icon;
    return (
      <Link
        href={item.href}
        onClick={holdClick}
        draggable={draggableItem}
        onDragStart={draggableItem ? (e) => {
          e.dataTransfer.setData(DRAG_TYPE, item.href);
          e.dataTransfer.effectAllowed = "move";
          const sec = sections.find((s) => s.items.some((i) => i.href === item.href));
          setDrag({ kind: "item", href: item.href, section: sec?.index ?? -1 });
        } : undefined}
        onDragEnd={end}
        title={draggableItem ? "Drag to move (Ctrl + click opens the page)" : "Ctrl + click opens the page"}
        className={`flex items-center gap-2 pl-1.5 pr-14 py-2 rounded-control text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          draggableItem ? "cursor-grab active:cursor-grabbing" : ""
        } ${active ? "bg-surface-raised text-text-primary" : "text-text-secondary hover:text-text-primary hover:bg-white/[0.03]"}`}
      >
        {draggableItem ? <GripVertical aria-hidden className="w-3.5 h-3.5 shrink-0 text-text-tertiary" /> : <span className="w-3.5 shrink-0" />}
        <Icon className={`w-[17px] h-[17px] shrink-0 ${active ? "text-accent" : "text-text-tertiary"}`} strokeWidth={1.75} />
        <span className="flex-1 truncate">{item.label}</span>
        <kbd className="sr-only">{goHint(item.shortcut)}</kbd>
      </Link>
    );
  }

  return (
    <>
      <nav aria-label="Quick access" className="shrink-0 px-2 py-3 border-b border-border-subtle space-y-0.5">
        {pinned.map((item) => (
          <div key={item.href} className="relative">{link(item, false)}</div>
        ))}
      </nav>

      <nav aria-label="All sections (rearranging)" className="flex-1 min-h-0 px-2 py-3 overflow-y-auto">
        <p className="px-2 pb-2 text-[11px] leading-snug text-text-tertiary">
          Drag pages within a section, or a section by its name. The continuous scroll follows this order.
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
                  updateDraftFor(AREAS_KEY, (l) => moveNavSection(l, NAV_SECTIONS, drag.index, target));
                  announce(`${NAV_SECTIONS[drag.index]?.title ?? "Section"} moved.`);
                }
                end();
              }}
            >
              {drop?.key === key && <Marker after={drop.after} />}
              <div className="group flex items-center">
                <p
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, section.title);
                    e.dataTransfer.effectAllowed = "move";
                    setDrag({ kind: "section", index: section.index });
                  }}
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
                    <div
                      key={item.href}
                      className={`group relative rounded-control ${drag?.kind === "item" && drag.href === item.href ? "opacity-50" : ""}`}
                      onDragOver={(e) => over(e, ikey, drag?.kind === "item" && drag.section === section.index && drag.href !== item.href)}
                      onDragLeave={() => { if (drop?.key === ikey) setDrop(null); }}
                      onDrop={(e) => {
                        if (drag?.kind !== "item") return; // a section drop is the section's
                        e.preventDefault();
                        e.stopPropagation();
                        if (drag.section === section.index && drop) {
                          const before = drop.after ? section.items[ii + 1]?.href ?? null : item.href;
                          updateDraftFor(AREAS_KEY, (l) => moveNavItem(l, NAV_SECTIONS, drag.href, before));
                          announce(`${labelOf(drag.href)} moved.`);
                        }
                        end();
                      }}
                    >
                      {drop?.key === ikey && <Marker after={drop.after} />}
                      {link(item, true)}
                      <div className="absolute right-1 top-1/2 flex -translate-y-1/2">
                        <button type="button" aria-label={`Move ${item.label} up`} disabled={ii === 0} onClick={() => moveItemBy(item.href, -1, shownItem)} className={tiny}>
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${item.label} down`}
                          disabled={ii === section.items.length - 1}
                          onClick={() => moveItemBy(item.href, 1, shownItem)}
                          className={tiny}
                        >
                          <ArrowDown className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
    </>
  );
}

const big =
  "w-11 h-11 shrink-0 flex items-center justify-center rounded-control text-text-secondary hover:text-text-primary hover:bg-white/[0.05] disabled:opacity-30";

/** The phone drawer's page list while personalizing: up / down buttons for every page and section. */
export function DrawerArranger() {
  const ordered = useOrdered();
  return (
    <div className="flex-1 overflow-y-auto px-2 py-3">
      <div className="mb-3 flex items-center gap-2 rounded-control border border-dashed border-border-emphasis bg-surface-raised/60 px-3 py-2">
        <p className="flex-1 text-[12px] leading-snug text-text-secondary">Reorder pages and sections. The scroll follows this order.</p>
        <button type="button" onClick={() => endEdit(false)} className="min-h-11 rounded-control px-2 text-[12px] text-text-secondary hover:text-text-primary">
          Cancel
        </button>
        <button type="button" onClick={() => endEdit(true)} className="min-h-11 rounded-full bg-accent px-4 text-[12px] font-semibold text-on-accent">
          Done
        </button>
      </div>
      {ordered.map((section, si) => (
        <div key={section.index} className="mb-3 last:mb-0 rounded-control border border-dashed border-border-hover p-1">
          <div className="flex items-center">
            <p className="flex-1 px-2 text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary">{section.title}</p>
            <button type="button" aria-label={`Move ${section.title} up`} disabled={si === 0} onClick={() => moveSectionBy(section.index, -1)} className={big}>
              <ArrowUp className="w-4 h-4" />
            </button>
            <button type="button" aria-label={`Move ${section.title} down`} disabled={si === ordered.length - 1} onClick={() => moveSectionBy(section.index, 1)} className={big}>
              <ArrowDown className="w-4 h-4" />
            </button>
          </div>
          {section.items.map((item, ii) => {
            const Icon = item.icon;
            return (
              <div key={item.href} className="flex items-center gap-2 rounded-control pl-3 hover:bg-white/[0.03]">
                <Icon aria-hidden className="w-[17px] h-[17px] shrink-0 text-text-tertiary" strokeWidth={1.75} />
                <span className="flex-1 truncate text-[13px] text-text-secondary">{item.label}</span>
                <button type="button" aria-label={`Move ${item.label} up`} disabled={ii === 0} onClick={() => moveItemBy(item.href, -1)} className={big}>
                  <ArrowUp className="w-4 h-4" />
                </button>
                <button type="button" aria-label={`Move ${item.label} down`} disabled={ii === section.items.length - 1} onClick={() => moveItemBy(item.href, 1)} className={big}>
                  <ArrowDown className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
