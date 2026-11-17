"use client";

/**
 * Apartment reset on Today: ONE suggested cleanup action at a time, then optional light upkeep. Onyx cannot see the
 * apartment, so everything here is Riley's own input and the starter actions are only examples. Opening, scrolling
 * past or ignoring the card writes nothing; only a button tap does (Done / Partly done / Snooze / a cadence answer).
 * Taps show at once, are kept on the device until saved and carry a receipt id, so a retry never completes twice.
 * Data + saving: lib/use-home-reset.ts; rules: lib/home-reset.ts; SQL: sql/home_reset.sql.
 */

import { useState } from "react";
import { BrushCleaning } from "lucide-react";
import { HOME_MINUTES, SNOOZE_CHOICES, STARTERS, whyDue, type HomeItem, type HomeMinutes } from "@/lib/home-reset";
import { createHomeItem, flushHomeReset, hideStarterToday, patchHome, tapHome, type HomeResetView } from "@/lib/use-home-reset";

const primary = "min-h-11 inline-flex items-center justify-center rounded-full bg-accent px-5 text-[14px] font-semibold text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40";
const secondary = "min-h-11 inline-flex items-center justify-center rounded-control border border-border-subtle px-3 text-[13px] text-text-primary hover:border-border-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";
const textButton = "min-h-11 inline-flex items-center px-2 text-[13px] text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-accent";
const field = "min-h-11 w-full rounded-control border border-border-subtle bg-surface-sunken px-3 text-[16px] text-text-primary focus-visible:outline-2 focus-visible:outline-accent";

function StarterPicker({ onPick, onCancel, cancelLabel }: { onPick: (area: string, action: string, minutes: HomeMinutes) => void; onCancel: () => void; cancelLabel: string }) {
  const [custom, setCustom] = useState(false);
  const [action, setAction] = useState("");
  const [minutes, setMinutes] = useState<HomeMinutes>(5);
  return (
    <div>
      <ul className="mt-3 space-y-2" aria-label="Starter actions">
        {STARTERS.map((s) => (
          <li key={s.action}>
            <button type="button" className={`${secondary} w-full justify-between gap-3 text-left`} onClick={() => onPick(s.area, s.action, s.minutes)}>
              <span>{s.action}</span><span className="shrink-0 text-xs text-text-secondary">{s.minutes} min</span>
            </button>
          </li>
        ))}
      </ul>
      {custom ? (
        <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (action.trim()) onPick("Anywhere", action, minutes); }}>
          <label className="block text-xs text-text-secondary" htmlFor="home-reset-custom">Your own action
            <input id="home-reset-custom" className={`${field} mt-1`} value={action} maxLength={120} onChange={(e) => setAction(e.target.value)} placeholder="One small thing" />
          </label>
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">How much time</legend>
            {HOME_MINUTES.map((m) => (
              <button key={m} type="button" aria-pressed={minutes === m} className={`${secondary} ${minutes === m ? "border-accent" : ""}`} onClick={() => setMinutes(m)}>{m} min</button>
            ))}
            <button type="submit" className={primary} disabled={!action.trim()}>Use this</button>
          </fieldset>
        </form>
      ) : (
        <button type="button" className={`${textButton} mt-1`} onClick={() => setCustom(true)}>Write your own</button>
      )}
      <button type="button" className={`${textButton} mt-1 block`} onClick={onCancel}>{cancelLabel}</button>
    </div>
  );
}

