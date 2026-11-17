"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDeliveryWindow, type DeliveryDish, type DeliveryWindow } from "@/lib/queries";
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
  bodyForToken,
  clockNow,
  formatClock,
  formatShare,
  fractionOfToken,
  leftoverQuestions,
  optionOfToken,
  splitToken,
  tokenForOption,
  tokenOfRow,
  withTime,
  type LeftoverRow,
  type LeftoverToken,
} from "@/lib/delivery-leftovers";
import { deliveryWindowDays } from "@/lib/log-ubereats";
import { FROM_WHAT_YOU_SAID } from "@/lib/log-drafts";
import { clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";

// Uber Eats dishes + the one-tap "Ate: All / 3/4 / 1/2 / 1/4 / None" control.
// Shared by /nutrition (Today's Meals, one day), /check-in and the Uber Eats section of /log (the day plus
// earlier days' dishes whose portion was never set: a dinner delivered after the evening check-in is asked
// the next evening). Each tap saves on its own through PATCH /api/delivery/items/[itemId]: the
// kcal shown change at once (optimistic). Writes are serialized per dish (createPortionSaver), and a
// failed save goes back to the last value the server confirmed, with a message.
//
// Leftovers (2026-11-14): a dish of the 3 days before `date` whose delivery-day portion is below All is
// asked about again ("3/4 left. Ate: All / 3/4 / 1/2 / 1/4 · Not today · Threw out") through
// PUT /api/delivery/items/[itemId]/leftovers, saved the same way (one serialized slot per dish and day).
// Unanswered leftovers count as thrown out. A question appears as soon as the portion is set below All,
// also when that happens on this screen.
//
// /log (2026-11-15) adds two opt-in options: `cacheKey` (paint the last copy from the client cache, then read
// again) and `reloadKey` (read the same window again when the harvester has run), plus the "from what you said"
// marks on the controls (`suggestions`). Without them the hook and the lists behave as before.

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
  /** "HH:MM" it was eaten, when given. */
  time: string | null;
};

type Opts = {
  /** Also fetch this many days before `date` and keep their dishes whose portion is still unset. */
  earlierDays?: number;
  /** Called after each successful save (e.g. to refresh charts). The latest callback is used. */
  onSaved?: () => void;
  /**
   * Client-cache key of this window (deliveryWindowKey in lib/log-ubereats.ts): the last copy is shown at once,
   * then the window is read again. Every Uber Eats write drops the key ("delivery:") and the registered fetcher
   * reads it again in the background. Without a key the window is read from the database on every load.
   */
  cacheKey?: string | null;
  /** Change it to read the same window again. Dishes already on screen stay on screen. */
  reloadKey?: number;
  /**
   * A read of this window already started (the /log page's first load, app/log/early-delivery.ts): called once per
   * load with the window's cache key; a promise is used instead of reading again, null = read as usual.
   */
  early?: (key: string) => Promise<DeliveryWindow> | null;
};

async function failure(res: Response) {
  const j = await res.json().catch(() => ({}));
  console.error("delivery save failed:", res.status, j?.error);
  // A 409 carries a sentence written for the user (the leftover rule that refused the save); other errors are server codes.
  if (res.status === 409 && typeof j?.error === "string" && j.error) {
    return { ok: false as const, error: `Not saved: ${j.error.charAt(0).toUpperCase()}${j.error.slice(1)}.` };
  }
  return { ok: false as const, error: "Not saved. Try again." };
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
  const { fraction, time } = splitToken(token);
  return [...rest, { item_id: itemId, eaten_date: date, fraction, threw_out: token === "out", eaten_time: time }];
}

type State = {
  key: string | null;
  /** Every dish fetched (the day + the leftover window). */
  all: DeliveryDish[];
  /** Dishes the portion control is shown for (decided once per load). */
  keptIds: number[];
  leftovers: LeftoverRow[];
  loadError: string | null;
  /** A copy is on screen and reading the window again failed. */
  refreshFailed: boolean;
};

const EMPTY: State = { key: null, all: [], keptIds: [], leftovers: [], loadError: null, refreshFailed: false };

function isWindow(v: unknown): v is DeliveryWindow {
  return !!v && typeof v === "object" && Array.isArray((v as DeliveryWindow).rows) && Array.isArray((v as DeliveryWindow).stored);
}

