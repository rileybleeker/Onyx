"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Moon, Sun, X } from "lucide-react";
import { agentsApi } from "@/lib/agents-api";
import { sayFromHash, VOICE_MAX_TEXT_CHARS } from "@/lib/checkin-voice";
import { reportCheckinFill, setLogDraft, useLogDrafts } from "@/lib/log-drafts";
import { addDays, fallbackBehavioralToday, kitSummary, nightLabel, Q_JOURNALED, type CheckinAnswer, type CheckinItem, type CheckinNight, type CheckinPayload } from "@/lib/checkin";
import { WINDDOWN_SAVED_EVENT } from "@/lib/sleep-winddown";
import { clientCache } from "@/lib/client-cache";
import { earlyOr } from "@/lib/early-fetch";
import { buildCells, dayComplete, savePlan, visibleNights, voicePatch, type Cell, type Cells, type Patch } from "@/lib/checkin-cells";
import { CheckinDraftStore, dayDraftKey, nightDraftKey, recoveryTarget, type DatedDraft } from "@/lib/checkin-drafts";
import {
  easternDate,
  journalDraftFrom,
  JOURNAL_CONFIDENCES,
  JOURNAL_MAX_BODY_CHARS,
  JOURNAL_MAX_TITLE_CHARS,
  JOURNAL_MAX_TOPICS,
  JOURNAL_MOODS,
  JOURNAL_SOURCES,
  JOURNAL_TOPICS,
  type JournalConfidence,
  type JournalMood,
  type JournalSource,
} from "@/lib/journal-entry";
import { AutosaveRefused } from "@/lib/autosave";
import { useAutosave, type UseAutosave } from "@/lib/use-autosave";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { DeliveryDishList, LeftoverList, useDeliveryDishes } from "@/components/DeliveryPortions";
import ExperimentAdherence from "./ExperimentAdherence";
import { Part, PartGroup, PartGrid } from "@/components/personalize/PartGrid";

// Daily habit check-in (2026-11-07). Yes / No per question; answers save as they are tapped (autosave, 2026-11-15).
// - Saved answers load as-is; questions another source can answer start pre-filled and labeled with that
//   source; everything else starts blank. Blank = not logged (never a "No").
// - Taps are kept as dated local drafts first (the safety copy), then saved a short delay after the last tap
//   (AUTOSAVE_DELAY_MS, so a burst of taps is one request per part). Reopened drafts require review and are never
//   saved until reviewed; storage failures are surfaced. Leaving or hiding the page sends what is waiting.
// - Two parts (2026-11-13, rules in lib/checkin.ts):
//     SLEEP   one block per night that already happened ("Last night", and the night before while it is
//             unanswered). It does not follow the day tabs and never asks about tonight. A night's answers
//             are saved on the behavior day that night closed (last night = yesterday), which is the night
//             the HRV pipeline scores them against. One "Usual kit" tap fills the kit questions with the
//             last answer given to each.
//     DAYTIME the day tabs (today and the two days before). Rarely-Yes questions sit in "Also did";
//             "No for the other N" answers every blank daytime question at once.
//   Kit and "No for the rest" are ordinary taps: drafted, then saved.
// - Each save writes the day and each changed night Riley touched (one request each). Once every core daytime
//   question of the day has a saved answer, the Agents chat is told the day is done so the card settles (once).
// - Delivered Uber Eats restaurant dishes get one extra section, "how much did you eat?": every dish of the
//   day being checked in, plus dishes of the 2 days before whose portion was never set (the harvester runs
//   every 6 h, so a dinner delivered after the 21:30 card usually lands after that evening's check-in and is
//   asked the next evening). It loads on its own after the questions (never delays them), shows nothing when
//   there is nothing to ask, and each tap saves immediately through PATCH /api/delivery/items/[itemId]
//   (its own saves, not the check-in's).
// - "Say it once" (2026-11-14): one dictated or typed note fills the day tab's questions AND last night's sleep
//   block as ordinary taps (they save like taps: his own words), and drafts a journal entry of the same words (the
//   body verbatim, the model's title / mood / confidence / topics) that Riley reviews and saves on its own with
//   "Save to journal" (never automatic: the page drafted it, he did not ask to file it). The iPhone Shortcut opens
//   /check-in#say=<words>: the words land in the box and Fill runs once (its answers then save like taps).

const FROM_VOICE = "from what you said";
const FROM_JOURNAL = "from the journal entry you saved";

/** The journal draft under the box: these words, labels Riley can change, saved only by "Save to journal". */
type JournalForm = {
  date: string;
  title: string;
  mood: JournalMood | null;
  confidence: JournalConfidence;
  topics: string[];
  source: JournalSource;
  body: string;
  status: "draft" | "saving" | "saved";
  url: string | null;
  existing: boolean;
  error: string | null;
};

/** Rows filled by the box (or the saved journal entry), per part: "day:<date>" or "night:<date>". */
type Marks = Record<string, Record<string, { answer: CheckinAnswer; label: string }>>;
// - While an N-of-1 trial runs, the day tab of today (or yesterday, answered the next morning) also asks
//   "Followed today's arm?" (ExperimentAdherence.tsx). It renders nothing when no trial is running, saves
//   each tap at once through /api/experiments/adherence (not part of the check-in's habit save) and never writes a habit.

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
/** Taps save this long after the last one (a burst of taps, the kit, "No for the rest" = one request per part). */
const AUTOSAVE_DELAY_MS = 600;
const STALE_MESSAGE = "A new day started. Unsaved answers are preserved under their original dates. Review them below before using them.";
// The GET this screen makes; its answer is cached under this URL (shared with the warm-up).
const checkinUrl = (date: string | null) => `/api/habits/checkin${date ? `?date=${date}` : ""}`;

/** Personalize id of a question category's part ("health" -> "cat-health"); stable per category name. */
function categoryPartId(category: string): string {
  return `cat-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "general"}`;
}

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