function ActiveCard({ item, now }: { item: HomeItem; now: Date }) {
  const [mode, setMode] = useState<"main" | "partly" | "snooze" | "swap">("main");
  const [left, setLeft] = useState("");
  const upkeep = item.lastDoneOn && (item.upkeep === "weekly" || item.upkeep === "biweekly");
  return (
    <div>
      <p className="mt-3 text-base font-medium text-text-primary">{item.action}</p>
      <p className="mt-1 text-sm text-text-secondary">{item.area} · stop after {item.minutes} minutes, or when this is done. That is enough for today.</p>
      {item.remaining && <p className="mt-1 text-sm text-text-primary">Left from last time: {item.remaining}</p>}
      <p className="mt-1 text-xs text-text-secondary">{whyDue(item, now)} Time spent alone does not count as done.</p>
      {mode === "main" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={primary} onClick={() => tapHome(item.id, "done")}>Done</button>
          <button type="button" className={secondary} onClick={() => setMode("partly")}>Partly done</button>
          <button type="button" className={secondary} onClick={() => setMode("snooze")}>Snooze</button>
          <button type="button" className={secondary} onClick={() => setMode("swap")}>Choose another</button>
          {upkeep && <button type="button" className={textButton} onClick={() => patchHome(item.id, { upkeepPaused: true })}>Pause upkeep</button>}
        </div>
      )}
      {mode === "partly" && (
        <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); tapHome(item.id, "partly", { remaining: left.trim() || item.remaining }); setMode("main"); setLeft(""); }}>
          <label className="block text-xs text-text-secondary" htmlFor="home-reset-left">What is left? (optional)
            <input id="home-reset-left" className={`${field} mt-1`} value={left} maxLength={120} onChange={(e) => setLeft(e.target.value)} placeholder={item.action} />
          </label>
          <div className="flex gap-2"><button type="submit" className={primary}>Save progress</button><button type="button" className={secondary} onClick={() => setMode("main")}>Back</button></div>
        </form>
      )}
      {mode === "snooze" && (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Snooze until">
          {SNOOZE_CHOICES.map((c) => (
            <button key={c.label} type="button" className={secondary} onClick={() => { tapHome(item.id, "snooze", { snoozeHours: c.hours }); setMode("main"); }}>{c.label}</button>
          ))}
          <button type="button" className={textButton} onClick={() => setMode("main")}>Back</button>
        </div>
      )}
      {mode === "swap" && (
        <StarterPicker
          cancelLabel="Back"
          onCancel={() => setMode("main")}
          onPick={(area, action, minutes) => { createHomeItem(area, action, minutes); tapHome(item.id, "snooze", { snoozeHours: 24 }); setMode("main"); }}
        />
      )}
    </div>
  );
}

function OfferCard({ item }: { item: HomeItem }) {
  return (
    <div>
      <p className="mt-3 text-base font-medium text-text-primary">Reset done: {item.action}</p>
      <p className="mt-1 text-sm text-text-secondary">Want a light reminder to keep it up? Only this one action, and you can pause it any time. Missed weeks never pile up.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={secondary} onClick={() => patchHome(item.id, { upkeep: "weekly" })}>Weekly</button>
        <button type="button" className={secondary} onClick={() => patchHome(item.id, { upkeep: "biweekly" })}>Every 2 weeks</button>
        <button type="button" className={secondary} onClick={() => patchHome(item.id, { upkeep: "none" })}>No thanks</button>
      </div>
    </div>
  );
}

export default function HomeResetPanel({ view, now, className, titleClassName }: { view: HomeResetView; now: Date; className: string; titleClassName: string }) {
  const { snap, active, offer, starter } = view;
  const paused = snap.items.filter((i) => i.upkeepPaused && i.lastDoneOn);
  const body = active ? <ActiveCard key={active.id} item={active} now={now} />
    : offer ? <OfferCard key={offer.id} item={offer} />
    : starter ? (
      <div>
        <p className="mt-3 text-sm text-text-secondary">Want one small step toward a tidier apartment? Pick one action you can finish in a few minutes. These are only examples.</p>
        <StarterPicker cancelLabel="Not now" onCancel={hideStarterToday} onPick={createHomeItem} />
      </div>
    ) : paused.length ? (
      <p className="mt-3 text-sm text-text-secondary">Upkeep is paused, so there are no prompts.{" "}
        <button type="button" className={textButton} onClick={() => paused.forEach((i) => patchHome(i.id, { upkeepPaused: false }))}>Resume upkeep</button></p>
    ) : null;
  return (
    <section className={className} aria-labelledby="home-reset-heading" aria-busy={snap.saving}>
      <div className="flex items-center gap-2"><BrushCleaning aria-hidden="true" className="h-5 w-5 shrink-0 text-text-secondary" />
        <h3 id="home-reset-heading" className={titleClassName}>Apartment reset</h3></div>
      {body}
      <div aria-live="polite" className="mt-2 text-xs">
        {snap.saveError ? (
          <p className="text-mid">{snap.saveError} It is kept on this device. <button type="button" className={textButton} onClick={() => void flushHomeReset()}>Retry</button></p>
        ) : snap.ops.length > 0 ? <p className="text-text-secondary">Saving...</p> : null}
      </div>
    </section>
  );
}
