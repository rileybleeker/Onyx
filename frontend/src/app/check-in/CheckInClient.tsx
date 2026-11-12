"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, X } from "lucide-react";
import { agentsApi } from "@/lib/agents-api";
import type { CheckinAnswer, CheckinItem, CheckinPayload } from "@/lib/checkin";
import { DeliveryDishList, useDeliveryDishes } from "@/components/DeliveryPortions";

// Daily habit check-in (2026-11-07). One screen per behavior day: Yes / No per question, one Save.
// - Saved answers load as-is; questions another source can answer (alcohol, rest day) start pre-filled and
//   labeled with that source; everything else starts blank. Blank on save = not logged (never a "No").
// - Taps are kept as a local draft per day, so leaving the page (or the app being killed) loses nothing.
// - Save writes the whole day in one request, then tells the Agents chat the day is done so the card settles.
// - Delivered Uber Eats restaurant dishes get one extra section, "how much did you eat?": every dish of the
//   day being checked in, plus dishes of the 2 days before whose portion was never set (the harvester runs
//   every 6 h, so a dinner delivered after the 21:30 card usually lands after that evening's check-in and is
//   asked the next evening). It loads on its own after the questions (never delays them), shows nothing when
//   there is nothing to ask, and each tap saves immediately through PATCH /api/delivery/items/[itemId]
//   (not part of the Save bar).

type Origin = "saved" | "suggested" | "tapped";
type Cell = { answer: CheckinAnswer; origin: Origin; source?: string };

const CATEGORY_ORDER = ["health", "fitness", "nutrition", "mindfulness", "productivity", "social", "learning", "general"];
const draftKey = (date: string) => `onyx:checkin:${date}`;

function dayLabel(date: string, today: string): string {
  const d = new Date(date + "T12:00:00Z");
  const t = new Date(today + "T12:00:00Z");
  const diff = Math.round((t.getTime() - d.getTime()) / 86400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });
}