/**
 * `feed`: drawn inside another page instead of on /check-in itself (the /log Check-in section, which the
 * continuous scroll shows; /check-in has no FeedSection of its own). The day tabs then keep the chosen day in this
 * component instead of the address (a router.replace would leave that page for /check-in), and the heading is
 * marked feed-page-heading unless `embedded`.
 *
 * `embedded`: drawn as the Check-in section of /log (app/log/sections/CheckIn.tsx, always with `feed`): a section
 * heading, and words from the Log screen's "Say it" box (lib/log-drafts.ts, "checkin") fill this check-in exactly
 * like this screen's own Say it once (ordinary taps: they save on their own). `omitParts`: parts another /log section
 * covers ("say-it-once", "journal-draft", "uber-eats", "uber-eats-leftovers"), left out. With "journal-draft" left
 * out, the journal draft of this check-in's own Say it once goes to the Log screen's Journal section
 * (lib/log-drafts.ts, "journal"); words handed over by the Log screen's Say it box get none here (that box drafts
 * its own).
 *
 * `earlyRead`: with `feed`, the first load still takes the GET the page's HTML started (lib/early-fetch.ts): the
 * /log section on the routed /log page (lib/log-early.ts), never a copy drawn in the continuous scroll.
 */
export default function CheckInClient({ feed = false, embedded = false, omitParts, earlyRead = false }: { feed?: boolean; embedded?: boolean; omitParts?: readonly string[]; earlyRead?: boolean } = {}) {
  const router = useRouter();
  const params = useSearchParams();
  const [feedDate, setFeedDate] = useState<string | null>(null);
  const requested = feed ? feedDate : params.get("date");
  // The day the screen shows (kept by showDate): a day switch whose save failed puts the URL back on it.
  const shownDate = useRef<string | null>(requested);
  // Switch the day being checked in (null = the server's today).
  const showDate = useCallback((date: string | null) => {
    shownDate.current = date;
    if (feed) setFeedDate(date);
    else router.replace(date ? `/check-in?date=${date}` : "/check-in", { scroll: false });
  }, [feed, router]);
  const headingTestId = feed && !embedded ? "feed-page-heading" : undefined;
  const headingClass = embedded ? "text-[15px] font-medium text-text-primary" : "text-[28px] font-medium text-text-primary";
  const omit = new Set(omitParts ?? []);
  // On /log the check-in lines up with the other sections (full width); on its own page it keeps its column.
  const wrapClass = embedded ? "" : "max-w-xl";

  const [data, setData] = useState<CheckinPayload | null>(null);
  const [cells, setCells] = useState<Cells>({}); // the day tab's questions
  const [nightCells, setNightCells] = useState<Record<string, Cells>>({}); // sleep questions, per night
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showExtras, setShowExtras] = useState(false);
  const [drafts] = useState(() => new CheckinDraftStore(() => localStorage));
  const [recovery, setRecovery] = useState<DatedDraft[]>([]);
  const [storageFailed, setStorageFailed] = useState(false);
  const refreshDrafts = useCallback(() => {
    setRecovery(drafts.recovery());
    setStorageFailed(drafts.storageFailed);
  }, [drafts]);
  // Inside /log the Uber Eats section asks these (omitParts): no second read of the same dishes.
  const deliveryOmitted = omit.has("uber-eats") && omit.has("uber-eats-leftovers");
  const delivery = useDeliveryDishes(deliveryOmitted ? null : data?.date ?? null, { earlierDays: 2 });
  const [voiceText, setVoiceText] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [marks, setMarks] = useState<Marks>({});
  const [journal, setJournal] = useState<JournalForm | null>(null);
  const journalRef = useRef<JournalForm | null>(null);
  journalRef.current = journal;
  // Words handed over by the iPhone Shortcut (#say=), waiting for the check-in to load.
  const [handoff, setHandoff] = useState<string | null>(null);
  const dataRef = useRef<CheckinPayload | null>(null);
  dataRef.current = data;
  const dataDateRef = useRef<string | null>(null);
  dataDateRef.current = data?.date ?? null;
  // "Say it once" answers arrive after a round trip. They are merged into the cells as they are THEN, and never
  // over a row changed meanwhile: every change bumps `editGen` and stamps the rows it touched, per part
  // ("day", or the night's date).
  const cellsRef = useRef<Cells>({});
  cellsRef.current = cells;
  const nightCellsRef = useRef<Record<string, Cells>>({});
  nightCellsRef.current = nightCells;
  const editGen = useRef(0);
  const lastEdit = useRef<Record<string, Record<string, number>>>({});
  const changedSince = (part: string, since: number) =>
    new Set(Object.entries(lastEdit.current[part] ?? {}).filter(([, gen]) => gen > since).map(([name]) => name));

  const lastLoad = useRef(0);
  const savingRef = useRef(false);
  const deferredLoad = useRef<{ date: string | null } | null>(null);
  const skipRevertFlush = useRef(false);

  const loadSeq = useRef(0);
  // Set once a GET answered: a cached copy is shown only before that.
  const answeredRef = useRef(false);

  // Autosave (2026-11-15, lib/autosave.ts): every tap bumps the revision and the scheduler runs save() a short
  // delay after the last one; single flight, so a tap made mid-save is sent by the next run. save() reads the
  // newest render (the hook always calls the latest options). Nothing calls queueSave on open or on scroll.
  const revision = useRef(0);
  const settledDays = useRef(new Set<string>());
  const autosave = useAutosave<number>("checkin", {
    delayMs: AUTOSAVE_DELAY_MS,
    save: (_rev, { keepalive }) => save(keepalive),
  });
  const autosaveRef = useRef<UseAutosave<number>>(autosave);
  autosaveRef.current = autosave;
  const queueSave = () => autosaveRef.current.change(++revision.current);

  // Draw the screen from a check-in answer (fresh, or the cached copy shown while the fresh one loads).
  const show = useCallback((payload: CheckinPayload) => {
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
  }, [drafts]);

  const load = useCallback(async (date: string | null, afterSave = false) => {
    // The load that puts the URL back on the shown day (below) must not save the failed tap again: its retry timer
    // (autosave backoff) sends it. Taken once, by that load only.
    const afterRevert = skipRevertFlush.current;
    skipRevertFlush.current = false;
    // A tap still waiting to be saved goes first, under the day it was made on: the GET below replaces the screen.
    // If that save failed (or was refused) and this load would switch to another day, the screen stays on its day
    // with the draft and the save-failed line (Retry) shown; nothing is replaced. A same-day refresh (resume, clock
    // check) still goes on to the GET, so an authoritative refusal (400/401/403) or a new day is still noticed.
    if (!afterSave && !afterRevert && !(await autosaveRef.current.flush().catch(() => false)) && date !== shownDate.current) {
      // Back/forward may already have moved the URL to the other day: put it back on the day still on screen.
      // A retry is armed for the failed save: the URL change reloads this day, and that load must not resend it at once.
      skipRevertFlush.current = autosaveRef.current.state.retrying;
      showDate(shownDate.current);
      return;
    }
    // Back/forward can change the URL while a save runs. Finish the dated save first.
    if (savingRef.current && !afterSave) {
      deferredLoad.current = { date };
      return;
    }
    lastLoad.current = Date.now();
    const seq = ++loadSeq.current; // a newer load (tab switch, resume) makes this one's result irrelevant
    setError(null);
    try {
      const url = checkinUrl(date);
      // The first load of a full page visit takes the GET the page's HTML already started (lib/early-fetch.ts):
      // /check-in itself, or the /log section on the routed /log page (`earlyRead`).
      // A 401, a redirect to sign-in or a network error is fetched again, so session-end handling still sees it.
      const get = () => fetch(url, { cache: "no-store" });
      const res = await ((feed && !earlyRead) || afterSave ? get() : earlyOr(url, get));
      const json = await res.json().catch(() => ({}));
      if (seq !== loadSeq.current) return;
      if (!res.ok) {
        // A rejected date/session is unusable. A transient outage leaves the last loaded form editable,
        // still on its original dates; POST's `today` guard remains the authority on rollover.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          drafts.holdAll();
          setData(null);
          clientCache.remove(url); // the server refused it: never show that cached copy again
        }
        setRefreshFailed(true);
        setError(`Couldn't load the check-in (${res.status}).`);
        return;
      }
      const payload = json as CheckinPayload;
      answeredRef.current = true;
      clientCache.put(url, payload);
      show(payload);
    } catch {
      if (seq === loadSeq.current) {
        setRefreshFailed(true);
        setError("Couldn't reach Onyx. Check your connection and try again.");
      }
    }
    finally { if (seq === loadSeq.current) refreshDrafts(); }
  }, [drafts, refreshDrafts, show, feed, earlyRead]);

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
    // Show the cached copy at once while the GET runs, but only when it is for the current behavioral day and
    // no unsaved tap is waiting for one of its days or nights: such a draft is always judged against a fresh answer. The POST's `today` guard and
    // the drafts' stored-answer check still protect a tap made on the cached copy.
    let alive = true;
    answeredRef.current = false;
    const seed = (cached: CheckinPayload | undefined) => {
      if (!alive || !cached || answeredRef.current || !Array.isArray(cached.items)) return;
      // A tap waiting to be saved (or being saved) keeps its screen: the save reads the page it was made on.
      if (autosaveRef.current.dirty) return;
      if (cached.today !== fallbackBehavioralToday(new Date())) return;
      // Only drafts for the day and nights this copy shows matter (an old held draft for another date does not).
      const parts = [dayDraftKey(cached.date), ...(cached.nights ?? []).map((n) => nightDraftKey(n.date))];
      if (parts.some((key) => Object.keys(drafts.read(key)).length > 0)) return;
      show(cached);
    };
    const hit = clientCache.peek<CheckinPayload>(checkinUrl(requested));
    if (hit) seed(hit);
    else void clientCache.read<CheckinPayload>(checkinUrl(requested)).then(seed);
    load(requested);
    // A page left open (or an installed app resumed) keeps the `today` it loaded with, so after the day rolls
    // over its "Last night" would be the night before. Reload on return; unsaved taps come back from the drafts.
    const back = () => {
      if (document.visibilityState === "visible" && !savingRef.current && Date.now() - lastLoad.current > RELOAD_AFTER_MS) load(requested);
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("pageshow", back);
    // The wind-down button (/log, Today) writes the same habit row: show its answer here (unsaved taps stay drafts).
    const answeredElsewhere = () => { if (!savingRef.current && !autosaveRef.current.dirty) load(requested); };
    window.addEventListener(WINDDOWN_SAVED_EVENT, answeredElsewhere);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("pageshow", back);
      window.removeEventListener(WINDDOWN_SAVED_EVENT, answeredElsewhere);
    };
  }, [load, requested, drafts, show]);

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
    queueSave(); // saved a short delay after the last tap
    const gen = ++editGen.current;
    const stamps = (lastEdit.current[scope ?? "day"] ??= {});
    for (const name of Object.keys(patch)) stamps[name] = gen;
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

  // The newest apply (it reads the current data), for answers that arrive after a round trip.
  const applyRef = useRef(apply);
  applyRef.current = apply;

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
  const dayItemsRef = useRef<CheckinItem[]>([]);
  dayItemsRef.current = dayItems;
  const sleepItemsRef = useRef<CheckinItem[]>([]);
  sleepItemsRef.current = sleepItems;

  // Last night always; an earlier night while it is incomplete or holds an unsaved tap (lib/checkin-cells.ts).
  const nights = useMemo(() => visibleNights(data?.nights ?? [], sleepItems, nightCells), [data, sleepItems, nightCells]);

  const coreDone = core.filter((i) => cells[i.name]).length;
  const coreLeft = core.length - coreDone;
  const dayBlanks = core.filter((i) => !cells[i.name]);

  // What each autosave sends: only the parts Riley touched; on behavioral today, the day's pre-fills only once the
  // day is complete counting them (see savePlan).
  const dayIsToday = !!data && data.date === data.today;
  const { dayPatch, nightPatches, changeCount } = useMemo(
    () => savePlan({ dayItems, dayAnswers: data?.answers ?? {}, cells, sleepItems, nights, nightCells, dayIsToday }),
    [data, dayItems, cells, sleepItems, nights, nightCells, dayIsToday]
  );

  // Run by the autosave scheduler only (never on open): the newest render's plan. Throws so the scheduler shows
  // the failure: AutosaveRefused for a refusal (not retried until the next tap), anything else is retried.
  const save = async (keepalive = false) => {
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
        keepalive,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        if (res.status === 409 && json.stale) throw new StaleDayError("A new day started since this page loaded. Reload the page to continue.");
        const message = `Save failed (${res.status}). Your answers are still here.`;
        // A refusal (bad date, a sleep answer for tonight) is not retried until the next tap; an outage is.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new AutosaveRefused(message);
        throw new Error(message);
      }
    };
    try {
      // The day, then each night under ITS date. Only successful requests settle their draft snapshots.
      if (Object.keys(dayPatch).length) {
        await post(data.date, dayPatch);
        settled(data.date, dayPatch, false);
        // Settle the Agents card once every core daytime question has a saved answer, once per day (best-effort;
        // the card also expires on its own). A half-answered day keeps its card.
        if (dayComplete(dayItems, withAnswers(data.answers, dayPatch)) && !settledDays.current.has(data.date)) {
          settledDays.current.add(data.date);
          agentsApi.checkinDone(data.date).catch(() => {});
        }
      }
      for (const n of nightPatches) {
        await post(n.date, n.changes);
        settled(n.date, n.changes, true);
      }
      await load(data.date, true);
    } catch (e) {
      if (e instanceof StaleDayError) {
        // Keep every unfinished tap under its original date, outside autosave until explicitly reviewed.
        drafts.holdAll();
        refreshDrafts();
        setData(null);
        showDate(null);
        await load(null, true);
        setSaveError(STALE_MESSAGE);
        throw new AutosaveRefused(STALE_MESSAGE); // nothing to retry: the preserved answers wait for review
      }
      throw e; // shown by the status line ("Couldn't reach Onyx." for a network failure) and retried
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

  // Safety net: active answers on screen that no save is handling (none waiting, saving or failing). Drafts from an
  // earlier visit never get here (they are held for review), so this is rare; it offers a one-tap "Save now" and is
  // never sent on its own. Any tap in that part sends them anyway.
  const unsent = changeCount > 0 && autosave.state.status !== "waiting" && autosave.state.status !== "saving" && autosave.state.status !== "error";
  const saveUnsent = () => {
    queueSave();
    void autosaveRef.current.flush();
  };

  const addMarks = (part: string, patch: Patch, label: string) =>
    setMarks((prev) => {
      const next = { ...(prev[part] ?? {}) };
      for (const [name, a] of Object.entries(patch)) if (a) next[name] = { answer: a, label };
      return { ...prev, [part]: next };
    });
  // The note stays while the row still holds the answer it was filled with; any change by Riley removes it.
  const noteFor = (part: string, name: string, cell: Cell | undefined) => {
    const m = marks[part]?.[name];
    return m && cell && cell.answer === m.answer ? m.label : undefined;
  };

  // The journal draft for these words (the body is the text itself) with the model's labels. Not over an entry
  // being saved, nor over one already saved from the same words.
  const offerJournal = (date: string, text: string, labels: unknown): boolean => {
    if (omit.has("journal-draft")) {
      // /log: the Journal section holds journal drafts (same words, verbatim; the model's labels as suggestions).
      const l = journalDraftFrom(labels);
      setLogDraft("journal", { body: text, source: "voice", title: l.title || null, mood: l.mood, confidence: l.confidence, topics: l.topics }, text);
      return true;
    }
    const cur = journalRef.current;
    if (cur?.status === "saving" || (cur?.status === "saved" && cur.body === text)) return false;
    const l = journalDraftFrom(labels);
    setJournal({ date, title: l.title, mood: l.mood, confidence: l.confidence, topics: l.topics, source: "voice", body: text, status: "draft", url: null, existing: false, error: null });
    return true;
  };

  // "Say it once": the server maps the text to Yes/No answers for the day tab and for last night (it writes
  // nothing); they become ordinary taps, saved like taps. Rows saved or tapped by the time the answer arrives, or changed while
  // it was read, are never overwritten (voicePatch); a data pre-fill is. The answer buttons stay live while it fills.
  // Sleep answers go only into the night block on screen with the date the server named, a night already over.
  const fillFromVoice = async (given?: string) => {
    const page = dataRef.current;
    const text = (given ?? voiceText).trim();
    if (!page || voiceBusy || !text) return;
    const date = page.date;
    const sentAt = editGen.current;
    setVoiceBusy(true);
    setVoiceMsg(null);
    try {
      const res = await fetch("/api/habits/checkin/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, text, today: page.today }),
      });
      const json = await res.json().catch(() => ({}));
      if (date !== dataDateRef.current) return; // switched day meanwhile: drop it
      if (res.status === 409 && json.stale) {
        // The day rolled over since the page was drawn: "last night" moved. Reload today, then fill again.
        setVoiceMsg("A new day started since this page loaded. It has reloaded; press Fill answers again.");
        if (requested) showDate(null);
        else void load(null);
        return;
      }
      if (!res.ok || json.failed || !json.answers || typeof json.answers !== "object") {
        setVoiceMsg("Couldn't read that, try again.");
        return;
      }
      const now = dataRef.current ?? page;
      const changed = changedSince("day", sentAt);
      const patch = voicePatch(dayItemsRef.current, json.answers as Record<string, unknown>, cellsRef.current, changed);
      const dayN = Object.keys(patch).length;
      if (dayN) {
        applyRef.current(null, patch);
        addMarks(`day:${date}`, patch, FROM_VOICE);
      }
      let nightN = 0;
      const night = json.night as { date?: unknown; answers?: unknown } | null | undefined;
      if (
        night && typeof night.date === "string" && night.answers && typeof night.answers === "object" &&
        night.date < now.today && now.nights.some((n) => n.date === night.date)
      ) {
        const nightDate = night.date;
        const nightPatch = voicePatch(sleepItemsRef.current, night.answers as Record<string, unknown>, nightCellsRef.current[nightDate] ?? {}, changedSince(nightDate, sentAt));
        nightN = Object.keys(nightPatch).length;
        if (nightN) {
          applyRef.current(nightDate, nightPatch);
          addMarks(`night:${nightDate}`, nightPatch, FROM_VOICE);
        }
      }
      // Words from the Log screen's Say it box (`given` while embedded): that box drafts its own journal entry.
      const fromLogSayIt = embedded && given !== undefined;
      const journalNote = fromLogSayIt
        ? ""
        : offerJournal(date, text, json.journal)
          ? omit.has("journal-draft") ? " A journal draft of your words is in Journal." : " A journal draft of your words is below."
          : "";
      const n = dayN + nightN;
      if (n === 0) {
        setVoiceMsg((changed.size ? "Nothing new to fill: you already answered those." : "Nothing in the text matched a question.") + journalNote);
        return;
      }
      setVoiceMsg(`Filled ${n} answer${n === 1 ? "" : "s"}${nightN ? ` (${nightN} for last night)` : ""}. They save on their own; tap one to change it.${journalNote}`);
    } catch {
      setVoiceMsg("Couldn't read that, try again.");
    } finally {
      setVoiceBusy(false);
    }
  };

  // iPhone Shortcut hand-off: /check-in#say=<URL-encoded words>. The words go in the box and Fill runs once the
  // check-in has loaded fresh (Fill itself writes nothing; the answers it fills then save like taps). The hash is removed at once, so a reload doesn't fill again
  // and the words don't stay in the address bar. Not in the continuous scroll (it doesn't own the address).
  useEffect(() => {
    if (feed) return;
    const words = sayFromHash(window.location?.hash ?? "");
    if (words === null) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setVoiceText(words);
    setVoiceOpen(true);
    setHandoff(words);
  }, [feed]);
  const fillRef = useRef(fillFromVoice);
  fillRef.current = fillFromVoice;
  useEffect(() => {
    if (handoff === null || !data || refreshFailed || !answeredRef.current) return; // not on a cached copy
    setHandoff(null);
    void fillRef.current(handoff);
  }, [handoff, data, refreshFailed]);
  // /log: the Log screen's Say it box hands its words over the same way (taken once, then cleared).
  const { draft: logDraft, clear: clearLogDraft } = useLogDrafts("checkin");
  // Set once this check-in took words from the Log Say it box (a remount after that leaves the box's result alone).
  const tookLogWords = useRef(false);
  useEffect(() => {
    if (!embedded || !logDraft) return;
    clearLogDraft(logDraft.id);
    const words = logDraft.value.text.trim().slice(0, VOICE_MAX_TEXT_CHARS);
    if (!words) return;
    tookLogWords.current = true;
    setVoiceMsg(null);
    setVoiceText(words);
    setVoiceOpen(true);
    setHandoff(words);
  }, [embedded, logDraft, clearLogDraft]);
  // /log leaves out this screen's Say it once box, where the fill's result is written: the Log Say it box shows it.
  useEffect(() => {
    if (!embedded || !tookLogWords.current) return;
    // Words waiting for a check-in that could not load fresh are never filled into a stale copy: say so.
    if (handoff !== null && !voiceBusy && refreshFailed) {
      reportCheckinFill({ pending: false, message: "Not filled yet: the check-in couldn't load. It fills once the check-in loads." });
      return;
    }
    reportCheckinFill({ pending: voiceBusy || handoff !== null, message: voiceMsg });
  }, [embedded, voiceBusy, handoff, voiceMsg, refreshFailed]);

  // "Journaled your thoughts?" once the entry for the day on screen is saved: a Yes like any other tap (so it
  // saves on its own), never over a saved or tapped answer.
  const markJournaled = (date: string) => {
    if (dataRef.current?.date !== date) return;
    const patch = voicePatch(dayItemsRef.current.filter((i) => i.name === Q_JOURNALED), { [Q_JOURNALED]: "Yes" }, cellsRef.current, new Set());
    if (!Object.keys(patch).length) return;
    applyRef.current(null, patch);
    addMarks(`day:${date}`, patch, FROM_JOURNAL);
  };

  // "Save to journal": the only write of the journal draft (POST /api/journal/entry creates the Notion entry).
  const saveJournal = async () => {
    const j = journalRef.current;
    if (!j || j.status !== "draft") return;
    setJournal({ ...j, status: "saving", error: null });
    try {
      const res = await fetch("/api/journal/entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: j.date, title: j.title, mood: j.mood, confidence: j.confidence, source: j.source, topics: j.topics, body: j.body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json || typeof json !== "object" || !("url" in json)) {
        setJournal((cur) => cur && { ...cur, status: "draft", error: `Couldn't save the journal entry (${res.status}). It is still here.` });
        return;
      }
      setJournal((cur) => cur && { ...cur, status: "saved", url: typeof json.url === "string" ? json.url : null, existing: !!json.existing });
      markJournaled(j.date);
    } catch {
      setJournal((cur) => cur && { ...cur, status: "draft", error: "Couldn't reach Onyx. The entry is still here." });
    }
  };

  // A tap still waiting is saved under its own day before the tab changes (the cached copy of the next day must
  // not be drawn under it). If that save fails, the tab does not change: the draft stays with its day and the
  // save-failed line (Retry) shows.
  const goTo = (date: string) => {
    void autosaveRef.current.flush().catch(() => false).then((saved) => { if (saved) showDate(date); });
  };

  const reviewDraft = (entry: DatedDraft) => {
    if (!data || savingRef.current || !drafts.recover(entry.key, data)) return;
    setError(null);
    setSaveError(null);
    queueSave(); // reviewed: the answers are active again and save like taps
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
      {storageFailed && <p role="alert" className="my-4 text-sm text-mid">Some drafts could not be read or stored in this browser. Answers entered here are kept in this open page, but may be lost if you close or refresh it. Keep it open until it says Saved, or copy the answers.</p>}
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
      <div className={wrapClass}>
        <h2 data-testid={headingTestId} className={headingClass}>Check-in</h2>
        <p className="mt-4 text-sm text-text-secondary">{visibleError}</p>
        {draftRecovery}
        <button
          onClick={() => {
            // No date: the server decides which day it is (before 06:00 the clock date is a day ahead).
            showDate(null);
            load(null);
          }}
          className="mt-4 min-h-11 px-4 text-[13px] bg-white/5 border border-border-subtle rounded-control">
          Go to today
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={`${wrapClass} space-y-3`}>
        {embedded && <h2 className={headingClass}>Check-in</h2>}
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
    <div className={wrapClass}>
      <div className="mb-5">
        <h2 data-testid={headingTestId} className={headingClass}>Check-in</h2>
        <p className="text-sm text-text-tertiary mt-0.5">
          {refreshFailed ? `Showing the last loaded check-in for daytime ${data.date}. Dates are unchanged; refresh could not confirm today's date.` : nights.length > 0
            ? `Two parts. Sleep: ${nightLabel(nights[0].date, data.today).span}. Daytime: ${dayName === "Today" || dayName === "Yesterday" ? `${dayName.toLowerCase()}, ` : ""}${longDate(data.date)}.`
            : `Daytime: ${longDate(data.date)}. Skip anything you're unsure of.`}
        </p>
      </div>

      {draftRecovery}

      {/* Personalize: every block is its own part; sections get no extra heading on screen. The save status bar stays fixed. */}
      <PartGrid page="/check-in" title="Check-in">
      <PartGroup id="section-sleep" title="Sleep">
      {/* SLEEP: nights that already happened. Not tied to the day tabs below. */}
      {nights.length > 0 && (
        <Part id="sleep-nights" title="Sleep (nights that happened)">
        <section className="rounded-card border border-border-default bg-surface-sunken shadow-card p-3" aria-label="Sleep">
          <div className="flex items-center gap-2">
            <Moon aria-hidden="true" className="w-4 h-4 text-text-secondary" />
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
              noteFor={(name, cell) => noteFor(`night:${n.date}`, name, cell)}
              onTap={(name, a) => tap(n.date, name, a)}
              onKit={(kit) => apply(n.date, kit)}
            />
          ))}
        </section>
        </Part>
      )}
      </PartGroup>

      {/* DAYTIME: one behavior day per tab. The heading and the day tabs are the section's header. */}
      <PartGroup id="section-daytime" title="Daytime" gap={24} header={<>
      <div className="flex items-center gap-2 mb-2">
        <Sun aria-hidden="true" className="w-4 h-4 text-text-secondary" />
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
              onClick={() => goTo(d.date)}
              className={`flex-1 min-h-11 px-3 py-2 rounded-control border text-left transition-colors ${
                active ? "border-accent/60 bg-accent/10" : "border-border-subtle bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <div className={`text-[13px] font-medium ${active ? "text-text-primary" : "text-text-secondary"}`}>{labelDay(d.date)}</div>
              <div className="text-[11px] font-mono text-text-tertiary">{complete ? "done" : d.answered ? `${d.answered}/${d.total}` : "not started"}</div>
            </button>
          );
        })}
      </div>
      </>}>

      {/* Say it once: dictated text -> Yes/No taps for the day and last night (saved like taps), and a journal draft (saved only with Save to journal) */}
      {!omit.has("say-it-once") && <Part id="say-it-once" title="Say it once">
      <details
        open={voiceOpen}
        onToggle={(e) => setVoiceOpen(e.currentTarget.open)}
        className="rounded-control border border-border-subtle bg-white/[0.02] px-3 py-2"
      >
        <summary className="cursor-pointer py-3 text-[13px] leading-5 text-text-secondary">Say it once</summary>
        <textarea
          value={voiceText}
          onChange={(e) => setVoiceText(e.target.value.slice(0, VOICE_MAX_TEXT_CHARS))}
          maxLength={VOICE_MAX_TEXT_CHARS}
          rows={4}
          aria-label="Say it once"
          className="mt-2 w-full rounded-control border border-border-subtle bg-transparent p-2 text-[14px] text-text-primary"
        />
        <p className="text-[11px] text-text-tertiary mt-1">
          Type or use the keyboard microphone: the day, and last night&apos;s sleep. It fills answers, which save on their own like taps, and drafts a journal entry of your words, which is saved only when you press Save to journal.
        </p>
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={() => fillFromVoice()}
            disabled={voiceBusy || !voiceText.trim()}
            className="min-h-11 px-4 rounded-control border border-border-subtle bg-white/[0.03] hover:bg-white/[0.06] text-[13px] text-text-secondary disabled:opacity-50"
          >
            {voiceBusy ? "Filling…" : "Fill answers"}
          </button>
          <span className="text-[11px] font-mono text-text-tertiary">
            {voiceText.length}/{VOICE_MAX_TEXT_CHARS}
          </span>
        </div>
        {voiceMsg && <p className="text-[12px] text-text-secondary mt-2">{voiceMsg}</p>}
      </details>
      </Part>}

      {journal && !omit.has("journal-draft") && (
        <Part id="journal-draft" title="Journal entry draft">
        <JournalDraftCard
          form={journal}
          maxDate={easternDate(new Date())}
          onChange={(change) => setJournal((cur) => (cur && cur.status === "draft" ? { ...cur, ...change, error: null } : cur))}
          onSave={() => saveJournal()}
          onDiscard={() => setJournal((cur) => (cur?.status === "saving" ? cur : null))}
        />
        </Part>
      )}

      {/* Progress */}
      <Part id="progress" title="Progress, No for the rest, trial question">
      <div>
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
              className="min-h-11 px-4 rounded-control border border-border-subtle bg-white/[0.03] hover:bg-white/[0.06] text-[13px] text-text-secondary transition-colors"
            >
              No for the other {dayBlanks.length}
            </button>
            <span className="text-[12px] text-text-tertiary">Tap Yes on what happened first.</span>
          </div>
        )}
      </div>
      {/* N-of-1 trial: "Followed today's arm?" Renders nothing unless a trial is running, so it rides in this part
          (an empty part of its own would still take a grid gap). The wrapper collapses when it renders nothing. */}
      {!refreshFailed && (data.date === data.today || data.date === addDays(data.today, -1)) && (
        <div className="mt-6 empty:hidden [&>section]:mb-0">
          <ExperimentAdherence key={data.date} date={data.date} when={data.date === data.today ? "today" : "yesterday"} />
        </div>
      )}
      </Part>

      {/* One part per question category (the id follows the category name, so its saved place sticks). */}
      {coreByCategory.map(([category, items]) => (
        <Part key={category} id={categoryPartId(category)} title={`${category.charAt(0).toUpperCase()}${category.slice(1)} questions`}>
        <section>
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2">{category}</h3>
          <div className="rounded-control border border-border-subtle divide-y divide-border-subtle bg-surface-card">
            {items.map((item) => (
              <Row key={item.name} item={item} cell={cells[item.name]} onTap={(name, a) => tap(null, name, a)} note={noteFor(`day:${data.date}`, item.name, cells[item.name])} />
            ))}
          </div>
        </section>
        </Part>
      ))}

      {extras.length > 0 && (
        <Part id="also-did" title="Also did">
        <section>
          <button onClick={() => setShowExtras((s) => !s)} aria-expanded={showExtras} className="min-h-11 flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-1">
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showExtras ? "" : "-rotate-90"}`} />
            Also did ({extras.filter((i) => cells[i.name]).length}/{extras.length})
          </button>
          {showExtras && (
            <>
              <p className="text-[12px] text-text-tertiary mb-2">Weekly and rarely-Yes questions. Leave blank unless you did (or deliberately skipped) one {dayName === "Today" ? "today" : "that day"}.</p>
              <div className="rounded-control border border-border-subtle divide-y divide-border-subtle bg-surface-card">
                {extras.map((item) => (
                  <Row key={item.name} item={item} cell={cells[item.name]} onTap={(name, a) => tap(null, name, a)} note={noteFor(`day:${data.date}`, item.name, cells[item.name])} />
                ))}
              </div>
            </>
          )}
        </section>
        </Part>
      )}

      {!omit.has("uber-eats") && (delivery.groups.length > 0 || delivery.loadError) && (
        <Part id="uber-eats" title="Uber Eats: how much did you eat?">
        <section>
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
          {delivery.loadError && <p className="text-[12px] text-down mt-1.5">{delivery.loadError}</p>}
          {delivery.error && <p className="text-[12px] text-down mt-1.5">{delivery.error}</p>}
        </section>
        </Part>
      )}

      {!omit.has("uber-eats-leftovers") && delivery.leftovers.length > 0 && (
        <Part id="uber-eats-leftovers" title="Uber Eats leftovers">
        <section>
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-1">Uber Eats: leftovers</h3>
            <div>
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
          {/* A failed tap shows here when the dishes part is not on screen. */}
          {delivery.error && !(delivery.groups.length > 0 || delivery.loadError) && <p className="text-[12px] text-down mt-1.5">{delivery.error}</p>}
        </section>
        </Part>
      )}
      </PartGroup>
      </PartGrid>

      {/* Save status: sticks above the mobile tab bar. Answers save as they are tapped; this says how that went. */}
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] md:bottom-4 z-10 mt-8">
        <div className="rounded-card border border-border-subtle bg-surface-card/95 backdrop-blur px-4 py-3 flex items-center gap-3 shadow-elevated min-h-[3.75rem]">
          <div className="flex-1 min-w-0 text-[13px]">
            {visibleError && <span className="text-down">{visibleError} </span>}
            {unsent ? (
              <span className="text-text-secondary">
                {changeCount} answer{changeCount === 1 ? "" : "s"} from earlier not saved yet
              </span>
            ) : (
              // The stale refusal is already the visible error; its status line would only repeat it.
              !(autosave.state.status === "error" && autosave.state.error === saveError) && (
                <>
                  <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} className="text-[13px]" />
                  {autosave.state.status === "idle" && !visibleError && (
                    <span className="text-text-tertiary">Answers save as you tap</span>
                  )}
                  {autosave.state.status === "saved" && changeCount === 0 && (
                    <>
                      {coreLeft > 0 && <span className="text-text-tertiary"> · {coreLeft} daytime left blank</span>}
                      {catchUp && (
                        <button onClick={() => goTo(catchUp.date)} className="ml-2 min-h-11 text-accent underline underline-offset-2">
                          Catch up {labelDay(catchUp.date).toLowerCase()}
                        </button>
                      )}
                    </>
                  )}
                </>
              )
            )}
          </div>
          {unsent && (
            <button
              onClick={saveUnsent}
              className="min-h-11 px-5 rounded-full text-[14px] font-semibold bg-accent text-on-accent transition-opacity"
            >
              Save now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Review is local only until Riley picks it: using a draft fills the original dated form, which then saves like taps. */
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
      <p className="mt-1 text-xs text-text-secondary">These answers are not saved until you review their original dates. Using them fills that dated form and saves them there. You can also select and copy the text.</p>
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
  noteFor,
  onTap,
  onKit,
}: {
  night: CheckinNight;
  today: string;
  unconfirmed: boolean;
  catchUp: boolean;
  items: CheckinItem[];
  cells: Cells;
  noteFor: (name: string, cell: Cell | undefined) => string | undefined;
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
          {!unconfirmed && <span className="ml-2 text-[11px] font-mono font-normal uppercase tracking-wider text-text-tertiary">{label.title}</span>}
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
          <Row key={item.name} item={item} cell={cells[item.name]} onTap={onTap} note={noteFor(item.name, cells[item.name])} />
        ))}
      </div>
      {optional.length > 0 && (
        <>
          <p className="text-[11px] text-text-tertiary mt-2 mb-1">Optional. Leave blank unless it happened.</p>
          <div className="rounded-control border border-border-subtle divide-y divide-border-subtle bg-surface-card/60">
            {optional.map((item) => (
              <Row key={item.name} item={item} cell={cells[item.name]} onTap={onTap} note={noteFor(item.name, cells[item.name])} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Yes and No are both valid answers: either one, when chosen, uses the accent selection (never red, which
// would read as "bad"). A data pre-fill is a suggestion until Riley taps: dashed outline, no fill.
function answerStyle(selected: boolean, suggested: boolean): string {
  if (!selected) return "border-border-subtle text-text-tertiary hover:text-text-secondary";
  return suggested ? "border-dashed border-accent/60 text-accent" : "bg-accent/20 border-accent/70 text-accent";
}

/** The journal draft: the words as written (editable), the labels the journal requires, one explicit save. */
function JournalDraftCard({
  form,
  maxDate,
  onChange,
  onSave,
  onDiscard,
}: {
  form: JournalForm;
  maxDate: string;
  onChange: (change: Partial<Pick<JournalForm, "date" | "title" | "mood" | "confidence" | "topics" | "source" | "body">>) => void;
  onSave: () => void | Promise<void>;
  onDiscard: () => void;
}) {
  const busy = form.status === "saving";
  const ready = !!form.title.trim() && !!form.mood && form.topics.length > 0 && !!form.body.trim();
  const missing = [!form.title.trim() && "a title", !form.mood && "a mood", !form.topics.length && "a topic"].filter(Boolean).join(", ");
  const addable = JOURNAL_TOPICS.filter((t) => !form.topics.includes(t));
  const field = "mt-1 w-full rounded-control border border-border-subtle bg-transparent p-2 text-[14px] text-text-primary disabled:opacity-60";
  const label = "block text-[11px] font-mono uppercase tracking-wider text-text-tertiary";

  if (form.status === "saved") {
    return (
      <section aria-label="Journal entry" className="rounded-card border border-border-subtle bg-surface-card p-3">
        <p className="text-[13px] text-text-secondary inline-flex flex-wrap items-center gap-1.5">
          <Check className="w-4 h-4 text-up" />
          {form.existing ? "Already in your journal (same date and title)." : "Saved to your journal."} It shows on Journal after the hourly sync.
          {form.url && (
            <a href={form.url} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
              Open in Notion
            </a>
          )}
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Journal entry" className="rounded-card border border-border-subtle bg-surface-card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-medium text-text-primary">Journal entry</h3>
        <span className="text-[11px] font-mono text-text-tertiary">draft · not saved</span>
      </div>
      <p className="mt-0.5 text-[12px] text-text-tertiary">Your words as written. Check the title and labels, then save it to the journal, or discard it.</p>

      <label className={`${label} mt-3`}>
        Title
        <input value={form.title} maxLength={JOURNAL_MAX_TITLE_CHARS} disabled={busy} onChange={(e) => onChange({ title: e.target.value })} className={field} />
      </label>
      <label className={`${label} mt-3`}>
        Date
        <input type="date" value={form.date} max={maxDate} disabled={busy} onChange={(e) => e.target.value && onChange({ date: e.target.value })} className={field} />
      </label>
      <Choice label="Mood" options={JOURNAL_MOODS} value={form.mood} disabled={busy} onPick={(mood) => onChange({ mood })} />
      <Choice label="How sure" options={JOURNAL_CONFIDENCES} value={form.confidence} disabled={busy} onPick={(confidence) => onChange({ confidence })} />

      <div className="mt-3" role="group" aria-label="Topics">
        <div className={label}>Topics</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {form.topics.map((t) => (
            <button
              key={t}
              type="button"
              disabled={busy}
              onClick={() => onChange({ topics: form.topics.filter((x) => x !== t) })}
              aria-label={`Remove topic ${t}`}
              className="min-h-11 px-3 rounded-control border border-accent/60 bg-accent/10 text-[13px] text-accent inline-flex items-center gap-1"
            >
              {t} <X className="w-3.5 h-3.5" />
            </button>
          ))}
          {form.topics.length < JOURNAL_MAX_TOPICS && addable.length > 0 && (
            <select
              value=""
              disabled={busy}
              aria-label="Add topic"
              onChange={(e) => e.target.value && onChange({ topics: [...form.topics, e.target.value] })}
              className="min-h-11 px-2 rounded-control border border-border-subtle bg-transparent text-[13px] text-text-secondary"
            >
              <option value="">Add topic…</option>
              {addable.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <Choice label="Captured by" options={JOURNAL_SOURCES} value={form.source} disabled={busy} onPick={(source) => onChange({ source })} />

      <label className={`${label} mt-3`}>
        Entry
        <textarea
          value={form.body}
          rows={5}
          maxLength={JOURNAL_MAX_BODY_CHARS}
          disabled={busy}
          onChange={(e) => onChange({ body: e.target.value })}
          className={field}
        />
      </label>

      {form.error && <p role="alert" className="mt-2 text-[12px] text-down">{form.error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !ready}
          className="min-h-11 px-4 rounded-full text-[13px] font-semibold bg-accent text-on-accent disabled:opacity-40 transition-opacity"
        >
          {busy ? "Saving…" : "Save to journal"}
        </button>
        <button type="button" onClick={onDiscard} disabled={busy} className="min-h-11 px-3 rounded-control text-[13px] text-text-secondary disabled:opacity-50">
          Discard
        </button>
        {!ready && missing && <span className="text-[12px] text-text-tertiary">Add {missing} first.</span>}
      </div>
    </section>
  );
}

/** One choice out of a few (mood, how sure, captured by): the same accent selection as the Yes / No buttons. */
function Choice<T extends string>({ label, options, value, disabled, onPick }: { label: string; options: readonly T[]; value: T | null; disabled?: boolean; onPick: (v: T) => void }) {
  return (
    <div className="mt-3" role="group" aria-label={label}>
      <div className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={value === o}
            disabled={disabled}
            onClick={() => onPick(o)}
            className={`min-h-11 px-3 rounded-control border text-[13px] font-medium transition-colors ${answerStyle(value === o, false)}`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function Row({ item, cell, onTap, note }: { item: CheckinItem; cell: Cell | undefined; onTap: (name: string, a: CheckinAnswer) => void; note?: string }) {
  const yes = cell?.answer === "Yes";
  const no = cell?.answer === "No";
  const suggested = cell?.origin === "suggested";
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <p className="text-[14px] text-text-primary leading-snug">{item.name}</p>
        {note && <p className="text-[11px] font-mono text-accent/80 mt-0.5">{note}</p>}
        {cell?.origin === "suggested" && cell.source && <p className="text-[11px] font-mono text-accent/80 mt-0.5">from {cell.source} · tap to change</p>}
      </div>
      <div className="flex gap-1.5 shrink-0">
        <button
          onClick={() => onTap(item.name, "Yes")}
          aria-pressed={yes}
          aria-label={`${item.name}: yes`}
          className={`h-11 w-16 rounded-control border text-[13px] font-medium inline-flex items-center justify-center gap-1 transition-colors ${answerStyle(yes, suggested)}`}
        >
          <Check className="w-3.5 h-3.5" /> Yes
        </button>
        <button
          onClick={() => onTap(item.name, "No")}
          aria-pressed={no}
          aria-label={`${item.name}: no`}
          className={`h-11 w-16 rounded-control border text-[13px] font-medium inline-flex items-center justify-center gap-1 transition-colors ${answerStyle(no, suggested)}`}
        >
          <X className="w-3.5 h-3.5" /> No
        </button>
      </div>
    </div>
  );
}
