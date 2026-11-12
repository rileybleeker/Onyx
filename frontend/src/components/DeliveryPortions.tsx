"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDeliveryItemsForDay, type DeliveryDish } from "@/lib/queries";
import { PORTION_OPTIONS, dayKcal, dishKcal, selectedPortion } from "@/lib/delivery-portion";
import { sameJson } from "@/lib/format";

// Uber Eats dishes for one behavioral day + the one-tap "Ate: All / 3/4 / 1/2 / 1/4 / None" control.
// Shared by /nutrition (Today's Meals) and /check-in. Each tap saves on its own through
// PATCH /api/delivery/items/[itemId]: the kcal shown change at once (optimistic) and go back, with a
// message, if the save fails. Per-dish sequence numbers stop a slow earlier response from undoing a
// later tap (same guard as setAnswer on /habits).

export function useDeliveryDishes(date: string | null, onSaved?: () => void) {
  const [state, setState] = useState<{ date: string | null; items: DeliveryDish[] }>({ date: null, items: [] });
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(new Map<number, number>());

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    getDeliveryItemsForDay(date)
      .then((rows) => {
        if (cancelled) return;
        setState((prev) => (prev.date === date && sameJson(prev.items, rows) ? prev : { date, items: rows }));
      })
      .catch((e) => {
        console.error("Uber Eats dishes:", e);
        if (!cancelled) setState((prev) => (prev.date === date ? prev : { date, items: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  const apply = useCallback(
    (itemId: number, fraction: number | null) =>
      setState((prev) => ({
        ...prev,
        items: prev.items.map((i) =>
          i.item_id === itemId ? { ...i, eaten_fraction: fraction, est_kcal: dishKcal(i.unit_kcal, i.quantity, fraction) } : i,
        ),
      })),
    [],
  );

  const setFraction = useCallback(
    async (dish: DeliveryDish, fraction: number | null) => {
      if (dish.eaten_fraction === fraction) return;
      const previous = dish.eaten_fraction;
      const n = (seq.current.get(dish.item_id) ?? 0) + 1;
      seq.current.set(dish.item_id, n);
      setError(null);
      apply(dish.item_id, fraction);
      try {
        const res = await fetch(`/api/delivery/items/${dish.item_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eaten_fraction: fraction }),
        });
        if (seq.current.get(dish.item_id) !== n) return;
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          apply(dish.item_id, previous);
          setError(j.error ? `Not saved: ${j.error}` : `Not saved (${res.status}).`);
          return;
        }
        onSaved?.();
      } catch {
        if (seq.current.get(dish.item_id) !== n) return;
        apply(dish.item_id, previous);
        setError("Network error: the portion was not saved.");
      }
    },
    [apply, onSaved],
  );

  const items = state.date === date ? state.items : [];
  return { items, loaded: state.date === date, error, setFraction, totalKcal: dayKcal(items) };
}

function timeOf(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : "—";
}

export function PortionControl({ dish, onPick }: { dish: DeliveryDish; onPick: (fraction: number) => void }) {
  const current = selectedPortion(dish.eaten_fraction);
  const assumed = dish.eaten_fraction == null;
  return (
    <div className="flex items-center gap-1" role="group" aria-label={`How much of ${dish.title} you ate`}>
      <span className="text-[10px] font-mono text-text-tertiary mr-0.5">Ate</span>
      {PORTION_OPTIONS.map((o) => {
        const on = current === o.value;
        return (
          <button
            key={o.label}
            type="button"
            onClick={() => onPick(o.value)}
            aria-pressed={on}
            title={on && assumed ? "Assumed (not set yet). Tap to confirm." : undefined}
            className={`h-7 min-w-[2.25rem] px-1.5 rounded-[5px] border text-[11px] font-mono transition-colors ${
              on
                ? assumed
                  ? "border-dashed border-accent/50 text-accent/80 bg-accent/5"
                  : "border-accent/70 bg-accent/20 text-accent"
                : "border-border-subtle text-text-tertiary hover:text-text-secondary"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function DeliveryDishList({
  items,
  onPick,
  className = "",
}: {
  items: DeliveryDish[];
  onPick: (dish: DeliveryDish, fraction: number) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={`bg-surface-card border border-border-subtle rounded-[6px] divide-y divide-border-subtle ${className}`}>
      {items.map((d) => (
        <div key={d.item_id} className="px-4 py-2.5 text-sm">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-text-tertiary w-20 shrink-0">{timeOf(d.completed_at)}</span>
            <span className="flex-1 min-w-0 truncate text-text-secondary">
              {d.title}
              <span className="text-text-tertiary"> · {d.store_name}</span>
            </span>
            <span className="text-[11px] font-mono text-text-tertiary shrink-0">{d.quantity > 1 ? `×${d.quantity} ` : ""}UBER EATS</span>
            <span className="text-[11px] font-mono text-text-tertiary w-16 text-right shrink-0">
              {d.est_kcal != null ? `~${Math.round(d.est_kcal)} kcal` : "—"}
            </span>
          </div>
          <div className="mt-1.5 flex justify-end">
            <PortionControl dish={d} onPick={(f) => onPick(d, f)} />
          </div>
        </div>
      ))}
    </div>
  );
}
