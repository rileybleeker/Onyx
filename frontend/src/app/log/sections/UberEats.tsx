"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DeliveryDishList, LeftoverList, useDeliveryDishes, type LeftoverQuestion } from "@/components/DeliveryPortions";
import { useInFeed } from "@/components/FeedContext";
import InfoHint from "@/components/InfoHint";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { shiftYmd } from "@/lib/delivery-portion";
import { formatClock, tokenForOption } from "@/lib/delivery-leftovers";
import { getUberEatsCheck, type DeliveryDish } from "@/lib/queries";
import { useLogDrafts } from "@/lib/log-drafts";
import { logEarlyGet } from "@/lib/log-early";
import { takeEarlyDeliveryWindow, takeEarlyUberEatsCheck } from "../early-delivery";
import {
  BEHAVIORAL_TODAY_URL,
  LOG_EARLIER_DAYS,
  UBER_EATS_CHECK_KEY,
  behavioralTodayOf,
  initialBehavioralToday,
  classifySuggestions,
  deliveryWindowKey,
  isUberEatsCheck,
  leftoverLabel,
  leftoverTapKey,
  portionLabel,
  portionTapKey,
  uberEatsCheckLine,
  type UberEatsCheck,
  type UberEatsSuggestion,
} from "@/lib/log-ubereats";
import { sameJson } from "@/lib/format";
import { LogCard, LogSaveButton } from "./ui";

/**
 * /log Uber Eats (AGENTS.md "Log screen"): how much of each delivered restaurant dish was eaten and the leftovers,
 * with the same components and rules as /check-in (the day's dishes plus the 2 days before still unanswered,
 * leftovers with the time they were eaten). Each tap saves on its own through PATCH /api/delivery/items/[id] /
 * PUT .../leftovers (createPortionSaver), exactly as on /check-in and /nutrition. Say it suggestions
 * (useLogDrafts("ubereats")) are drawn dashed "from what you said" and stored on their own 0.8 s later, each tried
 * once (a failed one gets Retry).
 * "Uber Eats checked N min ago" is the newest ubereats|items heartbeat (the PC harvester, every 10 min); when it
 * moves, the dishes are read again. Everything paints from the client cache first. Nothing is written on open.
 */

/** true: the embedded check-in leaves out its own Uber Eats parts (./CheckIn.tsx), so dishes are asked once here. */
export const REPLACES_CHECKIN_UBER_EATS = true;

/** How often the heartbeat is read while the screen is visible. */
const CHECK_POLL_MS = 60_000;

function shortDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Behavioral today: a recent cached server answer or the Eastern clock − 6 h at once, then the server's. `routed`:
 * the first read takes the GET the page's HTML started (lib/log-early.ts).
 */
function useBehavioralToday(routed: boolean): string {
  const [today, setToday] = useState(() =>
    initialBehavioralToday(clientCache.peek(BEHAVIORAL_TODAY_URL), clientCache.fetchedAt(BEHAVIORAL_TODAY_URL)),
  );
  useEffect(() => {
    let alive = true;
    let first = true;
    const refresh = () => {
      const get = first ? logEarlyGet(BEHAVIORAL_TODAY_URL, routed) : undefined;
      first = false;
      // A copy fetched in the last minute (the warm-up's or a hover's) is used as is; the day changes at most twice a day.
      cachedJson(BEHAVIORAL_TODAY_URL, { get, freshMs: 60_000 })
        .then((raw) => {
          const t = behavioralTodayOf(raw);
          if (alive && t) setToday(t);
        })
        .catch(() => {});
    };
    refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [routed]);
  return today;
}

/**
 * The newest ubereats|items heartbeat, read every minute while visible. `fresh`: read from the server this visit.
 * `routed`: the first read takes the one LogLoader started on a full page load (../early-delivery.ts).
 */
function useUberEatsCheck(routed: boolean) {
  const [check, setCheck] = useState<{ value: UberEatsCheck; fresh: boolean } | null>(() => {
    const v = clientCache.peek(UBER_EATS_CHECK_KEY);
    return isUberEatsCheck(v) ? { value: v, fresh: false } : null;
  });
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    clientCache.register(UBER_EATS_CHECK_KEY, getUberEatsCheck);
    if (clientCache.peek(UBER_EATS_CHECK_KEY) === undefined) {
      void clientCache
        .read(UBER_EATS_CHECK_KEY)
        .then((v) => {
          if (alive && isUberEatsCheck(v)) setCheck((prev) => prev ?? { value: v, fresh: false });
        })
        .catch(() => {});
    }
    let first = routed;
    const refresh = () => {
      setNow(Date.now());
      const started = first ? takeEarlyUberEatsCheck() : null;
      first = false;
      clientCache
        .revalidate(UBER_EATS_CHECK_KEY, started ? () => started.catch(() => getUberEatsCheck()) : getUberEatsCheck)
        .then((v) => {
          if (!alive) return;
          if (!isUberEatsCheck(v)) throw new Error("no heartbeat answer");
          setCheck((prev) => (prev?.fresh && sameJson(prev.value, v) ? prev : { value: v, fresh: true }));
          setFailed(false);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    };
    refresh();
    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => {
      if (visible()) refresh();
    }, CHECK_POLL_MS);
    const onVisible = () => {
      if (visible()) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [routed]);
  return { check: check?.value ?? null, fresh: check?.fresh ?? false, failed, now };
}

function CheckLine({ check, failed, now }: { check: UberEatsCheck | null; failed: boolean; now: number }) {
  if (!check) {
    return (
      <p className="min-h-[18px] text-[12px] text-text-tertiary">
        {failed ? "Couldn't read when Uber Eats was last checked." : ""}
      </p>
    );
  }
  const line = uberEatsCheckLine(check, now);
  return (
    <p className={`min-h-[18px] text-[12px] ${line.tone === "failed" ? "text-down" : line.tone === "stale" ? "text-mid" : "text-text-tertiary"}`}>
      {line.text}
      {line.tone === "failed" && (
        <>
          {" "}
          <Link href="/status" className="underline underline-offset-2 hover:text-text-primary">
            Status
          </Link>
        </>
      )}
    </p>
  );
}

function BodySkeleton() {
  return (
    <div aria-busy="true">
      <p role="status" className="sr-only">Loading Uber Eats</p>
      <div aria-hidden="true" className="space-y-4">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="space-y-2">
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-11 rounded-control" />
          </div>
        ))}
      </div>
    </div>
  );
}

