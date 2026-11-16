"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check } from "lucide-react";
import InfoHint from "@/components/InfoHint";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { AutosaveRefused } from "@/lib/autosave";
import { useAutosave } from "@/lib/use-autosave";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { shiftYmd } from "@/lib/delivery-portion";
import { formatClock } from "@/lib/delivery-leftovers";
import { DRINK_ISSUE_TEXT, DRINK_PRODUCTS, drinkProduct } from "@/lib/drink-products";
import {
  DRINKS_URL,
  DRINK_DAYS_BACK,
  announceDrinkChange,
  deviceZone,
  drinkSession,
  itemSave,
  likelySameDrink,
  localClockAt,
  newUuid,
  onDrinkChange,
  recentSameProduct,
  saveFromRecord,
  servingsText,
  type DayCheck,
  type DrinkItemState,
  type DrinkRecord,
  type DrinkSave,
  type OverlapCandidate,
} from "@/lib/drink-capture";
import { useLogDrafts, type DrinkLogDraft } from "@/lib/log-drafts";
import { DraftMark, LogCard, SectionSkeleton } from "./ui";

/**
 * /log Drinks (PROD-CAFF-01 slice). A drink said in the Say it box (or added here with one tap) becomes ONE capture
 * through /api/nutrition/drinks, which Nutrition and Caffeine both count; never a supplement intake as well.
 *
 * Saving (autosave, lib/autosave.ts; no Save button): a drink with a known product, an amount and a time saves on
 * its own, like Riley's own input. It waits, with the reason shown, while any of these is open: the product (the
 * powder, another flavor or an unknown drink stays here unresolved, never dropped, never zero caffeine), the amount
 * (not said), the time (another day without a clock time is never saved; a repeated DST hour needs earlier / later),
 * a likely overlap with something already logged that day (Cronometer, a supplement, an order: "already counted
 * there" or "another one"), or the same drink logged nearby ("that one" or "another can"). "Saved" appears only
 * after the server acknowledged the drink; a missing migration is a concrete error and the drink stays here.
 *
 * Identity: each drink has a stable key (the Say it capture's derived key, or a new UUID for a tap here), kept with
 * the editor state in lib/drink-capture.ts drinkSession (memory only, outside this component), so scrolling away,
 * a remount or a retry never makes a second drink. Undo removes that same drink (a tombstone; a late retry cannot
 * bring it back). Nothing is sent on open or on scroll: items exist only after a Fill or a tap.
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
const SOURCE_NAMES: Record<OverlapCandidate["source"], string> = { cronometer: "Cronometer", supplement: "Supplements", delivery: "Uber Eats" };
const UNCHECKED_NAMES: Record<string, string> = { cronometer: "Cronometer", supplements: "supplements", delivery: "Uber Eats" };

const fmtMg = (mg: number) => `${Math.round(mg)} mg caffeine`;
const fmtKcal = (k: number) => `${Math.round(k * 10) / 10} kcal`;
function shortDay(day: string, today: string | null): string {
  if (day === today) return "Today";
  if (today && day === shiftYmd(today, -1)) return "Yesterday";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

// ---- requests ------------------------------------------------------------------------------------------------

type Answer = { ok: boolean; status: number; json: Record<string, unknown> };

async function call(method: "POST" | "PATCH" | "DELETE", body: unknown, keepalive = false): Promise<Answer> {
  const res = await fetch(DRINKS_URL, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

const recordOf = (a: Answer) => (a.json.record && typeof a.json.record === "object" ? (a.json.record as DrinkRecord) : null);

/** A refusal the autosave shows and does not retry; anything else is retried with backoff. */
function failure(a: Answer, key: string): Error {
  const text = typeof a.json.error === "string" && a.json.error ? a.json.error : `Save failed (${a.status}).`;
  if (a.status === 410) {
    drinkSession.forget(key);
    drinkSession.update(key, { status: "removed", saved: null });
    return new AutosaveRefused("This drink was removed.");
  }
  // Not set up / turned off: shown with Retry, not retried every few seconds.
  if (a.status === 503) return new AutosaveRefused(text);
  if (a.status >= 400 && a.status < 500 && a.status !== 408 && a.status !== 429) return new AutosaveRefused(text);
  return new Error(text);
}