function longDate(date: string): string {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

export default function CheckInClient() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("date");

  const [data, setData] = useState<CheckinPayload | null>(null);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showExtras, setShowExtras] = useState(false);
  const delivery = useDeliveryDishes(data?.date ?? null, { earlierDays: 2 });

  const load = useCallback(async (date: string | null) => {
    setError(null);
    setSavedAt(null);
    try {
      const res = await fetch(`/api/habits/checkin${date ? `?date=${date}` : ""}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `Couldn't load the check-in (${res.status}).`);
        setData(null);
        return;
      }
      const payload = json as CheckinPayload;
      const next: Record<string, Cell> = {};
      for (const item of payload.items) {
        const saved = payload.answers[item.name];
        const sug = payload.suggestions[item.name];
        if (saved) next[item.name] = { answer: saved, origin: "saved" };
        else if (sug) next[item.name] = { answer: sug.answer, origin: "suggested", source: sug.source };
      }
      try {
        const draft = JSON.parse(localStorage.getItem(draftKey(payload.date)) || "{}") as Record<string, CheckinAnswer | null>;
        for (const [name, a] of Object.entries(draft)) {
          if (!payload.items.some((i) => i.name === name)) continue;
          if (a === null) delete next[name];
          else next[name] = { answer: a, origin: "tapped" };
        }
      } catch {
        /* no draft */
      }
      setData(payload);
      setCells(next);
      setShowExtras(payload.items.some((i) => i.group === "extra" && payload.answers[i.name]));
    } catch {
      setError("Couldn't reach Onyx. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    load(requested);
  }, [load, requested]);

  const tap = (name: string, answer: CheckinAnswer) => {
    if (!data) return;
    setSavedAt(null);
    setCells((prev) => {
      const next = { ...prev };
      const cur = prev[name];
      const cleared = cur?.answer === answer;
      if (cleared) delete next[name];
      else next[name] = { answer, origin: "tapped" };
      try {
        const key = draftKey(data.date);
        const draft = JSON.parse(localStorage.getItem(key) || "{}");
        draft[name] = cleared ? null : answer;
        localStorage.setItem(key, JSON.stringify(draft));
      } catch {
        /* storage unavailable: the in-memory state still works */
      }
      return next;
    });
  };

  const { core, extras, coreByCategory } = useMemo(() => {
    const items = data?.items ?? [];
    const core = items.filter((i) => i.group === "core");
    const extras = items.filter((i) => i.group === "extra");
    const groups = new Map<string, CheckinItem[]>();
    for (const i of core) {
      const c = i.category || "general";
      groups.set(c, [...(groups.get(c) || []), i]);
    }
    const coreByCategory = [...groups.entries()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a[0]);
      const ib = CATEGORY_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return { core, extras, coreByCategory };
  }, [data]);

  const coreDone = core.filter((i) => cells[i.name]).length;
  const coreLeft = core.length - coreDone;

  // What Save would change: every set answer that differs from what's stored, plus clears of stored answers.
  const changes = useMemo(() => {
    if (!data) return {} as Record<string, CheckinAnswer | null>;
    const out: Record<string, CheckinAnswer | null> = {};
    for (const item of data.items) {
      const stored = data.answers[item.name];
      const cur = cells[item.name]?.answer;
      if (cur && cur !== stored) out[item.name] = cur;
      if (!cur && stored) out[item.name] = null;
    }
    return out;
  }, [data, cells]);
  const changeCount = Object.keys(changes).length;

  const save = async () => {
    if (!data || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/habits/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: data.date, answers: changes }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || `Save failed (${res.status}). Your answers are still here.`);
        return;
      }
      try {
        localStorage.removeItem(draftKey(data.date));
      } catch {
        /* ignore */
      }
      // Settle the Agents card; best-effort (the card also expires on its own).
      agentsApi.checkinDone(data.date).catch(() => {});
      const date = data.date;
      await load(date);
      setSavedAt(date);
    } finally {
      setSaving(false);
    }
  };

  const goTo = (date: string) => {
    router.replace(`/check-in?date=${date}`, { scroll: false });
  };

  if (error && !data) {
    return (
      <div className="max-w-xl">
        <h2 className="text-[28px] font-medium text-text-primary">Check-in</h2>
        <p className="mt-4 text-sm text-text-secondary">{error}</p>
        <button onClick={() => goTo(new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }))} className="mt-4 px-3 py-1.5 text-[13px] bg-white/5 border border-border-subtle rounded-[6px]">
          Go to today
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-xl space-y-3">
        <div className="h-8 w-40 bg-white/5 animate-pulse rounded" />
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-12 bg-white/[0.03] animate-pulse rounded-[6px]" />
        ))}
      </div>
    );
  }

  const catchUp = data.days.find((d) => d.date !== data.date && d.date !== data.today && d.answered === 0);

  return (
    <div className="max-w-xl">
      <div className="mb-5">
        <h2 className="text-[28px] font-medium text-text-primary">Check-in</h2>
        <p className="text-sm text-text-tertiary mt-0.5">
          {longDate(data.date)}. Answer for the whole day; skip anything you&apos;re unsure of.
        </p>
      </div>

      {/* Day tabs: today and the two days before, with progress */}
      <div className="flex gap-2 mb-5" role="tablist" aria-label="Day">
        {[...data.days].reverse().map((d) => {
          const active = d.date === data.date;
          const complete = d.answered >= d.total && d.total > 0;
          return (
            <button
              key={d.date}
              role="tab"
              aria-selected={active}
              onClick={() => goTo(d.date)}
              className={`flex-1 px-3 py-2 rounded-[6px] border text-left transition-colors ${
                active ? "border-accent/60 bg-accent/10" : "border-border-subtle bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <div className={`text-[13px] font-medium ${active ? "text-text-primary" : "text-text-secondary"}`}>{dayLabel(d.date, data.today)}</div>
              <div className="text-[11px] font-mono text-text-tertiary">{complete ? "done" : d.answered ? `${d.answered}/${d.total}` : "not started"}</div>
            </button>
          );
        })}
      </div>

      {/* Progress */}
      <div className="mb-6">
        <div className="flex justify-between text-[12px] font-mono text-text-tertiary mb-1.5">
          <span>
            {coreDone} of {core.length} answered
          </span>
          {coreLeft > 0 && <span>{coreLeft} left</span>}
        </div>
        <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          <div className="h-full bg-accent transition-all" style={{ width: `${core.length ? (coreDone / core.length) * 100 : 0}%` }} />
        </div>
      </div>

      {coreByCategory.map(([category, items]) => (
        <section key={category} className="mb-6">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2">{category}</h3>
          <div className="rounded-[6px] border border-border-subtle divide-y divide-border-subtle bg-surface-card">
            {items.map((item) => (
              <Row key={item.name} item={item} cell={cells[item.name]} onTap={tap} />
            ))}
          </div>
        </section>
      ))}

      {extras.length > 0 && (
        <section className="mb-6">
          <button onClick={() => setShowExtras((s) => !s)} className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2">
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showExtras ? "" : "-rotate-90"}`} />
            Also did ({extras.filter((i) => cells[i.name]).length}/{extras.length})
          </button>
          {showExtras && (
            <>
              <p className="text-[12px] text-text-tertiary mb-2">Weekly and occasional habits. Leave blank unless you did (or deliberately skipped) one today.</p>
              <div className="rounded-[6px] border border-border-subtle divide-y divide-border-subtle bg-surface-card">
                {extras.map((item) => (
                  <Row key={item.name} item={item} cell={cells[item.name]} onTap={tap} />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {(delivery.groups.length > 0 || delivery.loadError) && (
        <section className="mb-6">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-1">Uber Eats: how much did you eat?</h3>
          {delivery.groups.length > 0 && (
            <p className="text-[12px] text-text-tertiary mb-2">Saved as you tap. Left as All unless you change it; tap All to confirm.</p>
          )}
          {delivery.groups.map((g) => (
            <div key={g.date} className="mb-3">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[11px] font-mono text-text-secondary">
                  {g.date === data.date ? dayLabel(g.date, data.today) : `${dayLabel(g.date, data.today)} · not answered yet`}
                </span>
                {g.totalKcal != null && (
                  <span className="text-[11px] font-mono text-text-tertiary">~{Math.round(g.totalKcal)} kcal counted</span>
                )}
              </div>
              <DeliveryDishList items={g.items} onPick={delivery.setFraction} />
            </div>
          ))}
          {delivery.loadError && <p className="text-[12px] text-red-400 mt-1.5">{delivery.loadError}</p>}
          {delivery.error && <p className="text-[12px] text-red-400 mt-1.5">{delivery.error}</p>}
        </section>
      )}

      {/* Save bar: sticks above the mobile tab bar */}
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] md:bottom-4 z-10 mt-8">
        <div className="rounded-[8px] border border-border-subtle bg-surface-card/95 backdrop-blur px-4 py-3 flex items-center gap-3 shadow-lg">
          <div className="flex-1 min-w-0 text-[13px]">
            {error ? (
              <span className="text-red-400">{error}</span>
            ) : savedAt === data.date && changeCount === 0 ? (
              <span className="text-text-secondary inline-flex items-center gap-1.5">
                <Check className="w-4 h-4 text-accent" /> Saved
                {catchUp && (
                  <button onClick={() => goTo(catchUp.date)} className="ml-2 text-accent underline underline-offset-2">
                    Catch up {dayLabel(catchUp.date, data.today).toLowerCase()}
                  </button>
                )}
              </span>
            ) : changeCount === 0 ? (
              <span className="text-text-tertiary">Nothing to save yet</span>
            ) : (
              <span className="text-text-secondary">
                {changeCount} change{changeCount === 1 ? "" : "s"}
                {coreLeft > 0 && <span className="text-text-tertiary"> · {coreLeft} left blank</span>}
              </span>
            )}
          </div>
          <button
            onClick={save}
            disabled={saving || changeCount === 0}
            className="px-4 py-2 rounded-[6px] text-[14px] font-medium bg-accent text-black disabled:opacity-40 transition-opacity"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ item, cell, onTap }: { item: CheckinItem; cell: Cell | undefined; onTap: (name: string, a: CheckinAnswer) => void }) {
  const yes = cell?.answer === "Yes";
  const no = cell?.answer === "No";
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <p className="text-[14px] text-text-primary leading-snug">{item.name}</p>
        {cell?.origin === "suggested" && cell.source && <p className="text-[11px] font-mono text-accent/80 mt-0.5">from {cell.source} · tap to change</p>}
      </div>
      <div className="flex gap-1.5 shrink-0">
        <button
          onClick={() => onTap(item.name, "Yes")}
          aria-pressed={yes}
          aria-label={`${item.name}: yes`}
          className={`h-9 w-14 rounded-[6px] border text-[13px] font-medium inline-flex items-center justify-center gap-1 transition-colors ${
            yes ? "bg-accent/20 border-accent/70 text-accent" : "border-border-subtle text-text-tertiary hover:text-text-secondary"
          }`}
        >
          <Check className="w-3.5 h-3.5" /> Yes
        </button>
        <button
          onClick={() => onTap(item.name, "No")}
          aria-pressed={no}
          aria-label={`${item.name}: no`}
          className={`h-9 w-14 rounded-[6px] border text-[13px] font-medium inline-flex items-center justify-center gap-1 transition-colors ${
            no ? "bg-red-500/15 border-red-400/60 text-red-300" : "border-border-subtle text-text-tertiary hover:text-text-secondary"
          }`}
        >
          <X className="w-3.5 h-3.5" /> No
        </button>
      </div>
    </div>
  );
}
