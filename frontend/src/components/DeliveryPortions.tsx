"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDeliveryItemsForDays, type DeliveryDish } from "@/lib/queries";
import {
  PORTION_OPTIONS,
  checkinDishGroups,
  createPortionSaver,
  dayKcal,
  dishKcal,
  groupDishesByDay,
  selectedPortion,
  shiftYmd,
} from "@/lib/delivery-portion";
import { sameJson } from "@/lib/format";

// Uber Eats dishes + the one-tap "Ate: All / 3/4 / 1/2 / 1/4 / None" control.
// Shared by /nutrition (Today's Meals, one day) and /check-in (the checked-in day plus earlier days'
// dishes whose portion was never set: the harvester runs every 6 h, so a late dinner usually lands after
// that evening's check-in). Each tap saves on its own through PATCH /api/delivery/items/[itemId]: the
// kcal shown change at once (optimistic). Writes are serialized per dish (createPortionSaver), and a
// failed save goes back to the last value the server confirmed, with a message.

export type DishGroup = { date: string; items: DeliveryDish[]; totalKcal: number | null };

type Opts = {
  /** Also fetch this many days before `date` and keep their dishes whose portion is still unset. */
  earlierDays?: number;
  /** Called after each successful save (e.g. to refresh charts). The latest callback is used. */
  onSaved?: () => void;
};

async function sendPortion(itemId: number, fraction: number | null) {
  const res = await fetch(`/api/delivery/items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eaten_fraction: fraction }),
  });
  if (res.ok) return { ok: true as const };
  const j = await res.json().catch(() => ({}));
  return { ok: false as const, error: j?.error ? `Not saved: ${j.error}` : `Not saved (${res.status}).` };
}

export function useDeliveryDishes(date: string | null, opts: Opts = {}) {
  const earlierDays = opts.earlierDays ?? 0;
  const key = date ? `${date}|${earlierDays}` : null;
  const [state, setState] = useState<{ key: string | null; items: DeliveryDish[]; loadError: string | null }>({
    key: null,
    items: [],
    loadError: null,
  });
  const [error, setError] = useState<string | null>(null);

  const onSavedRef = useRef(opts.onSaved);
  useEffect(() => {
    onSavedRef.current = opts.onSaved;
  }, [opts.onSaved]);
  // Days currently on screen, and each loaded dish's day: a save error for a dish no longer shown is dropped.
  const shownDays = useRef<Set<string>>(new Set());
  const dishDay = useRef(new Map<number, string>());

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

  const [saver] = useState(() =>
    createPortionSaver({
      send: sendPortion,
      apply,
      onError: (itemId, message) => {
        const day = dishDay.current.get(itemId);
        if (day && shownDays.current.has(day)) setError(message);
      },
      onSaved: () => onSavedRef.current?.(),
    }),
  );

  useEffect(() => {
    setError(null);
    if (!date || !key) {
      shownDays.current = new Set();
      return;
    }
    const days = Array.from({ length: earlierDays + 1 }, (_, i) => shiftYmd(date, -i));
    shownDays.current = new Set(days);
    let cancelled = false;
    getDeliveryItemsForDays(days)
      .then((rows) => {
        if (cancelled) return;
        // Which dishes are shown is decided here, once per load: the day's dishes plus earlier days' dishes
        // still unset, so an earlier dish stays on screen after Riley taps it.
        const kept = checkinDishGroups(rows, date).flatMap((g) => g.items);
        // Dishes with a save still in flight keep the value on screen, not the (older) loaded one.
        const seeded = kept.map((r) => {
          dishDay.current.set(r.item_id, r.behavioral_date);
          const shown = saver.seed(r.item_id, r.eaten_fraction);
          return shown === r.eaten_fraction ? r : { ...r, eaten_fraction: shown, est_kcal: dishKcal(r.unit_kcal, r.quantity, shown) };
        });
        setState((prev) =>
          prev.key === key && !prev.loadError && sameJson(prev.items, seeded) ? prev : { key, items: seeded, loadError: null },
        );
      })
      .catch((e) => {
        console.error("Uber Eats dishes:", e);
        if (!cancelled) setState({ key, items: [], loadError: "Couldn't load Uber Eats dishes." });
      });
    return () => {
      cancelled = true;
    };
  }, [date, key, earlierDays, saver]);

  const setFraction = useCallback(
    (dish: DeliveryDish, fraction: number | null) => {
      setError(null);
      void saver.set(dish.item_id, fraction);
    },
    [saver],
  );

  const loaded = state.key === key && key != null;
  const all = useMemo(() => (loaded ? state.items : []), [loaded, state.items]);
  const groups: DishGroup[] = useMemo(
    () => (date ? groupDishesByDay(all, date).map((g) => ({ ...g, totalKcal: dayKcal(g.items) })) : []),
    [date, all],
  );
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  return {
    items,
    groups,
    loaded,
    loadError: loaded ? state.loadError : null,
    error,
    setFraction,
    totalKcal: dayKcal(items),
  };
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
          <div className="flex items-start gap-2">
            <span className="text-[11px] font-mono text-text-tertiary w-14 shrink-0 pt-0.5">{timeOf(d.completed_at)}</span>
            <div className="flex-1 min-w-0">
              {/* Full dish name (up to two lines): similar dishes in one order must be told apart. */}
              <div className="text-text-secondary line-clamp-2 break-words">
                {d.title}
                {d.quantity > 1 && <span className="text-[11px] font-mono text-text-tertiary"> ×{d.quantity}</span>}
              </div>
              <div className="text-[11px] text-text-tertiary truncate">{d.store_name}</div>
            </div>
            <span className="text-[11px] font-mono text-text-tertiary w-16 text-right shrink-0 pt-0.5">
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
