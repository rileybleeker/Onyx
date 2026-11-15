"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Moon, Sun, X } from "lucide-react";
import { agentsApi } from "@/lib/agents-api";
import { VOICE_MAX_TEXT_CHARS } from "@/lib/checkin-voice";
import { addDays, kitSummary, nightLabel, type CheckinAnswer, type CheckinItem, type CheckinNight, type CheckinPayload } from "@/lib/checkin";
import { buildCells, savePlan, visibleNights, type Cell, type Cells, type Patch } from "@/lib/checkin-cells";
import { CheckinDraftStore, dayDraftKey, nightDraftKey, recoveryTarget, type DatedDraft } from "@/lib/checkin-drafts";
import { DeliveryDishList, LeftoverList, useDeliveryDishes } from "@/components/DeliveryPortions";

// Daily habit check-in (2026-11-07). Yes / No per question, one Save.
// - Saved answers load as-is; questions another source can answer start pre-filled and labeled with that
//   source; everything else starts blank. Blank on save = not logged (never a "No").
// - Taps are kept as dated local drafts. Reopened drafts require review; storage failures are surfaced.
// - Two parts (2026-11-13, rules in lib/checkin.ts):
//     SLEEP   one block per night that already happened ("Last night", and the night before while it is
//             unanswered). It does not follow the day tabs and never asks about tonight. A night's answers
//             are saved on the behavior day that night closed (last night = yesterday), which is the night
//             the HRV pipeline scores them against. One "Usual kit" tap fills the kit questions with the
//             last answer given to each.
//     DAYTIME the day tabs (today and the two days before). Rarely-Yes questions sit in "Also did";
//             "No for the other N" answers every blank daytime question at once.
//   Kit and "No for the rest" are ordinary taps: drafted, then saved.
// - Save writes the day and each changed night (one request each), then tells the Agents chat the day is
//   done so the card settles.
// - Delivered Uber Eats restaurant dishes get one extra section, "how much did you eat?": every dish of the
//   day being checked in, plus dishes of the 2 days before whose portion was never set (the harvester runs
//   every 6 h, so a dinner delivered after the 21:30 card usually lands after that evening's check-in and is
//   asked the next evening). It loads on its own after the questions (never delays them), shows nothing when
//   there is nothing to ask, and each tap saves immediately through PATCH /api/delivery/items/[itemId]
//   (not part of the Save bar).

const CATEGORY_ORDER = ["health", "fitness", "nutrition", "mindfulness", "productivity", "social", "learning", "general"];
const withAnswers = (saved: Record<string, CheckinAnswer>, patch: Patch) => {
  const next = { ...saved };
  for (const [name, answer] of Object.entries(patch)) {
    if (answer === null) delete next[name];
    else next[name] = answer;
  }
  return next;
};

/** The server refused because the day rolled over since the page loaded: reload, don't keep the stale labels. */
class StaleDayError extends Error {}