/**
 * The screen state for one loaded window. `seedPortion` / `seedLeftover` return the value to show for a dish /
 * (dish, day) slot (the saver's: a save still in flight wins over the loaded value).
 */
function windowState(
  key: string,
  date: string,
  earlierDays: number,
  { rows, stored }: DeliveryWindow,
  seedPortion: (itemId: number, stored: number | null) => number | null,
  seedLeftover: (k: string, stored: LeftoverToken) => LeftoverToken,
): State {
  const firstAsked = shiftYmd(date, -earlierDays);
  // Which dishes get the portion control is decided here, once per load: the day's dishes plus
  // earlier days' (within earlierDays) still unset, so an earlier dish stays on screen after a tap.
  const keptIds = checkinDishGroups(
    rows.filter((r) => r.behavioral_date >= firstAsked),
    date,
  ).flatMap((g) => g.items.map((i) => i.item_id));
  // Dishes with a save still in flight keep the value on screen, not the (older) loaded one.
  const all = rows.map((r) => {
    const shown = seedPortion(r.item_id, r.eaten_fraction);
    return shown === r.eaten_fraction ? r : { ...r, eaten_fraction: shown, est_kcal: dishKcal(r.unit_kcal, r.quantity, shown) };
  });
  // Answers for THIS day go through the leftover saver (a save in flight wins); other days as stored.
  let leftovers = stored.filter((s) => s.eaten_date !== date);
  for (const r of rows) {
    if (r.behavioral_date >= date) continue;
    const row = stored.find((s) => s.item_id === r.item_id && s.eaten_date === date);
    leftovers = withToken(leftovers, r.item_id, date, seedLeftover(slot(r.item_id, date), tokenOfRow(row)));
  }
  leftovers.sort((a, b) => a.item_id - b.item_id || (a.eaten_date < b.eaten_date ? -1 : a.eaten_date > b.eaten_date ? 1 : 0));
  return { key, all, keptIds, leftovers, loadError: null, refreshFailed: false };
}

