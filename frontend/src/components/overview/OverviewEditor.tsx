"use client";

import { useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, type LucideIcon } from "lucide-react";
import { defaultArrangement, isDefaultArrangement, moveBy, moveTo, setHidden, visibleIds, type Arrangement } from "@/lib/overview-cards";
import styles from "./Overview.module.css";

/**
 * Edit mode of the overview: reorder, show and hide cards. Self-contained (one component, a draft of the
 * arrangement, Done / Reset to default / Cancel), so it can move onto a shared Personalize framework later
 * without touching the cards. Desktop: drag a row by its grip, with an accent insertion marker where it will
 * land. Phone (and keyboard): the up / down buttons, 44 px targets. Nothing is saved until Done.
 */

const btn = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30 disabled:hover:bg-transparent";

export interface EditorCard { title: string; icon: LucideIcon }

export default function OverviewEditor({ initial, cards, onDone, onCancel }: {
  initial: Arrangement;
  cards: Record<string, EditorCard>;
  onDone: (next: Arrangement) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Arrangement>(initial);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [said, setSaid] = useState("");
  const n = draft.order.length;
  const shown = visibleIds(draft).length;
  const from = dragId ? draft.order.indexOf(dragId) : -1;
  // A drop that would leave the card where it is shows no marker.
  const marker = dropAt !== null && from !== -1 && dropAt !== from && dropAt !== from + 1 ? dropAt : null;

  function announce(next: Arrangement, id: string) {
    setSaid(`${cards[id]?.title ?? id}: position ${next.order.indexOf(id) + 1} of ${next.order.length}.`);
  }
  function move(id: string, delta: number) {
    const next = moveBy(draft, id, delta);
    setDraft(next);
    announce(next, id);
  }
  function toggle(id: string) {
    const hide = !draft.hidden.includes(id);
    setDraft(setHidden(draft, id, hide));
    setSaid(`${cards[id]?.title ?? id} ${hide ? "hidden" : "shown"}.`);
  }
  function over(e: DragEvent<HTMLLIElement>, i: number) {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const at = e.clientY < rect.top + rect.height / 2 ? i : i + 1;
    if (at !== dropAt) setDropAt(at);
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    if (dragId && marker !== null) {
      const next = moveTo(draft, dragId, marker > from ? marker - 1 : marker);
      setDraft(next);
      announce(next, dragId);
    }
    setDragId(null);
    setDropAt(null);
  }

  return (
    <div role="region" aria-labelledby="overview-edit-heading" className="rounded-card border border-border-emphasis bg-surface-card p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 id="overview-edit-heading" className="text-base font-medium text-text-primary">Arrange the overview</h3>
          <p className="mt-1 text-xs text-text-secondary">
            {shown} of {n} cards shown. Drag a row by its grip, or use the arrows. Saved to your account on Done, so your phone and desktop match.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => { setDraft(defaultArrangement()); setSaid("Default order restored, every card shown. Press Done to keep it."); }}
            disabled={isDefaultArrangement(draft)} className={`${btn} px-3 text-sm`}>Reset to default</button>
          <button type="button" onClick={onCancel} className={`${btn} px-3 text-sm`}>Cancel</button>
          <button type="button" onClick={() => onDone(draft)} className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Done</button>
        </div>
      </div>
      <p aria-live="polite" className="sr-only">{said}</p>
      <ol aria-label="Overview cards, in order" className="mt-4 space-y-2" onDragOver={(e) => { if (dragId) e.preventDefault(); }} onDrop={drop}>
        {draft.order.map((id, i) => {
          const card = cards[id];
          if (!card) return null;
          const Icon = card.icon;
          const hidden = draft.hidden.includes(id);
          return (
            <li key={id} className={`${styles.row} flex items-center gap-1 rounded-control border border-border-subtle bg-surface-raised py-0.5 pl-1 pr-1`}
              data-dragging={dragId === id || undefined}
              data-drop={marker === i ? "before" : marker === n && i === n - 1 ? "after" : undefined}
              onDragOver={(e) => over(e, i)}>
              <span draggable aria-hidden="true" title="Drag to move"
                onDragStart={(e) => {
                  setDragId(id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", id);
                  const row = e.currentTarget.closest("li");
                  if (row) e.dataTransfer.setDragImage(row, 24, 22);
                }}
                onDragEnd={() => { setDragId(null); setDropAt(null); }}
                className={`${styles.grip} h-11 w-8 items-center justify-center text-text-tertiary hover:text-text-primary`}>
                <GripVertical className="h-4 w-4" />
              </span>
              <Icon aria-hidden="true" className={`ml-1 h-4 w-4 shrink-0 ${hidden ? "text-text-disabled" : "text-accent"}`} />
              <span className={`ml-2 min-w-0 flex-1 truncate text-sm ${hidden ? "text-text-tertiary line-through" : "text-text-primary"}`}>{card.title}</span>
              <button type="button" onClick={() => toggle(id)} aria-pressed={!hidden} aria-label={`${hidden ? "Show" : "Hide"} ${card.title}`} className={`${btn} gap-1.5 px-2 text-xs`}>
                {hidden ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
                <span className="hidden sm:inline">{hidden ? "Hidden" : "Shown"}</span>
              </button>
              <button type="button" onClick={() => move(id, -1)} disabled={i === 0} aria-label={`Move ${card.title} up`} className={btn}><ArrowUp aria-hidden="true" className="h-4 w-4" /></button>
              <button type="button" onClick={() => move(id, 1)} disabled={i === n - 1} aria-label={`Move ${card.title} down`} className={btn}><ArrowDown aria-hidden="true" className="h-4 w-4" /></button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