function acknowledged(rec: DrinkRecord, save: DrinkSave | null) {
  drinkSession.remember(rec);
  drinkSession.update(rec.client_key, { saved: save });
  announceDrinkChange();
}

/**
 * Create, or edit with the revision last seen. A create whose key exists with other details (an earlier version
 * of this same drink, its answer lost) becomes a revision-checked edit of that drink, never a second one.
 */
async function saveDrink(v: DrinkSave, keepalive: boolean): Promise<void> {
  let ack = drinkSession.ack(v.client_key);
  if (!ack) {
    const created = await call("POST", v, keepalive);
    const rec = recordOf(created);
    if (created.ok && rec) return acknowledged(rec, v);
    if (created.status === 409 && created.json.code === "changed" && rec) {
      drinkSession.remember(rec);
      ack = rec;
    } else throw failure(created, v.client_key);
  }
  const edited = await call("PATCH", { ...v, expected_revision: ack.revision }, keepalive);
  const rec = recordOf(edited);
  if (edited.ok && rec) return acknowledged(rec, v);
  if (edited.status === 409 && edited.json.code === "stale" && rec) {
    // Changed on another screen: adopt the stored version (the next change edits that revision).
    drinkSession.remember(rec);
    throw new AutosaveRefused("This drink changed on another screen. Change it again to replace that version.");
  }
  throw failure(edited, v.client_key);
}

// ---- the session from a draft ----------------------------------------------------------------------------------