export function useDeliveryDishes(date: string | null, opts: Opts = {}) {
  const earlierDays = opts.earlierDays ?? 0;
  const cacheKey = opts.cacheKey ?? null;
  const reloadKey = opts.reloadKey ?? 0;
  const key = date ? `${date}|${earlierDays}` : null;
  // With a cache key, the first render already shows the cached copy (no skeleton frame).
  const [state, setState] = useState<State>(() => {
    if (!cacheKey || !date || !key) return EMPTY;
    const hit = clientCache.peek(cacheKey);
    return isWindow(hit) ? windowState(key, date, earlierDays, hit, (_, v) => v, (_, t) => t) : EMPTY;
  });
  const [error, setError] = useState<string | null>(null);

  const onSavedRef = useRef(opts.onSaved);
  useEffect(() => {
    onSavedRef.current = opts.onSaved;
  }, [opts.onSaved]);
  const earlyRef = useRef(opts.early);
  earlyRef.current = opts.early;
  // Days currently on screen, and each loaded dish's day: a save error for a dish no longer shown is dropped.
  const shownDays = useRef<Set<string>>(new Set());
  const dishDay = useRef(new Map<number, string>());
  const screenDate = useRef<string | null>(null);
  // The window last shown by a load (a reload of it shows no cached copy first), and the key the message is for.
  const loadedKey = useRef<string | null>(null);
  const errorKey = useRef<string | null>(null);

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
    if (errorKey.current !== key) {
      setError(null);
      errorKey.current = key;
    }
    screenDate.current = date;
    if (!date || !key) {
      shownDays.current = new Set();
      return;
    }
    const days = deliveryWindowDays(date, earlierDays);
    const firstAsked = shiftYmd(date, -earlierDays);
    shownDays.current = new Set(days.filter((d) => d >= firstAsked));
    let cancelled = false;
    let painted = loadedKey.current === key;
    let fresh = false;
    let failed = false;

    const show = (w: DeliveryWindow) => {
      for (const r of w.rows) dishDay.current.set(r.item_id, r.behavioral_date);
      const next = windowState(key, date, earlierDays, w, (id, v) => saver.seed(id, v), (k, t) => leftoverSaver.seed(k, t));
      setState((prev) => {
        const same = prev.key === key && !prev.loadError;
        // A reload keeps the dishes already on screen (a dish answered here must not vanish).
        const ids = new Set(next.all.map((r) => r.item_id));
        const keptIds = same ? [...next.keptIds, ...prev.keptIds.filter((id) => ids.has(id) && !next.keptIds.includes(id))] : next.keptIds;
        const merged = keptIds === next.keptIds ? next : { ...next, keptIds };
        return same && sameJson(prev, merged) ? prev : merged;
      });
      painted = true;
      loadedKey.current = key;
    };
    const fail = (e: unknown) => {
      if (cancelled) return;
      console.error("Uber Eats dishes:", e);
      failed = true;
      if (painted) setState((prev) => (prev.key === key && !prev.refreshFailed ? { ...prev, refreshFailed: true } : prev));
      else setState({ ...EMPTY, key, loadError: "Couldn't load Uber Eats dishes." });
    };
    const load = () => getDeliveryWindow(days);
    // This load's read: one already started for this window (taken once; read again if it failed), else a new one.
    const first = () => {
      const started = earlyRef.current?.(cacheKey ?? key);
      return started ? started.catch(() => load()) : load();
    };

    if (cacheKey) {
      clientCache.register(cacheKey, load);
      if (!painted) {
        const hit = clientCache.peek(cacheKey);
        if (isWindow(hit)) show(hit);
        else {
          void clientCache
            .read(cacheKey)
            .then((v) => {
              if (cancelled || fresh || painted || !isWindow(v)) return;
              show(v);
              // The read again already failed: the copy now on screen is the last one.
              if (failed) setState((prev) => (prev.key === key ? { ...prev, refreshFailed: true } : prev));
            })
            .catch(() => {});
        }
      }
      clientCache
        .revalidate(cacheKey, first)
        .then((v) => {
          if (cancelled) return;
          if (!isWindow(v)) throw new Error("Uber Eats window missing");
          fresh = true;
          show(v);
        })
        .catch(fail);
    } else {
      first()
        .then((v) => {
          if (!cancelled) show(v);
        })
        .catch(fail);
    }
    return () => {
      cancelled = true;
    };
  }, [date, key, earlierDays, cacheKey, reloadKey, saver, leftoverSaver]);

  const setFraction = useCallback(
    (dish: DeliveryDish, fraction: number | null) => {
      setError(null);
      return saver.set(dish.item_id, fraction);
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
      return {
        dish,
        left,
        token,
        option: optionOfToken(token, left),
        kcal: f > 0 ? dishKcal(dish.unit_kcal, dish.quantity, f) : null,
        time: splitToken(token).time,
      };
    });
  }, [loaded, date, state.all, state.leftovers]);

  const setLeftover = useCallback(
    (q: LeftoverQuestion, optionKey: string) => {
      if (!date) return;
      setError(null);
      const token = q.option === optionKey ? null : tokenForOption(optionKey, q.left, q.time);
      void leftoverSaver.set(slot(q.dish.item_id, date), token);
    },
    [date, leftoverSaver],
  );

  /** When it was eaten ("HH:MM"), or null to clear. Only for an answer with an amount. */
  const setLeftoverTime = useCallback(
    (q: LeftoverQuestion, time: string | null) => {
      if (!date || q.token == null) return;
      setError(null);
      void leftoverSaver.set(slot(q.dish.item_id, date), withTime(q.token, time));
    },
    [date, leftoverSaver],
  );

  /** Store this exact answer for the question's day (a suggestion being saved). Resolves when it settled. */
  const saveLeftover = useCallback(
    (q: LeftoverQuestion, token: LeftoverToken) => {
      if (!date) return Promise.resolve();
      setError(null);
      return leftoverSaver.set(slot(q.dish.item_id, date), token);
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
    /** A copy is on screen and reading it again failed. */
    refreshFailed: loaded && state.refreshFailed,
    /** Every dish of the loaded window (also the ones without a control on screen). */
    dishes: loaded ? state.all : [],
    error,
    setFraction,
    setLeftover,
    setLeftoverTime,
    saveLeftover,
    leftoverKcal,
    /** Uber Eats kcal eaten on `date`: its own dishes plus leftovers eaten that day. */
    totalKcal,
  };
}

function timeOf(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : "—";
}

