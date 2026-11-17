"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check } from "lucide-react";
import InfoHint from "@/components/InfoHint";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { useAutosave } from "@/lib/use-autosave";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { shiftYmd } from "@/lib/delivery-portion";
import { formatClock } from "@/lib/delivery-leftovers";
import { DRINK_ISSUE_TEXT, DRINK_PRODUCTS, drinkProduct } from "@/lib/drink-products";
import {
  DRINKS_URL,
  DRINK_DAYS_BACK,
  afterWhenEdit,
  announceDrinkChange,
  deviceZone,
  dualChannelOverlaps,
  itemSave,
  likelySameDrink,
  localClockAt,
  newUuid,
  onDrinkChange,
  recentSameProduct,
  saveFromRecord,
  servingsText,
  whenIssueOf,
  type DayCheck,
  type DrinkItemState,
  type DrinkRecord,
  type DrinkSave,
  type OverlapCandidate,
} from "@/lib/drink-capture";
import { drinkSession, saveDrinkWith, undoDrinkWith, type Call, type KeyRead } from "@/lib/drink-session";
import { useLogDrafts, type DrinkLogDraft } from "@/lib/log-drafts";
import { LOG_DRINKS_URL, logEarlyGet } from "@/lib/log-early";
import { useInFeed } from "@/components/FeedContext";
import { DraftMark, LogCard, SectionSkeleton } from "./ui";

/**
 * /log Drinks (PROD-CAFF-01 slice). A drink said in the Say it box (or added here with one tap) becomes ONE capture
 * through /api/nutrition/drinks, which Nutrition and Caffeine both count; never a supplement intake as well.
 *
 * Saving (autosave, lib/autosave.ts; no Save button): a drink with a known product, an amount and a time saves on
 * its own, like Riley's own input. It waits, with the reason shown, while any of these is open: the product (the
 * powder, another flavor or an unknown drink stays here unresolved, never dropped, never zero caffeine), the amount
 * (not said), the time (another day without a clock time is never saved; a day or time that was said but cannot be
 * used never becomes today or Now; a repeated DST hour needs earlier / later), a likely overlap with something
 * already logged that day, or the same drink logged nearby. "Saved" appears only after the server acknowledged the
 * drink; a missing migration is a concrete error and the drink stays here.
 *
 * Overlap: "Already counted in Cronometer" (the drink then counts nowhere) is offered only for a Cronometer entry
 * that carries caffeine, which counts in both Nutrition and Caffeine. A supplement (caffeine only) or an Uber Eats
 * dish (Nutrition only) cannot stand in for both: Riley counts the drink here or does not add it.
 *
 * Identity and recovery: lib/drink-session.ts. Each drink has a stable key; the request in flight is kept on the
 * device before it is sent; a conflict is shown, never written over; after a reload each kept drink is READ by its
 * key and only an explicit tap sends again. Nothing is sent on open or on scroll: drinks exist only after a Fill or
 * a tap, and restored ones are only read.
 */

interface DayAnswer {
  today: string;
  day: string;
  drinks: DrinkRecord[];
  overlaps: OverlapCandidate[];
  unavailable: string[];
}

const dayUrl = (day: string | null) => (day ? `${DRINKS_URL}?day=${day}` : DRINKS_URL);

function asDay(raw: unknown): DayAnswer | null {
  const v = raw as DayAnswer | null | undefined;
  return v && typeof v.today === "string" && typeof v.day === "string" && Array.isArray(v.drinks) && Array.isArray(v.overlaps) ? { ...v, unavailable: Array.isArray(v.unavailable) ? v.unavailable : [] } : null;
}
function checkDay(raw: unknown) {
  if (!asDay(raw)) throw new Error("unexpected drinks answer");
}

const SERVING_CHOICES = [0.5, 1, 1.5, 2, 3];
const UNCHECKED_NAMES: Record<string, string> = { cronometer: "Cronometer", supplements: "supplements", delivery: "Uber Eats" };
const UNAVAILABLE = "Drinks are not set up yet: the database migration is pending.";

