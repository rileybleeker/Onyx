"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDeliveryItemsForDays, getDeliveryLeftovers, type DeliveryDish } from "@/lib/queries";
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
import {
  LEFTOVER_OPTIONS,
  LEFTOVER_WINDOW_DAYS,
  bodyForToken,
  formatShare,
  fractionOfToken,
  leftoverQuestions,
  optionOfToken,
  tokenForOption,
  tokenOfRow,
  type LeftoverRow,
  type LeftoverToken,
} from "@/lib/delivery-leftovers";
import { sameJson } from "@/lib/format";

// Uber Eats dishes + the one-tap "Ate: All / 3/4 / 1/2 / 1/4 / None" control.
// Shared by /nutrition (Today's Meals, one day) and /check-in (the checked-in day plus earlier days'
// dishes whose portion was never set: the harvester runs every 6 h, so a late dinner usually lands after
// that evening's check-in). Each tap saves on its own through PATCH /api/delivery/items/[itemId]: the
// kcal shown change at once (optimistic). Writes are serialized per dish (createPortionSaver), and a
// failed save goes back to the last value the server confirmed, with a message.
//
// Leftovers (2026-11-14): a dish of the 3 days before `date` whose delivery-day portion is below All is
// asked about again ("3/4 left. Ate: All / 3/4 / 1/2 / 1/4 · Not today · Threw out") through
// PUT /api/delivery/items/[itemId]/leftovers, saved the same way (one serialized slot per dish and day).
// Unanswered leftovers count as thrown out. A question appears as soon as the portion is set below All,
// also when that happens on this screen.

export type DishGroup = { date: string; items: DeliveryDish[]; totalKcal: number | null };

export type LeftoverQuestion = {
  dish: DeliveryDish;
  /** Share of the whole dish left for this day. */
  left: number;
  token: LeftoverToken;
  /** Lit option key, or null when not answered. */
  option: string | null;
  /** kcal eaten from this leftover on this day (null = not answered / nothing eaten / no estimate). */
  kcal: number | null;
};

type Opts = {
  /** Also fetch this many days before `date` and keep their dishes whose portion is still unset. */
  earlierDays?: number;
  /** Called after each successful save (e.g. to refresh charts). The latest callback is used. */
  onSaved?: () => void;
};

async function failure(res: Response) {
  const j = await res.json().catch(() => ({}));
  return { ok: false as const, error: j?.error ? `Not saved: ${j.error}` : `Not saved (${res.status}).` };
}