function describe(s: UberEatsSuggestion): string {
  const name = s.title ?? "A dish not in these days";
  if (s.kind === "portion") return `${name}: ate ${portionLabel(s.fraction)}`;
  return `Leftover ${name}: ${leftoverLabel(s.option)}${s.time ? ` at ${formatClock(s.time)}` : ""}`;
}

export default function UberEatsSection() {
  // The routed page (not a copy in the scroll) takes the reads its full page load already started.
  const routed = !useInFeed();
  const today = useBehavioralToday(routed);
  const [offset, setOffset] = useState(0);
  const [tabTouched, setTabTouched] = useState(false);
  const tabs = useMemo(() => [today, shiftYmd(today, -1), shiftYmd(today, -2)], [today]);
  const date = tabs[offset] ?? today;
  const { check, fresh, failed: checkFailed, now } = useUberEatsCheck(routed);

  // Read the dishes again when the harvester has run since this visit's first fresh check.
  const [reload, setReload] = useState(0);
  const baseline = useRef<string | null | undefined>(undefined);
  const checkAt = check?.at ?? null;
  useEffect(() => {
    if (!fresh) return;
    if (baseline.current === undefined) baseline.current = checkAt;
    else if (checkAt !== baseline.current) {
      baseline.current = checkAt;
      setReload((r) => r + 1);
    }
  }, [fresh, checkAt]);

  const delivery = useDeliveryDishes(date, {
    earlierDays: LOG_EARLIER_DAYS,
    cacheKey: deliveryWindowKey(date, LOG_EARLIER_DAYS),
    reloadKey: reload,
    early: routed ? takeEarlyDeliveryWindow : undefined,
  });
  const latest = useRef(delivery);
  latest.current = delivery;
  // Every dish seen this visit (any day's window), so a suggestion for another day can point there.
  const known = useRef(new Map<number, { title: string; day: string }>());
  for (const d of delivery.dishes) known.current.set(d.item_id, { title: d.title, day: d.behavioral_date });

  // Taps Riley made since this section loaded: a suggestion never overrides them.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const touch = useCallback((k: string) => setTouched((prev) => (prev.has(k) ? prev : new Set(prev).add(k))), []);
  const { setFraction, setLeftover, setLeftoverTime } = delivery;
  const onPick = useCallback(
    (dish: DeliveryDish, fraction: number) => {
      touch(portionTapKey(dish.item_id));
      void setFraction(dish, fraction);
    },
    [touch, setFraction],
  );
  const onLeftoverPick = useCallback(
    (q: LeftoverQuestion, option: string) => {
      touch(leftoverTapKey(q.dish.item_id, date));
      setLeftover(q, option);
    },
    [touch, setLeftover, date],
  );
  const onLeftoverTime = useCallback(
    (q: LeftoverQuestion, time: string | null) => {
      touch(leftoverTapKey(q.dish.item_id, date));
      setLeftoverTime(q, time);
    },
    [touch, setLeftoverTime, date],
  );

  // ─── Say it suggestions ───
  const { draft, clear } = useLogDrafts("ubereats");
  const [saving, setSaving] = useState(false);
  const suggestions = useMemo(() => {
    if (!draft || !delivery.loaded || !Array.isArray(draft.value)) return [];
    return classifySuggestions({
      entries: draft.value,
      date,
      tabs,
      dishes: delivery.dishes,
      shownIds: new Set(delivery.items.map((i) => i.item_id)),
      known: known.current,
      questions: delivery.leftovers.map((q) => ({ item_id: q.dish.item_id, option: q.option, time: q.time, left: q.left })),
      touched,
    });
  }, [draft, delivery.loaded, delivery.dishes, delivery.items, delivery.leftovers, date, tabs, touched]);
  const portionMarks = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of suggestions) if (s.kind === "portion" && s.status === "here") m.set(s.item_id, s.fraction);
    return m;
  }, [suggestions]);
  const leftoverMarks = useMemo(() => {
    const m = new Map<number, { option: string; time: string | null }>();
    for (const s of suggestions) if (s.kind === "leftover" && s.status === "here") m.set(s.item_id, { option: s.option, time: s.time });
    return m;
  }, [suggestions]);
  const actionable = suggestions.filter((s) => s.status === "here" || s.status === "after");
  const listed = suggestions.filter((s) => s.status !== "done" && s.status !== "tapped");

  // A draft whose every entry is stored (or answered by Riley) is finished.
  useEffect(() => {
    if (!draft || saving || !delivery.loaded) return;
    if (suggestions.every((s) => s.status === "done" || s.status === "tapped")) clear(draft.id);
  }, [draft, saving, delivery.loaded, suggestions, clear]);

  // A new draft only for another day: show that day (unless Riley picked a day himself).
  const switchedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!draft || !delivery.loaded || switchedFor.current === draft.id) return;
    switchedFor.current = draft.id;
    if (tabTouched || actionable.length > 0) return;
    const days = Array.from(new Set(suggestions.filter((s) => s.status === "other-day" && s.day).map((s) => s.day as string)));
    const i = days.length === 1 ? tabs.indexOf(days[0]) : -1;
    if (i >= 0) setOffset(i);
  }, [draft, delivery.loaded, tabTouched, actionable.length, suggestions, tabs]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      // Portions first: a leftover can only be stored once its delivery-day portion is below All.
      const byId = new Map(latest.current.dishes.map((d) => [d.item_id, d]));
      await Promise.all(
        suggestions
          .filter((s) => s.kind === "portion" && s.status === "here")
          .map((s) => {
            const dish = byId.get(s.item_id);
            return dish && s.kind === "portion" ? latest.current.setFraction(dish, s.fraction) : Promise.resolve();
          }),
      );
      // The questions as they are now (a portion saved above may have just made one appear).
      const cur = latest.current;
      await Promise.all(
        suggestions
          .filter((s) => s.kind === "leftover" && (s.status === "here" || s.status === "after"))
          .map((s) => {
            const q = cur.leftovers.find((x) => x.dish.item_id === s.item_id);
            if (!q || s.kind !== "leftover") return Promise.resolve();
            return cur.saveLeftover(q, tokenForOption(s.option, q.left, s.time ?? q.time));
          }),
      );
    } finally {
      setSaving(false);
    }
  }, [draft, suggestions]);

  // Autosave (2026-11-15): what the Say it box filled from Riley's words is stored on its own, 0.8 s after it shows
  // (the dashed marks stay visible meanwhile). Each suggestion is tried once on its own; one still waiting after
  // that (a failed save) gets a Retry button.
  const saveRef = useRef(save);
  saveRef.current = save;
  const attempted = useRef(new Set<string>());
  const keyOf = useCallback(
    (s: (typeof suggestions)[number]) => `${draft?.id ?? ""}:${s.kind}:${s.item_id}:${s.day ?? ""}`,
    [draft],
  );
  const freshKey = actionable.map(keyOf).filter((k) => !attempted.current.has(k)).join("|");
  useEffect(() => {
    if (!freshKey || saving || !delivery.loaded) return;
    const t = setTimeout(() => {
      for (const k of freshKey.split("|")) attempted.current.add(k);
      void saveRef.current();
    }, 800);
    return () => clearTimeout(t);
  }, [freshKey, saving, delivery.loaded]);
  const retryable = !saving && !freshKey && actionable.length > 0;

  const dayName = (d: string) => (d === today ? "Today" : d === shiftYmd(today, -1) ? "Yesterday" : shortDay(d));
  const kcal = delivery.totalKcal;
  const nothing = delivery.loaded && !delivery.loadError && delivery.groups.length === 0 && delivery.leftovers.length === 0;

  return (
    <LogCard
      title="Uber Eats"
      action={kcal != null ? <span className="text-[11px] font-mono text-text-tertiary">~{Math.round(kcal)} kcal</span> : undefined}
    >
      <CheckLine check={check} failed={checkFailed} now={now} />

      <div className="mt-2 mb-3 flex gap-1.5" role="tablist" aria-label="Uber Eats day">
        {tabs.map((d, i) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={offset === i}
            onClick={() => {
              setTabTouched(true);
              setOffset(i);
            }}
            className={`min-h-9 px-3 rounded-control border text-[12px] font-mono transition-colors ${
              offset === i ? "border-accent/60 bg-accent/10 text-text-primary" : "border-border-subtle text-text-tertiary hover:text-text-secondary"
            }`}
          >
            {i === 0 ? "Today" : i === 1 ? "Yesterday" : shortDay(d)}
          </button>
        ))}
      </div>

      {listed.length > 0 && (
        <div className="mb-3 rounded-control border border-dashed border-accent/50 bg-accent/5 px-3 py-2.5">
          <ul className="space-y-1 text-[12px] text-text-secondary">
            {listed.map((s, i) => (
              <li key={`${s.kind}:${s.item_id}:${s.day ?? ""}:${i}`} className="flex flex-wrap items-baseline gap-x-2">
                <span className="min-w-0 break-words">{describe(s)}</span>
                {s.status === "after" && <span className="text-[11px] text-text-tertiary">after its portion</span>}
                {s.status === "unknown" && <span className="text-[11px] text-text-tertiary">not found</span>}
                {s.status === "other-day" && s.day && (
                  <button
                    type="button"
                    onClick={() => {
                      setTabTouched(true);
                      setOffset(Math.max(0, tabs.indexOf(s.day as string)));
                    }}
                    className="text-[11px] font-mono text-accent underline underline-offset-2"
                  >
                    Show {dayName(s.day)}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-3">
            {saving || freshKey ? (
              <span role="status" className="text-[12px] text-text-tertiary">Saving what you said…</span>
            ) : retryable ? (
              <>
                <span role="alert" className="text-[12px] text-down">Not saved yet.</span>
                <LogSaveButton onClick={() => void save()} saving={saving} label="Retry" />
              </>
            ) : null}
            <button
              type="button"
              onClick={() => draft && clear(draft.id)}
              className="min-h-11 px-3 text-[13px] text-text-tertiary hover:text-text-secondary"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {!delivery.loaded && !delivery.loadError ? (
        <BodySkeleton />
      ) : (
        <>
          {delivery.groups.length > 0 && <p className="mb-2 text-[12px] text-text-tertiary">Saved as you tap. Left as All unless you change it.</p>}
          {delivery.groups.map((g) => (
            <div key={g.date} className="mb-3">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[11px] font-mono text-text-secondary">
                  {g.date === date ? dayName(g.date) : `${dayName(g.date)} · not answered yet`}
                </span>
                {g.totalKcal != null && <span className="text-[11px] font-mono text-text-tertiary">~{Math.round(g.totalKcal)} kcal</span>}
              </div>
              <DeliveryDishList items={g.items} onPick={onPick} suggestions={portionMarks} />
            </div>
          ))}

          {delivery.leftovers.length > 0 && (
            <div className="mb-1">
              <div className="flex items-baseline justify-between mb-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-[11px] font-mono text-text-secondary">Leftovers · {dayName(date)}</span>
                  <InfoHint label="Leftovers">
                    Share of what was left. Add the time so it counts for meal timing. Unanswered counts as thrown out.
                  </InfoHint>
                </span>
                {delivery.leftoverKcal != null && (
                  <span className="text-[11px] font-mono text-text-tertiary">~{Math.round(delivery.leftoverKcal)} kcal</span>
                )}
              </div>
              <LeftoverList
                questions={delivery.leftovers}
                onPick={onLeftoverPick}
                onTime={onLeftoverTime}
                showNow={date === today}
                suggestions={leftoverMarks}
              />
            </div>
          )}

          {nothing && (
            <p className="text-[13px] text-text-tertiary">
              No Uber Eats dishes to answer for {offset === 0 ? "today" : dayName(date)}.
            </p>
          )}
          {delivery.loadError && (
            <p className="text-[12px] text-down">
              {delivery.loadError}{" "}
              <button type="button" onClick={() => setReload((r) => r + 1)} className="underline underline-offset-2">
                Try again
              </button>
            </p>
          )}
          {delivery.refreshFailed && <p className="mt-1.5 text-[12px] text-text-tertiary">Couldn&apos;t check for new dishes. Showing the last copy.</p>}
          {delivery.error && <p className="mt-1.5 text-[12px] text-down">{delivery.error}</p>}
        </>
      )}
    </LogCard>
  );
}