/** What a logged entry counts in, so the choice offered is truthful. */
function countsIn(o: OverlapCandidate): string {
  if (o.source === "cronometer") {
    const caffeine = (o.caffeine_mg ?? 0) > 0 ? `${Math.round(o.caffeine_mg!)} mg caffeine` : "caffeine not verified";
    return `Cronometer, ${caffeine} (${o.counts_in_nutrition === true ? "nutrition verified" : "nutrition not verified"})`;
  }
  return o.source === "supplement" ? "Supplements (caffeine only)" : "Uber Eats (Nutrition only, on days without Cronometer)";
}

const fmtMg = (mg: number) => `${Math.round(mg)} mg caffeine`;
const fmtKcal = (k: number) => `${Math.round(k * 10) / 10} kcal`;
function shortDay(day: string, today: string | null): string {
  if (day === today) return "Today";
  if (today && day === shiftYmd(today, -1)) return "Yesterday";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

// ---- requests ------------------------------------------------------------------------------------------------

const call: Call = async (method, body, keepalive = false) => {
  const res = await fetch(DRINKS_URL, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
};

/** Read one stored drink by its key (GET, read-only): the recovery after a reload. */
async function readKey(key: string): Promise<KeyRead | "failed"> {
  try {
    const res = await fetch(`${DRINKS_URL}?key=${encodeURIComponent(key)}`, { cache: "no-store" });
    if (!res.ok) return "failed";
    const j = (await res.json()) as { status?: string; record?: DrinkRecord };
    if (j.status === "found" && j.record) return { status: "found", record: j.record };
    if (j.status === "removed") return { status: "removed" };
    if (j.status === "none") return { status: "none" };
    return "failed";
  } catch {
    return "failed";
  }
}

const reading = new Set<string>();
function recover(key: string) {
  if (reading.has(key)) return;
  reading.add(key);
  void readKey(key).then((r) => {
    reading.delete(key);
    drinkSession.reconcile(key, r);
  });
}

// ---- the session from a draft ----------------------------------------------------------------------------------

function itemFromDraft(d: DrinkLogDraft, zone: string): DrinkItemState {
  const product = drinkProduct(d.product_id);
  const whenIssue = whenIssueOf(d.when_issue);
  // Now only when NO day and NO time were said (an unusable one counts as said: it waits instead).
  const manual = !!d.time || !!d.date || !!whenIssue;
  return {
    key: d.key,
    product_id: product ? product.id : null,
    said: d.said,
    issue: product ? null : DRINK_ISSUE_TEXT[d.issue ?? "unknown"],
    servings: d.servings,
    timeMode: manual ? "manual" : "now",
    capturedAt: d.captured_at,
    day: d.date,
    time: d.time,
    fold: null,
    zone,
    whenIssue,
    overlap: null,
    recent: null,
    status: "open",
    saved: null,
    hold: null,
    note: null,
    pending: null,
  };
}

function newItem(productId: string): DrinkItemState {
  return {
    key: newUuid(),
    product_id: productId,
    said: "",
    issue: null,
    servings: 1,
    timeMode: "now",
    capturedAt: Date.now(),
    day: null,
    time: null,
    fold: null,
    zone: deviceZone(),
    whenIssue: null,
    overlap: null,
    recent: null,
    status: "open",
    saved: null,
    hold: null,
    note: null,
    pending: null,
  };
}

const getVersion = () => drinkSession.version();
const serverVersion = () => 0;

// ---- the section -------------------------------------------------------------------------------------------------

export default function DrinksSection() {
  const [days, setDays] = useState<Record<string, DayAnswer>>(() => {
    const cached = asDay(clientCache.peek(dayUrl(null)));
    return cached ? { [cached.day]: cached } : {};
  });
  // Behavioral today from a fresh answer only (a cached one may be from yesterday): nothing saves before it.
  const [today, setToday] = useState<string | null>(null);
  const [baseState, setBaseState] = useState<"loading" | "ok" | "failed" | "unavailable">("loading");
  const alive = useRef(true);
  const loading = useRef(new Set<string>());
  // The routed page's first read of today takes the GET its HTML already started (lib/log-early.ts), once; a copy
  // drawn in the continuous scroll, and every later read, fetches for itself.
  const routed = !useInFeed();

  useSyncExternalStore(drinkSession.subscribe, getVersion, serverVersion);
  const items = drinkSession.items().filter((i) => i.status !== "dismissed");

  const load = useCallback((day: string | null) => {
    const url = dayUrl(day);
    if (loading.current.has(url)) return;
    loading.current.add(url);
    if (!day) setBaseState((s) => (s === "ok" ? s : "loading"));
    const get = !day && url === LOG_DRINKS_URL ? logEarlyGet(url, routed) : undefined;
    cachedJson(url, { check: checkDay, get })
      .then((raw) => {
        const v = asDay(raw);
        if (!v || !alive.current) return;
        setDays((prev) => ({ ...prev, [v.day]: v }));
        if (!day) {
          setToday(v.today);
          setBaseState("ok");
        }
      })
      .catch((e: unknown) => {
        if (!alive.current || day) return;
        setBaseState(/HTTP 503/.test(String((e as Error)?.message)) ? "unavailable" : "failed");
      })
      .finally(() => loading.current.delete(url));
  }, [routed]);

  // Open: read today's drinks, and READ each drink kept on the device after a reload (never a write).
  useEffect(() => {
    alive.current = true;
    load(null);
    for (const key of drinkSession.restore()) recover(key);
    for (const it of drinkSession.items()) if (it.hold === "recover" && !it.note) recover(it.key);
    return () => { alive.current = false; };
  }, [load]);

  // A save here, on another screen or in another section: read the shown days again.
  const daysRef = useRef(days);
  daysRef.current = days;
  useEffect(
    () =>
      onDrinkChange(() => {
        load(null);
        for (const d of Object.keys(daysRef.current)) if (d !== today) load(d);
      }),
    [load, today],
  );

  // Say it drafts: adopted once into the session (same key again = the same drink), then the draft is done.
  const { draft, clear } = useLogDrafts("drinks");
  useEffect(() => {
    if (!draft) return;
    const zone = deviceZone();
    for (const d of draft.value) drinkSession.adopt(itemFromDraft(d, zone));
    clear(draft.id);
  }, [draft, clear]);

  const dayCheck = useCallback(
    (day: string): DayCheck | null => {
      const d = days[day];
      // Only a fresh read counts for "is it already logged?" (today known = the base read answered this mount).
      if (!d || !today) return null;
      return { candidates: d.overlaps, unchecked: d.unavailable, drinks: d.drinks };
    },
    [days, today],
  );

  const sessionKeys = new Set(items.map((i) => i.key));
  const shownDay = today ?? Object.keys(days)[0] ?? null;
  const shownCheck = shownDay ? dayCheck(shownDay) : null;
  const listed = shownDay ? (days[shownDay]?.drinks ?? []).filter((r) => !sessionKeys.has(r.client_key)) : [];
  const counted = shownDay ? (days[shownDay]?.drinks ?? []).filter((r) => r.overlap === "none") : [];
  const mg = counted.reduce((s, r) => s + r.caffeine_mg, 0);
  const kcal = counted.reduce((s, r) => s + r.kcal, 0);
  const blocked = baseState === "unavailable" ? UNAVAILABLE : null;

  if (baseState === "loading" && !shownDay && items.length === 0) return <SectionSkeleton section="drinks" />;

  return (
    <LogCard
      title="Drinks"
      id="log-section-drinks"
      action={
        <InfoHint label="Drinks">
          A drink here counts once in Nutrition and once in Caffeine, from its label. Say it (&ldquo;one wild grape Gorilla
          Mind&rdquo;) or tap below. Only drinks with a known label are counted; anything else waits here. Undo removes it
          from both.
        </InfoHint>
      }
    >
      {baseState === "unavailable" ? (
        <p role="alert" className="mb-3 text-[13px] text-down">{UNAVAILABLE}</p>
      ) : baseState === "failed" ? (
        <div className="mb-3 flex items-center gap-3">
          <p role="alert" className="text-[13px] text-down">Couldn&apos;t load drinks.</p>
          <button type="button" onClick={() => load(null)} className="min-h-11 px-3 text-[13px] text-text-secondary hover:text-text-primary underline underline-offset-2">
            Retry
          </button>
        </div>
      ) : shownDay ? (
        <p className="mb-3 text-[13px] text-text-secondary">
          {counted.length === 0 ? "No drinks today" : `Today: ${counted.length} drink${counted.length === 1 ? "" : "s"} · ${fmtMg(mg)} · ${fmtKcal(kcal)}`}
        </p>
      ) : null}

      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.key}>
              <DrinkItem item={it} today={today} dayCheck={dayCheck} ensureDay={load} blocked={blocked} />
            </li>
          ))}
        </ul>
      )}

      {listed.length > 0 && (
        <ul className="mt-3 divide-y divide-border-subtle" aria-label="Drinks logged today">
          {listed.map((r) => (
            <li key={r.client_key}>
              <SavedDrink rec={r} check={shownCheck} />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {DRINK_PRODUCTS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => drinkSession.adopt(newItem(p.id))}
            className="min-h-11 px-3 rounded-control border border-border-subtle text-[13px] text-text-secondary hover:text-text-primary hover:border-border-hover transition-colors"
          >
            + {p.flavor} {p.brand} can
          </button>
        ))}
      </div>
    </LogCard>
  );
}