async function sendPortion(itemId: number, fraction: number | null) {
  const res = await fetch(`/api/delivery/items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eaten_fraction: fraction }),
  });
  return res.ok ? { ok: true as const } : failure(res);
}

const slot = (itemId: number, date: string) => `${itemId}|${date}`;
const unslot = (k: string) => {
  const [id, date] = k.split("|");
  return { itemId: Number(id), date };
};

async function sendLeftover(k: string, token: LeftoverToken) {
  const { itemId, date } = unslot(k);
  const res = await fetch(`/api/delivery/items/${itemId}/leftovers`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyForToken(date, token)),
  });
  return res.ok ? { ok: true as const } : failure(res);
}

/** rows with the (item, date) answer replaced by `token` (null = removed). */
function withToken(rows: ReadonlyArray<LeftoverRow>, itemId: number, date: string, token: LeftoverToken): LeftoverRow[] {
  const rest = rows.filter((r) => !(r.item_id === itemId && r.eaten_date === date));
  if (token == null) return rest;
  return [...rest, { item_id: itemId, eaten_date: date, fraction: fractionOfToken(token), threw_out: token === "out" }];
}

type State = {
  key: string | null;
  /** Every dish fetched (the day + the leftover window). */
  all: DeliveryDish[];
  /** Dishes the portion control is shown for (decided once per load). */
  keptIds: number[];
  leftovers: LeftoverRow[];
  loadError: string | null;
};

export function useDeliveryDishes(date: string | null, opts: Opts = {}) {
  const earlierDays = opts.earlierDays ?? 0;
  const span = Math.max(earlierDays, LEFTOVER_WINDOW_DAYS);
  const key = date ? `${date}|${earlierDays}` : null;
  const [state, setState] = useState<State>({ key: null, all: [], keptIds: [], leftovers: [], loadError: null });
  const [error, setError] = useState<string | null>(null);

  const onSavedRef = useRef(opts.onSaved);
  useEffect(() => {
    onSavedRef.current = opts.onSaved;
  }, [opts.onSaved]);
  // Days currently on screen, and each loaded dish's day: a save error for a dish no longer shown is dropped.
  const shownDays = useRef<Set<string>>(new Set());
  const dishDay = useRef(new Map<number, string>());
  const screenDate = useRef<string | null>(null);

  const apply = useCallback(
    (itemId: number, fraction: number | null) =>
      setState((prev) => ({
        ...prev,
        all: prev.all.map((i) =>
          i.item_id === itemId ? { ...i, eaten_fraction: fraction, est_kcal: dishKcal(i.unit_kcal, i.quantity, fraction) } : i,
        ),
      })),
    [],
  );

  const applyLeftover = useCallback((k: string, token: LeftoverToken) => {
    const { itemId, date: d } = unslot(k);
    setState((prev) => ({ ...prev, leftovers: withToken(prev.leftovers, itemId, d, token) }));
  }, []);

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

  const [leftoverSaver] = useState(() =>
    createPortionSaver<string, LeftoverToken>({
      send: sendLeftover,
      apply: applyLeftover,
      onError: (k, message) => {
        if (unslot(k).date === screenDate.current) setError(message);
      },
      onSaved: () => onSavedRef.current?.(),
    }),
  );

  useEffect(() => {
    setError(null);
    screenDate.current = date;
    if (!date || !key) {
      shownDays.current = new Set();
      return;
    }
    const days = Array.from({ length: span + 1 }, (_, i) => shiftYmd(date, -i));
    const firstAsked = shiftYmd(date, -earlierDays);
    shownDays.current = new Set(days.filter((d) => d >= firstAsked));
    let cancelled = false;
    (async () => {
      const rows = await getDeliveryItemsForDays(days);
      const stored = await getDeliveryLeftovers(rows.map((r) => r.item_id));
      return { rows, stored };
    })()
      .then(({ rows, stored }) => {
        if (cancelled) return;
        // Which dishes get the portion control is decided here, once per load: the day's dishes plus
        // earlier days' (within earlierDays) still unset, so an earlier dish stays on screen after a tap.
        const keptIds = checkinDishGroups(
          rows.filter((r) => r.behavioral_date >= firstAsked),
          date,
        ).flatMap((g) => g.items.map((i) => i.item_id));
        // Dishes with a save still in flight keep the value on screen, not the (older) loaded one.
        const all = rows.map((r) => {
          dishDay.current.set(r.item_id, r.behavioral_date);
          const shown = saver.seed(r.item_id, r.eaten_fraction);
          return shown === r.eaten_fraction ? r : { ...r, eaten_fraction: shown, est_kcal: dishKcal(r.unit_kcal, r.quantity, shown) };
        });
        // Answers for THIS day go through the leftover saver (a save in flight wins); other days as stored.
        let leftovers = stored.filter((s) => s.eaten_date !== date);
        for (const r of rows) {
          if (r.behavioral_date >= date) continue;
          const row = stored.find((s) => s.item_id === r.item_id && s.eaten_date === date);
          leftovers = withToken(leftovers, r.item_id, date, leftoverSaver.seed(slot(r.item_id, date), tokenOfRow(row)));
        }
        leftovers.sort((a, b) => a.item_id - b.item_id || (a.eaten_date < b.eaten_date ? -1 : a.eaten_date > b.eaten_date ? 1 : 0));
        const next: State = { key, all, keptIds, leftovers, loadError: null };
        setState((prev) => (prev.key === key && !prev.loadError && sameJson(prev, next) ? prev : next));
      })
      .catch((e) => {
        console.error("Uber Eats dishes:", e);
        if (!cancelled) setState({ key, all: [], keptIds: [], leftovers: [], loadError: "Couldn't load Uber Eats dishes." });
      });
    return () => {
      cancelled = true;
    };
  }, [date, key, earlierDays, span, saver, leftoverSaver]);

  const setFraction = useCallback(
    (dish: DeliveryDish, fraction: number | null) => {
      setError(null);
      void saver.set(dish.item_id, fraction);
    },
    [saver],
  );

  const loaded = state.key === key && key != null;
  const kept = useMemo(() => {
    if (!loaded) return [];
    const ids = new Set(state.keptIds);
    return state.all.filter((i) => ids.has(i.item_id));
  }, [loaded, state.all, state.keptIds]);
  const groups: DishGroup[] = useMemo(
    () => (date ? groupDishesByDay(kept, date).map((g) => ({ ...g, totalKcal: dayKcal(g.items) })) : []),
    [date, kept],
  );
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const leftovers: LeftoverQuestion[] = useMemo(() => {
    if (!loaded || !date) return [];
    return leftoverQuestions(state.all, state.leftovers, date).map(({ dish, left, row }) => {
      const token = tokenOfRow(row);
      const f = fractionOfToken(token);
      return { dish, left, token, option: optionOfToken(token, left), kcal: f > 0 ? dishKcal(dish.unit_kcal, dish.quantity, f) : null };
    });
  }, [loaded, date, state.all, state.leftovers]);

  const setLeftover = useCallback(
    (q: LeftoverQuestion, optionKey: string) => {
      if (!date) return;
      setError(null);
      const token = q.option === optionKey ? null : tokenForOption(optionKey, q.left);
      void leftoverSaver.set(slot(q.dish.item_id, date), token);
    },
    [date, leftoverSaver],
  );

  const leftoverKcal = dayKcal(leftovers.map((q) => ({ est_kcal: q.kcal, est_kind: q.dish.est_kind })));
  const portionKcal = dayKcal(items.filter((i) => i.behavioral_date === date));
  const totalKcal = portionKcal == null && leftoverKcal == null ? null : (portionKcal ?? 0) + (leftoverKcal ?? 0);

  return {
    items,
    groups,
    leftovers,
    loaded,
    loadError: loaded ? state.loadError : null,
    error,
    setFraction,
    setLeftover,
    leftoverKcal,
    /** Uber Eats kcal eaten on `date`: its own dishes plus leftovers eaten that day. */
    totalKcal,
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

function weekday(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

/**
 * Leftovers of earlier deliveries, asked on one day: "From Tue · 3/4 left · Ate: All / 3/4 / 1/2 / 1/4 ·
 * Not today · Threw out". Shares are of what is left; tapping the lit answer clears it. Unanswered =
 * thrown out (nothing counted).
 */
export function LeftoverList({
  questions,
  onPick,
  className = "",
}: {
  questions: LeftoverQuestion[];
  onPick: (q: LeftoverQuestion, optionKey: string) => void;
  className?: string;
}) {
  if (questions.length === 0) return null;
  return (
    <div className={`bg-surface-card border border-border-subtle rounded-[6px] divide-y divide-border-subtle ${className}`}>
      {questions.map((q) => (
        <div key={q.dish.item_id} className="px-4 py-2.5 text-sm">
          <div className="flex items-start gap-2">
            <span className="text-[11px] font-mono text-text-tertiary w-14 shrink-0 pt-0.5">From {weekday(q.dish.behavioral_date)}</span>
            <div className="flex-1 min-w-0">
              <div className="text-text-secondary line-clamp-2 break-words">
                {q.dish.title}
                {q.dish.quantity > 1 && <span className="text-[11px] font-mono text-text-tertiary"> ×{q.dish.quantity}</span>}
              </div>
              <div className="text-[11px] text-text-tertiary truncate">
                {q.dish.store_name} · {q.left > 0 ? `${formatShare(q.left)} left` : "nothing left"}
              </div>
            </div>
            <span className="text-[11px] font-mono text-text-tertiary w-16 text-right shrink-0 pt-0.5">
              {q.kcal != null ? `~${Math.round(q.kcal)} kcal` : "—"}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap justify-end gap-1" role="group" aria-label={`How much of the leftover ${q.dish.title} you ate`}>
            <span className="text-[10px] font-mono text-text-tertiary mr-0.5 self-center">Ate</span>
            {LEFTOVER_OPTIONS.map((o) => {
              const on = q.option === o.key;
              // Nothing left (all eaten here earlier): only the lit answer and Clear make sense.
              const disabled = q.left <= 0 && !on && o.share != null && o.share > 0;
              return (
                <button
                  key={o.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => onPick(q, o.key)}
                  aria-pressed={on}
                  title={on ? "Tap again to clear" : o.share != null && o.share > 0 ? `${o.label} of what was left` : undefined}
                  className={`h-7 min-w-[2.25rem] px-1.5 rounded-[5px] border text-[11px] font-mono transition-colors disabled:opacity-40 ${
                    on ? "border-accent/70 bg-accent/20 text-accent" : "border-border-subtle text-text-tertiary hover:text-text-secondary"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