function itemFromDraft(d: DrinkLogDraft, zone: string): DrinkItemState {
  const product = drinkProduct(d.product_id);
  const manual = !!d.time || !!d.date;
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
    overlap: null,
    recent: null,
    status: "open",
    saved: null,
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
    overlap: null,
    recent: null,
    status: "open",
    saved: null,
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

  useSyncExternalStore(drinkSession.subscribe, getVersion, serverVersion);
  const items = drinkSession.items().filter((i) => i.status !== "dismissed");

  const load = useCallback((day: string | null) => {
    const url = dayUrl(day);
    if (loading.current.has(url)) return;
    loading.current.add(url);
    if (!day) setBaseState((s) => (s === "ok" ? s : "loading"));
    cachedJson(url, { check: checkDay })
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
  }, []);

  useEffect(() => {
    alive.current = true;
    load(null);
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
  const listed = shownDay ? (days[shownDay]?.drinks ?? []).filter((r) => !sessionKeys.has(r.client_key)) : [];
  const counted = shownDay ? (days[shownDay]?.drinks ?? []).filter((r) => r.overlap === "none") : [];
  const mg = counted.reduce((s, r) => s + r.caffeine_mg, 0);
  const kcal = counted.reduce((s, r) => s + r.kcal, 0);

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
        <p role="alert" className="mb-3 text-[13px] text-down">Drinks are not set up yet: the database migration is pending.</p>
      ) : baseState === "failed" ? (
        <div className="mb-3 flex items-center gap-3">
          <p className="text-[13px] text-down">Couldn&apos;t load drinks.</p>
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
              <DrinkItem item={it} today={today} dayCheck={dayCheck} ensureDay={load} />
            </li>
          ))}
        </ul>
      )}

      {listed.length > 0 && (
        <ul className="mt-3 divide-y divide-border-subtle" aria-label="Drinks logged today">
          {listed.map((r) => (
            <li key={r.client_key}>
              <SavedDrink rec={r} />
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
}: {
  item: DrinkItemState;
  today: string | null;
  dayCheck: (day: string) => DayCheck | null;
  ensureDay: (day: string) => void;
}) {
  const key = item.key;
  const set = (patch: Partial<DrinkItemState>) => drinkSession.update(key, patch);
  const product = drinkProduct(item.product_id);
  const ack = drinkSession.ack(key);
  // Drinks said in the same Fill ("two cans, at 2 and at 5") are not "the same drink logged earlier" for each other.
  const siblings = new Set(drinkSession.items().filter((i) => i.capturedAt === item.capturedAt && i.key !== key).map((i) => i.key));
  const checkFor = (day: string): DayCheck | null => {
    const c = dayCheck(day);
    return c && { ...c, drinks: c.drinks.filter((r) => !siblings.has(r.client_key)) };
  };
  const prep = itemSave(item, { today, nowMs: Date.now(), dayCheck: checkFor });
  const reason = useRef<string | null>(null);
  reason.current = prep.ok ? null : prep.reason;
  const [undoing, setUndoing] = useState(false);
  const [undoErr, setUndoErr] = useState<string | null>(null);

  const saver = useAutosave<DrinkSave | null>(
    `drink:${key}`,
    {
      save: async (v, ctx) => {
        if (v) await saveDrink(v, ctx.keepalive);
      },
      ready: (v) => (v ? null : reason.current ?? "Not ready."),
      delayMs: 600,
    },
    item.saved ?? undefined,
  );

  // The day this drink falls on must be read (overlaps, same drink nearby) before it can save.
  const needDay = !prep.ok && prep.day && !dayCheck(prep.day) && today ? prep.day : null;
  useEffect(() => {
    if (needDay) ensureDay(needDay);
  }, [needDay, ensureDay]);

  const value = prep.ok && item.status === "open" ? prep.save : null;
  const valueJson = JSON.stringify(value);
  const { change } = saver;
  useEffect(() => {
    if (item.status !== "open") return;
    change(value);
    // valueJson stands for value (a new object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueJson, item.status, change]);

  const undo = async () => {
    const a = drinkSession.ack(key);
    if (!a) return;
    setUndoing(true);
    setUndoErr(null);
    try {
      let r = await call("DELETE", { client_key: key, expected_revision: a.revision });
      const rec = recordOf(r);
      if (r.status === 409 && rec) {
        drinkSession.remember(rec);
        r = await call("DELETE", { client_key: key, expected_revision: rec.revision });
      }
      if (!r.ok) {
        setUndoErr(typeof r.json.error === "string" ? `Not undone: ${r.json.error}` : `Not undone (${r.status}).`);
        return;
      }
      drinkSession.forget(key);
      set({ status: "removed", saved: null });
      saver.reset();
      announceDrinkChange();
    } catch {
      setUndoErr("Couldn't reach Onyx: the drink is still saved.");
    } finally {
      setUndoing(false);
    }
  };

  const now = localClockAt(item.capturedAt, item.zone).time;
  const check = prep.ok ? checkFor(prep.resolved.eaten_date) : prep.day ? checkFor(prep.day) : null;
  const askDay = prep.ok ? prep.resolved.eaten_date : prep.day ?? null;
  const overlaps = product && check ? check.candidates.filter((o) => likelySameDrink(product, o.name)) : [];
  const nearby = product && check && !prep.ok && prep.ask === "recent" ? recentSameProduct(check.drinks, product.id, key, null, askDay ?? "") : [];
  const name = product ? product.name : `“${item.said}”`;
  const saving = saver.state.status === "waiting" || saver.state.status === "saving";
  // "Saved" only for what the server acknowledged and nothing newer is waiting.
  const settled = !!ack && (saver.state.status === "idle" || saver.state.status === "saved");
  const dayChoices = today ? Array.from({ length: DRINK_DAYS_BACK + 1 }, (_, i) => shiftYmd(today, -i)) : [];

  if (item.status === "removed") {
    return (
      <div className="rounded-control border border-border-subtle p-3 flex flex-wrap items-center gap-x-3 text-[13px]">
        <span className="text-text-secondary">{name}: removed.</span>
        <button
          type="button"
          className={LINK}
          onClick={() => {
            set({ status: "dismissed" });
            drinkSession.adopt({ ...item, key: newUuid(), status: "open", saved: null, recent: null, capturedAt: item.timeMode === "now" ? Date.now() : item.capturedAt });
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
          {!ack && !saving && (
            <button type="button" className={LINK} onClick={() => set({ status: "dismissed" })}>Dismiss</button>
          )}
        </span>
      </div>

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
                  value={item.day ?? today ?? ""}
                  onChange={(e) => set({ day: e.target.value, fold: null })}
                  className="min-h-11 px-2 text-[16px] bg-surface-sunken border border-border-subtle rounded-control text-text-primary"
                >
                  {dayChoices.map((d) => (
                    <option key={d} value={d}>{shortDay(d, today)}</option>
                  ))}
                </select>
                <label className="sr-only" htmlFor={`drink-time-${key}`}>Time</label>
                <input
                  id={`drink-time-${key}`}
                  type="time"
                  value={item.time ?? ""}
                  onChange={(e) => set({ time: e.target.value || null, fold: null })}
                  className="min-h-11 px-2 text-[16px] font-mono bg-surface-sunken border border-border-subtle rounded-control text-text-primary"
                />
                {!item.time && <span className="text-[12px] text-mid">time not said</span>}
              </>
            )}
          </div>

          {!prep.ok && prep.problem === "ambiguous" && (
            <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Which one">
              <span className="text-[12px] text-text-secondary">That time happened twice.</span>
              <Chip on={item.fold === "earlier"} onClick={() => set({ fold: "earlier" })}>Earlier</Chip>
              <Chip on={item.fold === "later"} onClick={() => set({ fold: "later" })}>Later</Chip>
            </div>
          )}

          {!prep.ok && prep.ask === "overlap" && (
            <div className="mt-2 rounded-control bg-white/[0.03] p-2 text-[13px]" role="group" aria-label="Already logged?">
              {overlaps.length > 0 ? (
                <ul className="mb-1 text-text-secondary">
                  {overlaps.map((o, i) => (
                    <li key={i}>
                      In {SOURCE_NAMES[o.source]}: {o.name}
                      {o.time ? ` at ${formatClock(o.time)}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-1 text-mid">
                  Couldn&apos;t check {(check?.unchecked ?? []).map((u) => UNCHECKED_NAMES[u] ?? u).join(", ")} for this drink.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Chip on={false} onClick={() => set({ overlap: "in_diary" })}>Already counted there</Chip>
                <Chip on={false} onClick={() => set({ overlap: "none" })}>It&apos;s another one</Chip>
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
              Kept as already in your diary: not counted again.{" "}
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
              ? "Saved, not counted (already in diary)"
              : `Saved: ${fmtMg(ack!.caffeine_mg)}, ${fmtKcal(ack!.kcal)} · ${shortDay(ack!.eaten_date, today)} ${formatClock(ack!.eaten_time)}`}
          </span>
        ) : (
          <AutosaveStatus state={saver.state} onRetry={() => void saver.retry()} showIncomplete={!!product} />
        )}
        {settled && (
          <button type="button" onClick={() => void undo()} disabled={undoing} className={LINK}>
            {undoing ? "Undoing…" : "Undo"}
          </button>
        )}
      </div>
      {undoErr && <p role="alert" className="mt-1 text-[13px] text-down">{undoErr}</p>}
    </div>
  );
}

// ---- a drink already saved (listed for the day) -------------------------------------------------------------------

function SavedDrink({ rec }: { rec: DrinkRecord }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (method: "PATCH" | "DELETE", body: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await call(method, body);
      if (!r.ok) {
        setErr(typeof r.json.error === "string" ? r.json.error : `Failed (${r.status}).`);
        if (r.status === 409 || r.status === 410) announceDrinkChange();
        return;
      }
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
          {servingsText(rec.servings)} · {rec.overlap === "in_diary" ? "not counted (in diary)" : `${fmtMg(rec.caffeine_mg)} · ${fmtKcal(rec.kcal)}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3">
        <button type="button" onClick={() => void toggle()} disabled={busy} className={LINK}>
          {rec.overlap === "none" ? "Already in diary" : "Count it here"}
        </button>
        <button type="button" onClick={remove} disabled={busy} className={LINK} aria-label={`Remove ${rec.name} at ${formatClock(rec.eaten_time)}`}>
          Remove
        </button>
        {err && <span role="alert" className="text-[12px] text-down">{err}</span>}
      </div>
    </div>
  );
}