/** Sleep questions live in the night blocks; core ones are asked, occasional ones are an optional row there. */
const isNightItem = (i: CheckinItem) => i.sleep;
/** Reload when the app comes back after this long: "Last night" must never be a day old. */
const RELOAD_AFTER_MS = 60_000;

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
  const [cells, setCells] = useState<Cells>({}); // the day tab's questions
  const [nightCells, setNightCells] = useState<Record<string, Cells>>({}); // sleep questions, per night
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showExtras, setShowExtras] = useState(false);
  const [drafts] = useState(() => new CheckinDraftStore(() => localStorage));
  const [recovery, setRecovery] = useState<DatedDraft[]>([]);
  const [storageFailed, setStorageFailed] = useState(false);
  const refreshDrafts = useCallback(() => {
    setRecovery(drafts.recovery());
    setStorageFailed(drafts.storageFailed);
  }, [drafts]);
  const delivery = useDeliveryDishes(data?.date ?? null, { earlierDays: 2 });
  const [voiceText, setVoiceText] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const [voiceMarks, setVoiceMarks] = useState<{ date: string; marks: Record<string, CheckinAnswer> }>({ date: "", marks: {} });
  const dataDateRef = useRef<string | null>(null);
  dataDateRef.current = data?.date ?? null;

  const lastLoad = useRef(0);
  const savingRef = useRef(false);
  const deferredLoad = useRef<{ date: string | null } | null>(null);

  const loadSeq = useRef(0);

  const load = useCallback(async (date: string | null, afterSave = false) => {
    // Back/forward can change the URL even while the tabs are disabled. Finish the dated save first.
    if (savingRef.current && !afterSave) {
      deferredLoad.current = { date };
      return;
    }
    lastLoad.current = Date.now();
    const seq = ++loadSeq.current; // a newer load (tab switch, resume) makes this one's result irrelevant
    setError(null);
    setSavedAt(null);
    try {
      const res = await fetch(`/api/habits/checkin${date ? `?date=${date}` : ""}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (seq !== loadSeq.current) return;
      if (!res.ok) {
        // A rejected date/session is unusable. A transient outage leaves the last loaded form editable,
        // still on its original dates; POST's `today` guard remains the authority on rollover.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          drafts.holdAll();
          setData(null);
        }
        setRefreshFailed(true);
        setError(json.error || `Couldn't load the check-in (${res.status}).`);
        return;
      }
      const payload = json as CheckinPayload;
      drafts.prepare(payload);
      const day = buildCells(
        payload.items.filter((i) => !isNightItem(i)),
        payload.answers,
        payload.suggestions,
        drafts.active(dayDraftKey(payload.date))
      );
      const sleepItems = payload.items.filter(isNightItem);
      const nights: Record<string, Cells> = {};
      for (const n of payload.nights ?? []) nights[n.date] = buildCells(sleepItems, n.answers, n.suggestions, drafts.active(nightDraftKey(n.date)));
      setData(payload);
      setRefreshFailed(false);
      setCells(day);
      setNightCells(nights);
      // Open "Also did" when it holds a saved or pre-filled answer, so nothing is saved out of sight.
      setShowExtras(payload.items.some((i) => i.group === "extra" && day[i.name]));
    } catch {
      if (seq === loadSeq.current) {
        setRefreshFailed(true);
        setError("Couldn't reach Onyx. Check your connection and try again.");
      }
    }
    finally { if (seq === loadSeq.current) refreshDrafts(); }
  }, [drafts, refreshDrafts]);

  useEffect(() => {
    // Discover recovery records even if the requested date has expired or the GET cannot load.
    drafts.scan();
    refreshDrafts();
    const leaving = (event: BeforeUnloadEvent) => {
      if (drafts.storageFailed && drafts.hasPending()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [drafts, refreshDrafts]);

  useEffect(() => {
    load(requested);
    // A page left open (or an installed app resumed) keeps the `today` it loaded with, so after the day rolls
    // over its "Last night" would be the night before. Reload on return; unsaved taps come back from the drafts.
    const back = () => {
      if (document.visibilityState === "visible" && !savingRef.current && Date.now() - lastLoad.current > RELOAD_AFTER_MS) load(requested);
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("pageshow", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("pageshow", back);
    };
  }, [load, requested]);

  // One or several answers at once. scope = null for the day tab, or the night's date for a sleep block.
  const apply = (scope: string | null, patch: Patch) => {
    if (!data || !Object.keys(patch).length) return;
    const key = scope === null ? dayDraftKey(data.date) : nightDraftKey(scope);
    const saved = scope === null ? data.answers : data.nights?.find((n) => n.date === scope)?.answers ?? {};
    if (!drafts.write(key, patch, saved)) {
      setError("Review or discard the preserved draft for this date before changing its answers.");
      return;
    }
    refreshDrafts();
    setSaveError(null);
    setSavedAt(null);
    const update = (prev: Cells): Cells => {
      const next = { ...prev };
      for (const [name, a] of Object.entries(patch)) {
        if (a === null) delete next[name];
        else next[name] = { answer: a, origin: "tapped" };
      }
      return next;
    };
    if (scope === null) {
      setCells(update);
    } else {
      setNightCells((prev) => ({ ...prev, [scope]: update(prev[scope] ?? {}) }));
    }
  };

  // Tapping the active answer clears it.
  const tap = (scope: string | null, name: string, answer: CheckinAnswer) => {
    const cur = (scope === null ? cells : (nightCells[scope] ?? {}))[name];
    apply(scope, { [name]: cur?.answer === answer ? null : answer });
  };

  const { dayItems, sleepItems, core, extras, coreByCategory } = useMemo(() => {
    const items = data?.items ?? [];
    const sleepItems = items.filter(isNightItem);
    const dayItems = items.filter((i) => !isNightItem(i));
    const core = dayItems.filter((i) => i.group === "core");
    const extras = dayItems.filter((i) => i.group === "extra");
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
    return { dayItems, sleepItems, core, extras, coreByCategory };
  }, [data]);

  // Last night always; an earlier night while it is incomplete or holds an unsaved tap (lib/checkin-cells.ts).
  const nights = useMemo(() => visibleNights(data?.nights ?? [], sleepItems, nightCells), [data, sleepItems, nightCells]);

  const coreDone = core.filter((i) => cells[i.name]).length;
  const coreLeft = core.length - coreDone;
  const dayBlanks = core.filter((i) => !cells[i.name]);

  // What Save sends: only the parts Riley touched (see savePlan).
  const { dayPatch, nightPatches, changeCount } = useMemo(
    () => savePlan({ dayItems, dayAnswers: data?.answers ?? {}, cells, sleepItems, nights, nightCells }),
    [data, dayItems, cells, sleepItems, nights, nightCells]
  );

  const save = async () => {
    if (!data || savingRef.current || changeCount === 0) return;
    setSaving(true);
    savingRef.current = true;
    ++loadSeq.current; // an older in-flight GET must not replace a just-saved baseline
    setError(null);
    setSaveError(null);
    const sentDrafts = new Map([
      [dayDraftKey(data.date), drafts.read(dayDraftKey(data.date))],
      ...nightPatches.map((n) => [nightDraftKey(n.date), drafts.read(nightDraftKey(n.date))] as const),
    ]);
    const settled = (date: string, patch: Patch, night: boolean) => {
      const key = night ? nightDraftKey(date) : dayDraftKey(date);
      drafts.settle(key, patch, sentDrafts.get(key) ?? {});
      // Settle each successful part immediately, even if the next request or the final reload fails.
      setData((prev) => !prev ? prev : night
        ? { ...prev, nights: prev.nights.map((n) => n.date === date ? { ...n, answers: withAnswers(n.answers, patch) } : n) }
        : prev.date === date ? { ...prev, answers: withAnswers(prev.answers, patch) } : prev);
      if (night) {
        const n = data.nights.find((n) => n.date === date)!;
        setNightCells((prev) => ({ ...prev, [date]: buildCells(sleepItems, withAnswers(n.answers, patch), n.suggestions, drafts.active(key)) }));
      } else {
        setCells(buildCells(dayItems, withAnswers(data.answers, patch), data.suggestions, drafts.active(key)));
      }
      refreshDrafts();
    };
    const post = async (date: string, answers: Patch) => {
      const res = await fetch("/api/habits/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, answers, today: data.today }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        if (res.status === 409 && json.stale) throw new StaleDayError(json.error || "A new day started since this page loaded.");
        throw new Error(json.error || `Save failed (${res.status}). Your answers are still here.`);
      }
    };
    try {
      // The day, then each night under ITS date. Only successful requests settle their draft snapshots.
      if (Object.keys(dayPatch).length) {
        await post(data.date, dayPatch);
        settled(data.date, dayPatch, false);
        // Settle the Agents card; best-effort (the card also expires on its own). Only when the day was saved.
        agentsApi.checkinDone(data.date).catch(() => {});
      }
      for (const n of nightPatches) {
        await post(n.date, n.changes);
        settled(n.date, n.changes, true);
      }
      const date = data.date;
      await load(date, true);
      setSavedAt(date);
    } catch (e) {
      if (e instanceof StaleDayError) {
        // Keep every unfinished tap under its original date, outside Save until explicitly reviewed.
        drafts.holdAll();
        refreshDrafts();
        setData(null);
        router.replace("/check-in", { scroll: false });
        await load(null, true);
        setSaveError("A new day started. Unsaved answers are preserved under their original dates. Review them below before using them.");
      } else {
        setSaveError(e instanceof TypeError ? "Couldn't reach Onyx. Your answers are still here." : e instanceof Error ? e.message : "Save failed. Your answers are still here.");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (deferredLoad.current) {
        const { date } = deferredLoad.current;
        deferredLoad.current = null;
        void load(date);
      }
    }
  };

  // "Say it once": the server maps the text to Yes/No answers (it writes nothing); they become ordinary draft taps.
  // Rows already saved or tapped are never overwritten; a data pre-fill is.
  const fillFromVoice = async () => {
    if (!data || voiceBusy || !voiceText.trim()) return;
    const date = data.date;
    setVoiceBusy(true);
    setVoiceMsg(null);
    try {
      const res = await fetch("/api/habits/checkin/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, text: voiceText.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (date !== dataDateRef.current) return; // switched day meanwhile: drop it
      if (!res.ok || json.failed || !json.answers || typeof json.answers !== "object") {
        setVoiceMsg("Couldn't read that, try again.");
        return;
      }
      const patch: Patch = {};
      for (const item of dayItems) {
        const a = (json.answers as Record<string, unknown>)[item.name];
        const cur = cells[item.name];
        if ((a === "Yes" || a === "No") && cur?.origin !== "saved" && cur?.origin !== "tapped") patch[item.name] = a;
      }
      const n = Object.keys(patch).length;
      if (n === 0) {
        setVoiceMsg("Nothing in the text matched a question.");
        return;
      }
      apply(null, patch);
      setVoiceMarks((prev) => ({ date, marks: { ...(prev.date === date ? prev.marks : {}), ...(patch as Record<string, CheckinAnswer>) } }));
      setVoiceMsg(`Filled ${n} answer${n === 1 ? "" : "s"}. Check them, then Save.`);
    } catch {
      setVoiceMsg("Couldn't read that, try again.");
    } finally {
      setVoiceBusy(false);
    }
  };

  // The marker stays while the row still holds the answer the text gave; any change by Riley removes it.
  const isFromVoice = (name: string) => !!data && voiceMarks.date === data.date && !!cells[name] && voiceMarks.marks[name] === cells[name].answer;

  const goTo = (date: string) => {
    router.replace(`/check-in?date=${date}`, { scroll: false });
  };

  const reviewDraft = (entry: DatedDraft) => {
    if (!data || savingRef.current || !drafts.recover(entry.key, data)) return;
    setError(null);
    setSaveError(null);
    setSavedAt(null);
    if (entry.night) {
      const n = data.nights.find((n) => n.date === entry.date)!;
      setNightCells((prev) => ({ ...prev, [n.date]: buildCells(sleepItems, n.answers, n.suggestions, drafts.active(entry.key)) }));
    } else {
      const next = buildCells(dayItems, data.answers, data.suggestions, drafts.active(entry.key));
      setCells(next);
      setShowExtras(dayItems.some((i) => i.group === "extra" && next[i.name]));
    }
    refreshDrafts();
  };

  const draftRecovery = (
    <>
      {storageFailed && <p role="alert" className="my-4 text-sm text-mid">Some drafts could not be read or stored in this browser. Answers entered here are kept in this open page, but may be lost if you close or refresh it. Keep it open until saved, or copy the answers.</p>}
      <DraftRecovery entries={recovery} page={data} saving={saving} onReview={reviewDraft} onGo={goTo} onDiscard={(entry) => {
        if (savingRef.current) return;
        drafts.discard(entry.key, entry.draft);
        refreshDrafts();
      }} />
    </>
  );

  const visibleError = [saveError, error].filter(Boolean).join(" ");
  if (visibleError && !data) {
    return (
      <div className="max-w-xl">
        <h2 className="text-[28px] font-medium text-text-primary">Check-in</h2>
        <p className="mt-4 text-sm text-text-secondary">{visibleError}</p>
        {draftRecovery}
        <button
          onClick={() => {
            // No date: the server decides which day it is (before 06:00 the clock date is a day ahead).
            router.replace("/check-in", { scroll: false });
            load(null);
          }}
          className="mt-4 px-3 py-1.5 text-[13px] bg-white/5 border border-border-subtle rounded-control">
          Go to today
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-xl space-y-3">
        {draftRecovery}
        <div className="h-8 w-40 bg-white/5 animate-pulse rounded" />
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-12 bg-white/[0.03] animate-pulse rounded-control" />
        ))}
      </div>
    );
  }

  const catchUp = data.days.find((d) => d.date !== data.date && d.date !== data.today && d.answered === 0);
  const labelDay = (date: string) => refreshFailed ? date : dayLabel(date, data.today);
  const dayName = labelDay(data.date);

  return (
    <div className="max-w-xl">
      <div className="mb-5">
        <h2 className="text-[28px] font-medium text-text-primary">Check-in</h2>
        <p className="text-sm text-text-tertiary mt-0.5">
          {refreshFailed ? `Showing the last loaded check-in for daytime ${data.date}. Dates are unchanged; refresh could not confirm today's date.` : nights.length > 0
            ? `Two parts. Sleep: ${nightLabel(nights[0].date, data.today).span}. Daytime: ${dayName === "Today" || dayName === "Yesterday" ? `${dayName.toLowerCase()}, ` : ""}${longDate(data.date)}.`
            : `Daytime: ${longDate(data.date)}. Skip anything you're unsure of.`}
        </p>
      </div>

      {draftRecovery}

      {/* SLEEP: nights that already happened. Not tied to the day tabs below. */}
      {nights.length > 0 && (
        <section className="mb-7 rounded-[8px] border border-indigo-400/25 bg-indigo-500/[0.06] p-3" aria-label="Sleep">
          <div className="flex items-center gap-2">
            <Moon className="w-4 h-4 text-indigo-300" />
            <h3 className="text-[15px] font-medium text-text-primary">Sleep</h3>
          </div>
          <p className="text-[12px] text-text-tertiary mt-0.5 mb-3">Only nights that already happened. Tonight is asked tomorrow.</p>
          {nights.map((n, i) => (
            <NightBlock
              key={n.date}
              night={n}
              today={data.today}
              unconfirmed={refreshFailed}
              catchUp={i > 0}
              items={sleepItems}
              cells={nightCells[n.date] ?? {}}
              onTap={(name, a) => tap(n.date, name, a)}
              onKit={(kit) => apply(n.date, kit)}
            />
          ))}
        </section>
      )}

      {/* DAYTIME: one behavior day per tab */}
      <div className="flex items-center gap-2 mb-2">
        <Sun className="w-4 h-4 text-amber-300" />
        <h3 className="text-[15px] font-medium text-text-primary">
          Daytime{dayName === "Today" || dayName === "Yesterday" ? ` · ${dayName}` : ""}
        </h3>
        <span className="text-[13px] text-text-secondary">{refreshFailed ? data.date : longDate(data.date)}</span>
      </div>

      {/* Day tabs: today and the two days before, with progress */}
      <div className="flex gap-2 mb-4" role="tablist" aria-label="Day">
        {[...data.days].reverse().map((d) => {
          const active = d.date === data.date;
          const complete = d.answered >= d.total && d.total > 0;
          return (
            <button
              key={d.date}
              role="tab"
              aria-selected={active}
              disabled={saving}
              onClick={() => goTo(d.date)}
              className={`flex-1 px-3 py-2 rounded-control border text-left transition-colors ${
                active ? "border-accent/60 bg-accent/10" : "border-border-subtle bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <div className={`text-[13px] font-medium ${active ? "text-text-primary" : "text-text-secondary"}`}>{labelDay(d.date)}</div>
              <div className="text-[11px] font-mono text-text-tertiary">{complete ? "done" : d.answered ? `${d.answered}/${d.total}` : "not started"}</div>
            </button>
          );
        })}
      </div>

      {/* Say it once: dictated text -> draft Yes/No taps (nothing is saved until Save) */}
      <details className="mb-4 rounded-control border border-border-subtle bg-white/[0.02] px-3 py-2">
        <summary className="cursor-pointer text-[13px] text-text-secondary">Say it once</summary>
        <textarea
          value={voiceText}
          onChange={(e) => setVoiceText(e.target.value.slice(0, VOICE_MAX_TEXT_CHARS))}
          maxLength={VOICE_MAX_TEXT_CHARS}
          rows={4}
          aria-label="Say it once"
          className="mt-2 w-full rounded-control border border-border-subtle bg-transparent p-2 text-[14px] text-text-primary"
        />
        <p className="text-[11px] text-text-tertiary mt-1">Type or use the keyboard microphone. Nothing is saved until you press Save.</p>
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={fillFromVoice}
            disabled={voiceBusy || saving || !voiceText.trim()}
            className="px-3 py-1.5 rounded-control border border-border-subtle bg-white/[0.03] hover:bg-white/[0.06] text-[13px] text-text-secondary disabled:opacity-50"
          >
            {voiceBusy ? "Filling…" : "Fill answers"}
          </button>
          <span className="text-[11px] font-mono text-text-tertiary">
            {voiceText.length}/{VOICE_MAX_TEXT_CHARS}
          </span>
        </div>
        {voiceMsg && <p className="text-[12px] text-text-secondary mt-2">{voiceMsg}</p>}
      </details>

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
        {dayBlanks.length > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => apply(null, Object.fromEntries(dayBlanks.map((i) => [i.name, "No" as CheckinAnswer])))}
              className="px-3 py-1.5 rounded-control border border-border-subtle bg-white/[0.03] hover:bg-white/[0.06] text-[13px] text-text-secondary transition-colors"
            >
              No for the other {dayBlanks.length}
            </button>
            <span className="text-[12px] text-text-tertiary">Tap Yes on what happened first.</span>
          </div>
        )}
      </div>

      {coreByCategory.map(([category, items]) => (
        <section key={category} className="mb-6">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2">{category}</h3>
          <div className="rounded-control border border-border-subtle divide-y divide-border-subtle bg-surface-card">
            {items.map((item) => (
              <Row key={item.name} item={item} cell={cells[item.name]} onTap={(name, a) => tap(null, name, a)} fromVoice={isFromVoice(item.name)} />
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
              <p className="text-[12px] text-text-tertiary mb-2">Weekly and rarely-Yes questions. Leave blank unless you did (or deliberately skipped) one {dayName === "Today" ? "today" : "that day"}.</p>
              <div className="rounded-control border border-border-subtle divide-y divide-border-subtle bg-surface-card">
                {extras.map((item) => (
                  <Row key={item.name} item={item} cell={cells[item.name]} onTap={(name, a) => tap(null, name, a)} fromVoice={isFromVoice(item.name)} />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {(delivery.groups.length > 0 || delivery.leftovers.length > 0 || delivery.loadError) && (
        <section className="mb-6">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-1">Uber Eats: how much did you eat?</h3>
          {delivery.groups.length > 0 && (
            <p className="text-[12px] text-text-tertiary mb-2">Saved as you tap. Left as All unless you change it; tap All to confirm.</p>
          )}
          {delivery.groups.map((g) => (
            <div key={g.date} className="mb-3">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[11px] font-mono text-text-secondary">
                  {g.date === data.date ? labelDay(g.date) : `${labelDay(g.date)} · not answered yet`}
                </span>
                {g.totalKcal != null && (
                  <span className="text-[11px] font-mono text-text-tertiary">~{Math.round(g.totalKcal)} kcal counted</span>
                )}
              </div>
              <DeliveryDishList items={g.items} onPick={delivery.setFraction} />
            </div>
          ))}
          {delivery.leftovers.length > 0 && (
            <div className="mb-3">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[11px] font-mono text-text-secondary">
                  Leftovers · {labelDay(data.date)}
                </span>
                {delivery.leftoverKcal != null && (
                  <span className="text-[11px] font-mono text-text-tertiary">~{Math.round(delivery.leftoverKcal)} kcal counted</span>
                )}
              </div>
              <p className="text-[12px] text-text-tertiary mb-2">
                Share of what was left. Add the time so it counts for meal timing. Unanswered counts as thrown out.
              </p>
              <LeftoverList
                questions={delivery.leftovers}
                onPick={delivery.setLeftover}
                onTime={delivery.setLeftoverTime}
                showNow={data.date === data.today}
              />
            </div>
          )}
          {delivery.loadError && <p className="text-[12px] text-red-400 mt-1.5">{delivery.loadError}</p>}
          {delivery.error && <p className="text-[12px] text-red-400 mt-1.5">{delivery.error}</p>}
        </section>
      )}

      {/* Save bar: sticks above the mobile tab bar */}
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] md:bottom-4 z-10 mt-8">
        <div className="rounded-card border border-border-subtle bg-surface-card/95 backdrop-blur px-4 py-3 flex items-center gap-3 shadow-lg">
          <div className="flex-1 min-w-0 text-[13px]">
            {visibleError ? (
              <span className="text-red-400">{visibleError}</span>
            ) : savedAt === data.date && changeCount === 0 ? (
              <span className="text-text-secondary inline-flex items-center gap-1.5">
                <Check className="w-4 h-4 text-up" /> Saved
                {catchUp && (
                  <button onClick={() => goTo(catchUp.date)} className="ml-2 text-accent underline underline-offset-2">
                    Catch up {labelDay(catchUp.date).toLowerCase()}
                  </button>
                )}
              </span>
            ) : changeCount === 0 ? (
              <span className="text-text-tertiary">Nothing to save yet</span>
            ) : (
              <span className="text-text-secondary">
                {changeCount} change{changeCount === 1 ? "" : "s"}
                {coreLeft > 0 && <span className="text-text-tertiary"> · {coreLeft} daytime left blank</span>}
              </span>
            )}
          </div>
          <button
            onClick={save}
            disabled={saving || changeCount === 0}
            className="px-4 py-2 rounded-control text-[14px] font-medium bg-accent text-black disabled:opacity-40 transition-opacity"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Review is local only. Restoring fills the original dated form; a separate Save is still required. */
function DraftRecovery({ entries, page, saving, onReview, onDiscard, onGo }: {
  entries: DatedDraft[];
  page: CheckinPayload | null;
  saving: boolean;
  onReview: (entry: DatedDraft) => void;
  onDiscard: (entry: DatedDraft) => void;
  onGo: (date: string) => void;
}) {
  const [discardDraft, setDiscardDraft] = useState<DatedDraft | null>(null);
  if (!entries.length) return null;
  return (
    <section aria-label="Preserved check-in drafts" className="my-4 rounded-card border border-border-subtle bg-surface-card p-3">
      <h3 className="text-sm font-medium text-text-primary">Review preserved answers</h3>
      <p className="mt-1 text-xs text-text-secondary">These answers are excluded from Save until you review their original dates. Using them fills that dated form; then press Save. You can also select and copy the text.</p>
      {entries.map((entry) => {
        const label = entry.night ? `Night ${entry.date} → ${addDays(entry.date, 1)} morning` : `Daytime ${entry.date}`;
        const target = recoveryTarget(entry, page);
        const selectableDay = !entry.night && page?.days.some((d) => d.date === entry.date);
        return (
          <details key={entry.key} className="mt-3 text-sm">
            <summary className="cursor-pointer text-text-primary">{label} · {Object.keys(entry.draft).length} answers</summary>
            <ul className="mt-2 space-y-1 text-text-secondary">
              {Object.entries(entry.draft).map(([name, e]) => <li key={name}>{name}: <strong>{e.a ?? "Clear answer"}</strong>{e.base !== undefined && <span className="text-text-tertiary"> (saved when tapped: {e.base ?? "not logged"})</span>}</li>)}
            </ul>
            {target ? (
              <button disabled={saving} onClick={() => onReview(entry)} className="mt-2 rounded-control border border-border-subtle px-3 py-2 text-accent disabled:opacity-50">Use answers for {label}</button>
            ) : selectableDay && page?.date !== entry.date ? (
              <button disabled={saving} onClick={() => onGo(entry.date)} className="mt-2 rounded-control border border-border-subtle px-3 py-2 text-accent disabled:opacity-50">Open {entry.date} to review</button>
            ) : (
              <p className="mt-2 text-xs text-text-tertiary">This date or a question is no longer offered in check-in. The draft stays here for review and copying; it will not be moved to another date.</p>
            )}
            <div className="mt-2">
              {discardDraft?.key === entry.key ? <>
                <span className="text-xs text-text-secondary">Discard these unsaved answers for {label}?</span>
                <button disabled={saving} onClick={() => { onDiscard(discardDraft); setDiscardDraft(null); }} className="ml-2 rounded-control border border-border-subtle px-3 py-2 text-down">Discard these answers</button>
                <button onClick={() => setDiscardDraft(null)} className="ml-2 rounded-control px-3 py-2 text-text-secondary">Keep draft</button>
              </> : <button disabled={saving} onClick={() => setDiscardDraft(entry)} className="rounded-control border border-border-subtle px-3 py-2 text-text-secondary">Discard draft…</button>}
            </div>
          </details>
        );
      })}
    </section>
  );
}

/** One finished night: which night it is, the one-tap usual kit, then the sleep questions. */
function NightBlock({
  night,
  today,
  unconfirmed,
  catchUp,
  items,
  cells,
  onTap,
  onKit,
}: {
  night: CheckinNight;
  today: string;
  unconfirmed: boolean;
  catchUp: boolean;
  items: CheckinItem[];
  cells: Cells;
  onTap: (name: string, a: CheckinAnswer) => void;
  onKit: (kit: Record<string, CheckinAnswer>) => void;
}) {
  const label = nightLabel(night.date, today);
  // Only the kit questions on screen; "applied" once every one of them matches.
  const kit: Record<string, CheckinAnswer> = {};
  for (const i of items) {
    const a = night.usualKit?.[i.name];
    if (a) kit[i.name] = a;
  }
  const kitSize = Object.keys(kit).length;
  const kitApplied = kitSize > 0 && Object.entries(kit).every(([q, a]) => cells[q]?.answer === a);
  const asked = items.filter((i) => i.group === "core");
  const optional = items.filter((i) => i.group !== "core");
  const done = asked.filter((i) => cells[i.name]).length;

  return (
    <div className="mb-4 last:mb-0">
      {/* The weekday span is the main label: it names the night at any hour ("Last night" alone can be misread before 6 AM). */}
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-[14px] font-medium text-text-primary">
          {unconfirmed ? `${night.date} → ${addDays(night.date, 1)} morning` : label.span}
          {!unconfirmed && <span className="ml-2 text-[11px] font-mono font-normal uppercase tracking-wider text-indigo-200/80">{label.title}</span>}
        </span>
        <span className="text-[11px] font-mono text-text-tertiary shrink-0">{catchUp && done === 0 ? "not answered yet" : `${done}/${asked.length}`}</span>
      </div>
      {kitSize > 0 && (
        <button
          onClick={() => onKit(kit)}
          disabled={kitApplied}
          className={`w-full mb-2 px-3 py-2.5 rounded-control border text-left transition-colors ${
            kitApplied ? "border-accent/40 bg-accent/10" : "border-border-subtle bg-white/[0.03] hover:bg-white/[0.06]"
          }`}
        >
          <span className={`text-[14px] font-medium inline-flex items-center gap-1.5 ${kitApplied ? "text-accent" : "text-text-primary"}`}>
            {kitApplied && <Check className="w-4 h-4" />} Usual kit
          </span>
          <span className="block text-[12px] text-text-tertiary mt-0.5">{kitSummary(kit)}</span>
        </button>
      )}
      <div className="rounded-control border border-border-subtle divide-y divide-border-subtle bg-surface-card">
        {asked.map((item) => (
          <Row key={item.name} item={item} cell={cells[item.name]} onTap={onTap} />
        ))}
      </div>
      {optional.length > 0 && (
        <>
          <p className="text-[11px] text-text-tertiary mt-2 mb-1">Optional. Leave blank unless it happened.</p>
          <div className="rounded-control border border-border-subtle divide-y divide-border-subtle bg-surface-card/60">
            {optional.map((item) => (
              <Row key={item.name} item={item} cell={cells[item.name]} onTap={onTap} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ item, cell, onTap, fromVoice }: { item: CheckinItem; cell: Cell | undefined; onTap: (name: string, a: CheckinAnswer) => void; fromVoice?: boolean }) {
  const yes = cell?.answer === "Yes";
  const no = cell?.answer === "No";
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <p className="text-[14px] text-text-primary leading-snug">{item.name}</p>
        {fromVoice && <p className="text-[11px] font-mono text-accent/80 mt-0.5">from what you said</p>}
        {cell?.origin === "suggested" && cell.source && <p className="text-[11px] font-mono text-accent/80 mt-0.5">from {cell.source} · tap to change</p>}
      </div>
      <div className="flex gap-1.5 shrink-0">
        <button
          onClick={() => onTap(item.name, "Yes")}
          aria-pressed={yes}
          aria-label={`${item.name}: yes`}
          className={`h-9 w-14 rounded-control border text-[13px] font-medium inline-flex items-center justify-center gap-1 transition-colors ${
            yes ? "bg-accent/20 border-accent/70 text-accent" : "border-border-subtle text-text-tertiary hover:text-text-secondary"
          }`}
        >
          <Check className="w-3.5 h-3.5" /> Yes
        </button>
        <button
          onClick={() => onTap(item.name, "No")}
          aria-pressed={no}
          aria-label={`${item.name}: no`}
          className={`h-9 w-14 rounded-control border text-[13px] font-medium inline-flex items-center justify-center gap-1 transition-colors ${
            no ? "bg-red-500/15 border-red-400/60 text-red-300" : "border-border-subtle text-text-tertiary hover:text-text-secondary"
          }`}
        >
          <X className="w-3.5 h-3.5" /> No
        </button>
      </div>
    </div>
  );
}