// A suggested answer from the Say it box (/log): drawn dashed, not saved until that section's Save.
const SUGGESTED_CLASS = "border-dashed border-accent text-accent bg-accent/10";

function SuggestionNote({ text }: { text: string }) {
  return <div className="mt-1 text-right text-[11px] font-mono text-accent/80">{FROM_WHAT_YOU_SAID}: {text}, not saved yet</div>;
}

export function PortionControl({
  dish,
  onPick,
  suggested,
}: {
  dish: DeliveryDish;
  onPick: (fraction: number) => void;
  /** A suggested portion (not saved): drawn dashed. An assumed All yields to it. */
  suggested?: number | null;
}) {
  const current = selectedPortion(dish.eaten_fraction);
  const assumed = dish.eaten_fraction == null;
  const hint = suggested != null && suggested !== dish.eaten_fraction;
  return (
    <div className="flex items-center gap-1" role="group" aria-label={`How much of ${dish.title} you ate`}>
      <span className="text-[10px] font-mono text-text-tertiary mr-0.5">Ate</span>
      {PORTION_OPTIONS.map((o) => {
        const on = current === o.value;
        const isSuggested = hint && o.value === suggested;
        // An unset dish shows its assumed All; with a suggestion only the suggestion is marked.
        const lit = on && !(assumed && hint);
        return (
          <button
            key={o.label}
            type="button"
            onClick={() => onPick(o.value)}
            aria-pressed={on}
            title={isSuggested ? "From what you said. Not saved yet." : on && assumed ? "Assumed (not set yet). Tap to confirm." : undefined}
            className={`h-7 max-md:h-11 min-w-[2.25rem] px-1.5 rounded-control border text-[11px] font-mono transition-colors ${
              isSuggested
                ? SUGGESTED_CLASS
                : lit
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

/** "Ate 3/4"; "Ate All (assumed)" while the portion was never set (counted as All). */
export function portionText(fraction: number | null): string {
  if (fraction == null) return "Ate All (assumed)";
  const v = Number(fraction);
  const label = PORTION_OPTIONS.find((o) => o.value === v)?.label ?? `${Math.round(v * 100)}%`;
  return `Ate ${label}`;
}

/** "Ate 1/2 at 7:30 PM", "Threw out"; null answer = "Not answered (counts as thrown out)". */
export function leftoverText(q: Pick<LeftoverQuestion, "option" | "time">): string {
  if (q.option == null) return "Not answered (counts as thrown out)";
  const o = LEFTOVER_OPTIONS.find((x) => x.key === q.option);
  const label = o?.label ?? q.option;
  const amount = o?.share != null && o.share > 0 ? `Ate ${label}` : label;
  return q.time ? `${amount} at ${formatClock(q.time)}` : amount;
}

export function DeliveryDishList({
  items,
  onPick,
  suggestions,
  className = "",
}: {
  items: DeliveryDish[];
  /** Without it the list is read-only: the answer is shown as text (/nutrition; the answer is entered on /log). */
  onPick?: (dish: DeliveryDish, fraction: number) => void;
  /** item_id -> suggested portion (the /log Say it box), shown "from what you said" until saved. */
  suggestions?: ReadonlyMap<number, number>;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={`bg-surface-card border border-border-subtle rounded-control divide-y divide-border-subtle ${className}`}>
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
            {onPick ? (
              <PortionControl dish={d} onPick={(f) => onPick(d, f)} suggested={suggestions?.get(d.item_id)} />
            ) : (
              <span className="text-[11px] font-mono text-text-tertiary">{portionText(d.eaten_fraction)}</span>
            )}
          </div>
          {suggestions?.has(d.item_id) && suggestions.get(d.item_id) !== d.eaten_fraction && (
            <SuggestionNote text={`ate ${PORTION_OPTIONS.find((o) => o.value === suggestions.get(d.item_id))?.label ?? ""}`} />
          )}
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
 * thrown out (nothing counted). Once an amount is picked, "When?" takes the clock time it was eaten
 * (a time picker, plus "Now" on the current day and "Same as 7:30 PM" when another leftover of the day
 * already has one); with a time the leftover also counts for meal timing.
 */
export function LeftoverList({
  questions,
  onPick,
  onTime,
  showNow = false,
  suggestions,
  className = "",
}: {
  questions: LeftoverQuestion[];
  /** item_id -> suggested answer (the /log Say it box), shown "from what you said" until saved. */
  suggestions?: ReadonlyMap<number, { option: string; time: string | null }>;
  /** Without it the list is read-only: the answer is shown as text (/nutrition; the answer is entered on /log). */
  onPick?: (q: LeftoverQuestion, optionKey: string) => void;
  /** Set ("HH:MM") or clear (null) when it was eaten. Without it no time row is shown. */
  onTime?: (q: LeftoverQuestion, time: string | null) => void;
  /** The list is for the current behavioral day: offer "Now". */
  showNow?: boolean;
  className?: string;
}) {
  if (questions.length === 0) return null;
  const shared = questions.find((x) => x.time && fractionOfToken(x.token) > 0)?.time ?? null;
  return (
    <div className={`bg-surface-card border border-border-subtle rounded-control divide-y divide-border-subtle ${className}`}>
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
          {!onPick ? (
            <div className="mt-1.5 flex justify-end">
              <span className="text-[11px] font-mono text-text-tertiary">{leftoverText(q)}</span>
            </div>
          ) : (
          <div className="mt-1.5 flex flex-wrap justify-end gap-1" role="group" aria-label={`How much of the leftover ${q.dish.title} you ate`}>
            <span className="text-[10px] font-mono text-text-tertiary mr-0.5 self-center">Ate</span>
            {LEFTOVER_OPTIONS.map((o) => {
              const on = q.option === o.key;
              const sug = suggestions?.get(q.dish.item_id);
              const isSuggested = !!sug && sug.option === o.key && !on;
              // Nothing left (all eaten here earlier): only the lit answer and Clear make sense.
              const disabled = q.left <= 0 && !on && o.share != null && o.share > 0;
              return (
                <button
                  key={o.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => onPick(q, o.key)}
                  aria-pressed={on}
                  title={
                    isSuggested
                      ? "From what you said. Not saved yet."
                      : on
                        ? "Tap again to clear"
                        : o.share != null && o.share > 0
                          ? `${o.label} of what was left`
                          : undefined
                  }
                  className={`h-7 max-md:h-11 min-w-[2.25rem] px-1.5 rounded-control border text-[11px] font-mono transition-colors disabled:opacity-40 ${
                    on ? "border-accent/70 bg-accent/20 text-accent" : isSuggested ? SUGGESTED_CLASS : "border-border-subtle text-text-tertiary hover:text-text-secondary"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          )}
          {onPick && onTime && fractionOfToken(q.token) > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1">
              <span className="text-[10px] font-mono text-text-tertiary mr-0.5">{q.time ? "At" : "When? (for meal timing)"}</span>
              <input
                type="time"
                value={q.time ?? ""}
                aria-label={`When you ate the leftover ${q.dish.title}`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") onTime(q, null);
                  else if (/^\d{2}:\d{2}$/.test(v)) onTime(q, v);
                }}
                className="h-7 max-md:h-11 px-1.5 rounded-control border border-border-subtle bg-transparent text-[11px] font-mono text-text-secondary"
              />
              {showNow && (
                <button
                  type="button"
                  onClick={() => onTime(q, clockNow())}
                  className="h-7 max-md:h-11 px-1.5 rounded-control border border-border-subtle text-[11px] font-mono text-text-tertiary hover:text-text-secondary"
                >
                  Now
                </button>
              )}
              {!q.time && shared && (
                <button
                  type="button"
                  onClick={() => onTime(q, shared)}
                  className="h-7 max-md:h-11 px-1.5 rounded-control border border-border-subtle text-[11px] font-mono text-text-tertiary hover:text-text-secondary"
                >
                  Same as {formatClock(shared)}
                </button>
              )}
            </div>
          )}
          {(() => {
            const sug = suggestions?.get(q.dish.item_id);
            if (!sug || (sug.option === q.option && (sug.time == null || sug.time === q.time))) return null;
            const label = LEFTOVER_OPTIONS.find((o) => o.key === sug.option)?.label ?? sug.option;
            return <SuggestionNote text={`${label}${sug.time ? ` at ${formatClock(sug.time)}` : ""}`} />;
          })()}
        </div>
      ))}
    </div>
  );
}