// ---- one drink being captured ------------------------------------------------------------------------------------

function Chip({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      onClick={onClick}
      className={`min-h-11 min-w-11 px-3 rounded-control border text-[13px] font-mono transition-colors ${
        on ? "border-accent bg-accent/15 text-text-primary" : "border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-hover"
      }`}
    >
      {children}
    </button>
  );
}

const LINK = "min-h-11 px-1 text-[12px] text-text-tertiary hover:text-text-primary underline underline-offset-2 disabled:opacity-40";

function DrinkItem({
  item,
  today,
  dayCheck,
  ensureDay,
  blocked,
}: {
  item: DrinkItemState;
  today: string | null;
  dayCheck: (day: string) => DayCheck | null;
  ensureDay: (day: string) => void;
  blocked: string | null;
}) {
  const key = item.key;
  // Riley's own change: a conflict hold ends (his deliberate correction replaces the version shown).
  const set = (patch: Partial<DrinkItemState>) =>
    drinkSession.update(key, item.hold === "conflict" ? { ...patch, hold: null, note: null } : patch);
  const product = drinkProduct(item.product_id);
  const ack = drinkSession.ack(key);
  const prep = itemSave(item, { today, nowMs: Date.now(), dayCheck, acknowledged: !!ack, blocked });
  const reason = useRef<string | null>(null);
  reason.current = prep.ok ? null : prep.reason;
  const [undoing, setUndoing] = useState(false);
  const [undoMsg, setUndoMsg] = useState<string | null>(null);

  const saver = useAutosave<DrinkSave | null>(
    `drink:${key}`,
    {
      save: async (v, ctx) => {
        if (!v) return;
        await saveDrinkWith(call, v, ctx.keepalive);
        announceDrinkChange();
      },
      ready: (v) => (v ? null : reason.current ?? "Not ready."),
      delayMs: 600,
    },
    item.saved ?? undefined,
  );

  // What the server holds (after a conflict or a recovery read) is the baseline: showing it sends nothing.
  const savedJson = JSON.stringify(item.saved);
  const { change, setBaseline } = saver;
  useEffect(() => {
    if (item.saved) setBaseline(item.saved);
    // savedJson stands for item.saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedJson, setBaseline]);

  // The day this drink falls on must be read (overlaps, same drink nearby) before it can save.
  const needDay = !prep.ok && prep.day && !dayCheck(prep.day) && today ? prep.day : null;
  useEffect(() => {
    if (needDay) ensureDay(needDay);
  }, [needDay, ensureDay]);

  // Autosave only for an open drink that is not held (recovering, waiting for an explicit retry, or in conflict).
  const live = item.status === "open" && item.hold == null;
  const value = prep.ok && live ? prep.save : null;
  const valueJson = JSON.stringify(value);
  useEffect(() => {
    if (!live) return;
    change(value);
    // valueJson stands for value (a new object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueJson, live, change]);

  const undo = async () => {
    setUndoing(true);
    setUndoMsg(null);
    const r = await undoDrinkWith(call, key);
    setUndoing(false);
    if (r.ok) {
      saver.reset();
      announceDrinkChange();
    } else setUndoMsg(r.message);
  };

  const now = localClockAt(item.capturedAt, item.zone).time;
  const check = prep.ok ? dayCheck(prep.resolved.eaten_date) : prep.day ? dayCheck(prep.day) : null;
  const askDay = prep.ok ? prep.resolved.eaten_date : prep.day ?? null;
  const overlaps = product && check ? check.candidates.filter((o) => likelySameDrink(product, o.name)) : [];
  const dual = product && check ? dualChannelOverlaps(product, check) : [];
  const nearby = product && check && !prep.ok && prep.ask === "recent" ? recentSameProduct(check.drinks, product.id, key, null, askDay ?? "") : [];
  const name = product ? product.name : item.said ? `“${item.said}”` : "Drink";
  const saving = saver.state.status === "waiting" || saver.state.status === "saving";
  // "Saved" only for what the server acknowledged and nothing newer is waiting.
  const settled = !!ack && item.hold == null && (saver.state.status === "idle" || saver.state.status === "saved");
  const dayChoices = today ? Array.from({ length: DRINK_DAYS_BACK + 1 }, (_, i) => shiftYmd(today, -i)) : [];
  const needsDay = item.whenIssue != null && item.whenIssue !== afterWhenEdit(item.whenIssue, "day");

  if (item.status === "removed") {
    return (
      <div className="rounded-control border border-border-subtle p-3 flex flex-wrap items-center gap-x-3 text-[13px]">
        <span className="text-text-secondary" role="status">{name}: removed.</span>
        <button
          type="button"
          className={LINK}
          onClick={() => {
            set({ status: "dismissed" });
            drinkSession.adopt({ ...item, key: newUuid(), status: "open", saved: null, pending: null, hold: null, note: null, recent: null, capturedAt: item.timeMode === "now" ? Date.now() : item.capturedAt });
          }}
        >
          Log as a new drink
        </button>
        <button type="button" className={LINK} onClick={() => set({ status: "dismissed" })}>Hide</button>
      </div>
    );
  }

  return (
    <div className="rounded-control border border-border-subtle p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[14px] text-text-primary">{name}</span>
        <span className="flex items-center gap-2">
          {item.said ? <DraftMark /> : null}
          {!ack && !saving && !item.pending && (
            <button type="button" className={LINK} onClick={() => set({ status: "dismissed" })}>Dismiss</button>
          )}
        </span>
      </div>

      {item.note && (
        <p role={item.hold === "conflict" ? "alert" : "status"} className={`mt-1 text-[12px] ${item.hold === "conflict" ? "text-mid" : "text-text-secondary"}`}>
          {item.note}
        </p>
      )}
      {item.hold === "recover" && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[12px] text-text-secondary">
          <span role="status">{item.note ? "Not checked yet." : "Checking whether it was saved…"}</span>
          {item.note && <button type="button" className={LINK} onClick={() => recover(key)}>Check again</button>}
        </div>
      )}
      {item.hold === "retry" && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3">
          <button type="button" className={LINK} onClick={() => set({ hold: null, note: null })}>Save it</button>
          <button type="button" className={LINK} onClick={() => set({ status: "dismissed" })}>Discard</button>
        </div>
      )}

      {!product && (
        <div className="mt-2">
          <p className="text-[13px] text-mid">{item.issue ?? "Pick the drink."}</p>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Which drink">
            {DRINK_PRODUCTS.map((p) => (
              <Chip key={p.id} on={false} onClick={() => set({ product_id: p.id, issue: null })}>
                {p.flavor} can
              </Chip>
            ))}
          </div>
        </div>
      )}

      {product && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="How much">
            <span className="w-12 text-[12px] text-text-tertiary">Amount</span>
            {SERVING_CHOICES.map((s) => (
              <Chip key={s} on={item.servings === s} onClick={() => set({ servings: s })} label={servingsText(s)}>
                {servingsText(s).replace(/ cans?$/, "")}
              </Chip>
            ))}
            <span className="text-[12px] text-text-tertiary">{item.servings == null ? "can (not said)" : "can"}</span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="w-12 text-[12px] text-text-tertiary">When</span>
            {item.timeMode === "now" ? (
              <>
                <span className="text-[13px] font-mono text-text-primary">Now · {formatClock(now)}</span>
                <button type="button" className={LINK} onClick={() => set({ timeMode: "manual", day: today, time: now, fold: null })}>Change</button>
              </>
            ) : (
              <>
                <label className="sr-only" htmlFor={`drink-day-${key}`}>Day</label>
                <select
                  id={`drink-day-${key}`}
                  value={needsDay ? item.day ?? "" : item.day ?? today ?? ""}
                  onChange={(e) => set({ day: e.target.value || null, fold: null, whenIssue: e.target.value ? afterWhenEdit(item.whenIssue, "day") : item.whenIssue })}
                  className="min-h-11 px-2 text-[16px] bg-surface-sunken border border-border-subtle rounded-control text-text-primary"
                >
                  {needsDay && <option value="">Pick a day</option>}
                  {dayChoices.map((d) => (
                    <option key={d} value={d}>{shortDay(d, today)}</option>
                  ))}
                </select>
                <label className="sr-only" htmlFor={`drink-time-${key}`}>Time</label>
                <input
                  id={`drink-time-${key}`}
                  type="time"
                  value={item.time ?? ""}
                  onChange={(e) => set({ time: e.target.value || null, fold: null, whenIssue: e.target.value ? afterWhenEdit(item.whenIssue, "time") : item.whenIssue })}
                  className="min-h-11 px-2 text-[16px] font-mono bg-surface-sunken border border-border-subtle rounded-control text-text-primary"
                />
                {!item.time && !item.whenIssue && <span className="text-[12px] text-mid">time not said</span>}
              </>
            )}
          </div>
          {item.whenIssue && <p className="mt-1 text-[12px] text-mid">{item.whenIssue}</p>}

          {!prep.ok && prep.problem === "ambiguous" && (
            <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Which one">
              <span className="text-[12px] text-text-secondary">That time happened twice.</span>
              <Chip on={item.fold === "earlier"} onClick={() => set({ fold: "earlier" })}>Earlier</Chip>
              <Chip on={item.fold === "later"} onClick={() => set({ fold: "later" })}>Later</Chip>
            </div>
          )}

          {!prep.ok && prep.ask === "overlap" && (
            <div className="mt-2 rounded-control bg-white/[0.03] p-2 text-[13px]" role="group" aria-label="Already logged?">
              {overlaps.length > 0 && (
                <ul className="mb-1 text-text-secondary">
                  {overlaps.map((o, i) => (
                    <li key={i}>
                      {o.name}
                      {o.time ? ` at ${formatClock(o.time)}` : ""}: {countsIn(o)}
                    </li>
                  ))}
                </ul>
              )}
              {(check?.unchecked.length ?? 0) > 0 && (
                <p className="mb-1 text-mid">
                  Couldn&apos;t check all of {(check?.unchecked ?? []).map((u) => UNCHECKED_NAMES[u] ?? u).join(", ")} for this drink.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {dual.length > 0 && <Chip on={false} onClick={() => set({ overlap: "in_diary" })}>Already counted in Cronometer</Chip>}
                <Chip on={false} onClick={() => set({ overlap: "none" })}>{dual.length > 0 ? "It's another one" : "Count it here"}</Chip>
                <Chip on={false} onClick={() => set({ status: "dismissed" })}>Don&apos;t add</Chip>
              </div>
            </div>
          )}

          {!prep.ok && prep.ask === "recent" && (
            <div className="mt-2 rounded-control bg-white/[0.03] p-2 text-[13px]" role="group" aria-label="Same drink?">
              <p className="mb-1 text-text-secondary">
                Logged {nearby.map((r) => `${servingsText(r.servings)} at ${formatClock(r.eaten_time)}`).join(", ") || "earlier"}.
              </p>
              <div className="flex flex-wrap gap-2">
                <Chip on={false} onClick={() => set({ status: "dismissed" })}>That one (don&apos;t add)</Chip>
                <Chip on={false} onClick={() => set({ recent: "another" })}>Another can</Chip>
              </div>
            </div>
          )}

          {item.overlap === "in_diary" && (
            <p className="mt-2 text-[12px] text-text-tertiary">
              Already counted in Cronometer: not counted again.{" "}
              <button type="button" className={LINK} onClick={() => set({ overlap: "none" })}>Count it here</button>
            </p>
          )}
        </>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3">
        {settled ? (
          <span role="status" aria-live="polite" className="inline-flex items-center gap-1 text-[12px] text-up">
            <Check size={13} aria-hidden="true" />
            {ack!.overlap === "in_diary"
              ? "Saved, not counted (already in Cronometer)"
              : `Saved: ${fmtMg(ack!.caffeine_mg)}, ${fmtKcal(ack!.kcal)} · ${shortDay(ack!.eaten_date, today)} ${formatClock(ack!.eaten_time)}`}
          </span>
        ) : item.hold == null ? (
          <AutosaveStatus state={saver.state} onRetry={() => void saver.retry()} showIncomplete={!!product} />
        ) : null}
        {ack && item.status === "open" && item.hold !== "recover" && !saving && (
          <button type="button" onClick={() => void undo()} disabled={undoing} className={LINK}>
            {undoing ? "Undoing…" : "Undo"}
          </button>
        )}
      </div>
      {undoMsg && <p role="alert" className="mt-1 text-[13px] text-down">{undoMsg}</p>}
    </div>
  );
}

// ---- a drink already saved (listed for the day) -------------------------------------------------------------------

function SavedDrink({ rec, check }: { rec: DrinkRecord; check: DayCheck | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const product = drinkProduct(rec.product_id);
  // Moving a listed drink to "already counted" is offered only when that day holds a Cronometer entry for it that
  // counts in both channels (the route verifies it again).
  const canMarkCounted = rec.overlap === "none" && !!product && !!check && dualChannelOverlaps(product, check).length > 0;

  const run = async (method: "PATCH" | "DELETE", body: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await call(method, body);
      // A conflict is shown (the list re-reads the newer version); never repeated with a fresh revision.
      if (!r.ok) setErr(typeof r.json.error === "string" ? r.json.error : `Failed (${r.status}).`);
      announceDrinkChange();
    } catch {
      setErr("Couldn't reach Onyx.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => run("PATCH", { ...saveFromRecord(rec), overlap: rec.overlap === "none" ? "in_diary" : "none", expected_revision: rec.revision });
  const remove = () => {
    if (!window.confirm(`Remove ${rec.name} (${servingsText(rec.servings)})?`)) return;
    void run("DELETE", { client_key: rec.client_key, expected_revision: rec.revision });
  };

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
        <span className="font-mono text-text-tertiary">{formatClock(rec.eaten_time)}</span>
        <span className="text-text-primary">{rec.name}</span>
        <span className="font-mono text-text-secondary">
          {servingsText(rec.servings)} · {rec.overlap === "in_diary" ? "not counted (in Cronometer)" : `${fmtMg(rec.caffeine_mg)} · ${fmtKcal(rec.kcal)}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3">
        {(rec.overlap === "in_diary" || canMarkCounted) && (
          <button type="button" onClick={() => void toggle()} disabled={busy} className={LINK}>
            {rec.overlap === "none" ? "Already counted in Cronometer" : "Count it here"}
          </button>
        )}
        <button type="button" onClick={remove} disabled={busy} className={LINK} aria-label={`Remove ${rec.name} at ${formatClock(rec.eaten_time)}`}>
          Remove
        </button>
        {err && <span role="alert" className="text-[12px] text-down">{err}</span>}
      </div>
    </div>
  );
}
