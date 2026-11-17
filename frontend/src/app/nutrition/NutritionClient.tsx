"use client";

import { writeFeedSeed } from "@/lib/feed-seed";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AreaChart, Area,
  BarChart, Bar, Cell,
  LineChart, Line,
  ComposedChart,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
  ReferenceLine,
} from "recharts";
import {
  getNutrition,
  getWhoopCaloriesBurnt,
  getCronometerServings,
  getDailyVitamins,
  getDailyNutrientsFull,
  getPhotoMealsForDays,
  getDirectDrinksForDays,
  rangeDays,
  rangeLabel,
  type PhotoMeal,
} from "@/lib/queries";
import { onDrinkChange, servingsText, type DrinkRecord } from "@/lib/drink-capture";
import PhotoMealLogger from "@/components/PhotoMealLogger";
import { baseSourceLabel, isEstimateSource, rangeSourceLabel } from "@/lib/photo-meal";
import { formatClock } from "@/lib/delivery-leftovers";
import { formatDate, kgToLb, sameJson } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import { Part, PartGrid, PartGroup } from "@/components/personalize/PartGrid";
import PersonalTable, { type TableColumn } from "@/components/personalize/PersonalTable";
import InfoHint from "@/components/InfoHint";
import RangeFilter from "@/components/RangeFilter";
import LogLink from "@/components/LogLink";
import { useInFeed } from "@/components/FeedContext";
import { logHref } from "@/app/log/jump";
import RangeLoadStatus, { useRangeLoad } from "@/components/RangeLoadStatus";
import { DeliveryDishList, LeftoverList, useDeliveryDishes } from "@/components/DeliveryPortions";
import { shiftYmd } from "@/lib/delivery-portion";
import { chartTooltip, axisTick, gridStyle, axisLabel, chartColors as C } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

const legendStyle = { fontSize: 11, fontFamily: "var(--font-mono)" };

// ─── Vitamins & Minerals reference (US RDA/AI for an adult male) ──────────────
// `tok` is the unit token used in pds.daily_micronutrient_totals column names
// (vit_a_total_mcg, vit_d_total_iu, …). `unit` is the display unit.
type VitaminDef = { key: string; label: string; unit: string; tok: string; rda: number; group: string };
const VITAMIN_DEFS: VitaminDef[] = [
  { key: "vit_a", label: "Vitamin A", unit: "µg", tok: "mcg", rda: 900, group: "Fat-soluble" },
  { key: "vit_d", label: "Vitamin D", unit: "IU", tok: "iu", rda: 600, group: "Fat-soluble" },
  { key: "vit_e", label: "Vitamin E", unit: "mg", tok: "mg", rda: 15, group: "Fat-soluble" },
  { key: "vit_k", label: "Vitamin K", unit: "µg", tok: "mcg", rda: 120, group: "Fat-soluble" },
  { key: "vit_c", label: "Vitamin C", unit: "mg", tok: "mg", rda: 90, group: "Water-soluble" },
  { key: "b1", label: "B1 Thiamine", unit: "mg", tok: "mg", rda: 1.2, group: "Water-soluble" },
  { key: "b2", label: "B2 Riboflavin", unit: "mg", tok: "mg", rda: 1.3, group: "Water-soluble" },
  { key: "b3", label: "B3 Niacin", unit: "mg", tok: "mg", rda: 16, group: "Water-soluble" },
  { key: "b5", label: "B5 Pantothenic", unit: "mg", tok: "mg", rda: 5, group: "Water-soluble" },
  { key: "b6", label: "B6 Pyridoxine", unit: "mg", tok: "mg", rda: 1.3, group: "Water-soluble" },
  { key: "b12", label: "B12 Cobalamin", unit: "µg", tok: "mcg", rda: 2.4, group: "Water-soluble" },
  { key: "folate", label: "Folate", unit: "µg", tok: "mcg", rda: 400, group: "Water-soluble" },
  { key: "calcium", label: "Calcium", unit: "mg", tok: "mg", rda: 1000, group: "Minerals" },
  { key: "iron", label: "Iron", unit: "mg", tok: "mg", rda: 8, group: "Minerals" },
  { key: "magnesium", label: "Magnesium", unit: "mg", tok: "mg", rda: 420, group: "Minerals" },
  { key: "phosphorus", label: "Phosphorus", unit: "mg", tok: "mg", rda: 700, group: "Minerals" },
  { key: "potassium", label: "Potassium", unit: "mg", tok: "mg", rda: 3400, group: "Minerals" },
  { key: "zinc", label: "Zinc", unit: "mg", tok: "mg", rda: 11, group: "Minerals" },
  { key: "copper", label: "Copper", unit: "mg", tok: "mg", rda: 0.9, group: "Minerals" },
  { key: "manganese", label: "Manganese", unit: "mg", tok: "mg", rda: 2.3, group: "Minerals" },
  { key: "selenium", label: "Selenium", unit: "µg", tok: "mcg", rda: 55, group: "Minerals" },
  { key: "omega3", label: "Omega-3", unit: "g", tok: "g", rda: 1.6, group: "Fatty acids" },
  { key: "omega6", label: "Omega-6", unit: "g", tok: "g", rda: 17, group: "Fatty acids" },
  { key: "epa", label: "EPA", unit: "g", tok: "g", rda: 0.5, group: "Fatty acids" },
  { key: "dha", label: "DHA", unit: "g", tok: "g", rda: 0.5, group: "Fatty acids" },
  { key: "ala", label: "ALA", unit: "g", tok: "g", rda: 1.6, group: "Fatty acids" },
];
// One personalizable section per nutrient family; the first keeps the section's old part id ("vitamins").
const VITAMIN_SECTIONS: { id: string; title: string; group: string }[] = [
  { id: "vitamins", title: "Vitamins & Minerals: fat-soluble", group: "Fat-soluble" },
  { id: "vitamins-water", title: "Water-soluble vitamins", group: "Water-soluble" },
  { id: "minerals", title: "Minerals", group: "Minerals" },
  { id: "fatty-acids", title: "Fatty acids", group: "Fatty acids" },
];

const vitNum = (v: any): number | null => (v == null ? null : Number(v));
const fmtVit = (v: number | null): string =>
  v == null ? "—" : v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(0) : v.toFixed(1);
const fmtNutrient = (v: any): string => (v == null ? "—" : Number(v) >= 10 ? Number(v).toFixed(0) : Number(v).toFixed(2));

const NUTRIENT_TABLE_COLUMNS: TableColumn[] = [
  { id: "nutrient", label: "Nutrient", locked: true, th: "text-left px-4 py-2", td: "text-left px-4 py-1.5 text-text-secondary font-sans" },
  { id: "latest", label: "Latest", th: "text-right px-4 py-2", td: "text-right px-4 py-1.5" },
  { id: "avg7", label: "7d avg", th: "text-right px-4 py-2", td: "text-right px-4 py-1.5 text-text-tertiary" },
];

/** Placeholder of a KPI tile while the range loads. */
function TileSkeleton() {
  return (
    <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4 space-y-3">
      <div className="h-3 w-16 bg-white/5 animate-pulse rounded" />
      <div className="h-8 w-24 bg-white/5 animate-pulse rounded" />
    </div>
  );
}

/** Placeholder of a chart card while the range loads. */
function ChartSkeleton({ height }: { height: number }) {
  return <div className="bg-surface-card border border-border-subtle rounded-control animate-pulse" style={{ height }} />;
}

// Remaining Cronometer-only nutrients (no supplement overlap / no RDA tile) shown
// in the "All tracked nutrients" table — honors the "render everything" choice.
const EXTRA_NUTRIENT_COLS: { col: string; label: string; unit: string }[] = [
  { col: "net_carbs_g", label: "Net Carbs", unit: "g" },
  { col: "added_sugars_g", label: "Added Sugars", unit: "g" },
  { col: "starch_g", label: "Starch", unit: "g" },
  { col: "soluble_fiber_g", label: "Soluble Fiber", unit: "g" },
  { col: "insoluble_fiber_g", label: "Insoluble Fiber", unit: "g" },
  { col: "cholesterol_mg", label: "Cholesterol", unit: "mg" },
  { col: "saturated_g", label: "Saturated Fat", unit: "g" },
  { col: "monounsaturated_g", label: "Monounsaturated", unit: "g" },
  { col: "polyunsaturated_g", label: "Polyunsaturated", unit: "g" },
  { col: "trans_fat_g", label: "Trans Fat", unit: "g" },
  { col: "aa_g", label: "Arachidonic (AA)", unit: "g" },
  { col: "la_g", label: "Linoleic (LA)", unit: "g" },
  { col: "oxalate_mg", label: "Oxalate", unit: "mg" },
  { col: "phytate_mg", label: "Phytate", unit: "mg" },
  { col: "alcohol_g", label: "Alcohol", unit: "g" },
  { col: "histidine_g", label: "Histidine", unit: "g" },
  { col: "isoleucine_g", label: "Isoleucine", unit: "g" },
  { col: "leucine_g", label: "Leucine", unit: "g" },
  { col: "lysine_g", label: "Lysine", unit: "g" },
  { col: "methionine_g", label: "Methionine", unit: "g" },
  { col: "phenylalanine_g", label: "Phenylalanine", unit: "g" },
  { col: "threonine_g", label: "Threonine", unit: "g" },
  { col: "tryptophan_g", label: "Tryptophan", unit: "g" },
  { col: "tyrosine_g", label: "Tyrosine", unit: "g" },
  { col: "valine_g", label: "Valine", unit: "g" },
  { col: "cystine_g", label: "Cystine", unit: "g" },
];

// ─── Date / format helpers ───────────────────────────────────────────────────

/** Current ET date as YYYY-MM-DD. */
function etTodayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Pretty-print a YYYY-MM-DD as "May 22" for inline labels. */
function formatShortDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Nutrition helpers ───────────────────────────────────────────────────────

function avg(arr: any[], key: string): number {
  const vals = arr.map((d) => Number(d[key])).filter((v) => !isNaN(v) && v > 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

// ─── Weight helpers ──────────────────────────────────────────────────────────

interface WeightRow {
  log_date: string;
  weight_kg: number;
  notes: string | null;
  logged_at: string;
  // 'tanita' = rolled up from the scale by tanita_etl.py (overwritable by the
  // ETL); 'manual' = quick-log below (takes precedence, ETL never touches it).
  source: "manual" | "tanita";
}

import type { NutritionInitial } from "./NutritionLoader";

export default function NutritionPage({ initial, headingTestId = "page-heading" }: { initial?: NutritionInitial | null; headingTestId?: string }) {
  // headingTestId: "feed-page-heading" when shown inside the continuous scroll (components/ContinuousScroll.tsx).
  // ─── Nutrition state ───
  // Server-prefetched initial data (ISR, default 30d range) seeds the analytics
  // charts so they paint immediately; the range effect still runs as a SILENT
  // revalidation (no skeleton) because the ISR snapshot can be up to ~1h stale.
  // PARTIAL seed by design: only the analytics block is prefetched — the
  // behavioral-today / servings / weight effects below keep their pre-ISR
  // client-side behavior untouched.
  const [nutritionData, setNutritionData] = useState<any[]>(initial?.nutritionData ?? []);
  const [burntData, setBurntData] = useState<any[]>(initial?.burntData ?? []);
  const [vitaminsData, setVitaminsData] = useState<any[]>(initial?.vitaminsData ?? []);
  const [fullNutrients, setFullNutrients] = useState<any[]>(initial?.fullNutrients ?? []);
  const [servingsState, setServingsState] = useState<{ date: string | null; rows: any[]; failed?: boolean }>({ date: null, rows: [] });
  const [nutritionLoading, setNutritionLoading] = useState(!initial);
  // Requested vs shown range (components/RangeLoadStatus.tsx, Codex #191 UI 4): labels use the shown one.
  const { range, attempt, view: rangeView, selected: selectedRange, begin: beginRange, finish: finishRange, retry: retryRange, select: selectRange, shownRef } = useRangeLoad("30d");
  const firstRunWithInitial = useRef(!!initial);
  // Guards for the silent post-save refresh (refreshNutritionSilently): the range it runs for (the one loading,
  // else the one shown), a counter the range effect bumps (a newer range load wins), and a counter per refresh
  // (the newest refresh wins).
  const rangeRef = useRef(range);
  const nutritionGen = useRef(0);
  const refreshSeq = useRef(0);

  // ─── Weight state ───
  const [weightRows, setWeightRows] = useState<WeightRow[]>([]);
  const [weightLoading, setWeightLoading] = useState(true);
  const [weightError, setWeightError] = useState(false);
  // Inline failure for deleting a weight entry, shown under the Recent entries list. Cleared by the
  // next delete or after a few seconds. Replaces the blocking browser popup.
  const [weightActionError, setWeightActionError] = useState<string | null>(null);
  useEffect(() => {
    if (!weightActionError) return;
    const t = setTimeout(() => setWeightActionError(null), 5000);
    return () => clearTimeout(t);
  }, [weightActionError]);
  // /nutrition?log=photo (Log > Meal photo): the photo logger first.
  // /nutrition?log=weight (an older shortcut): weight is entered on Log now, so the routed page forwards there.
  const logParam = useSearchParams().get("log");
  const logPhotoFirst = logParam === "photo";
  const router = useRouter();
  const inFeed = useInFeed();
  useEffect(() => {
    if (logParam === "weight" && !inFeed) router.replace(logHref("weight"));
  }, [logParam, inFeed, router]);

  // Behavioral "today" for the Today's Meals widget — seeded with ET-clock-today
  // as a synchronous best-guess, then overridden on mount via /api/behavioral-today
  // (pds.behavioral_today_now(): TZ-aware + awake-tail-aware via the -6h rule).
  // Keeps the widget on yesterday's behavioral day during a post-midnight awake
  // tail instead of flipping to an empty new day at the stroke of midnight.
  const [behavioralToday, setBehavioralToday] = useState<string>(etTodayStr());
  useEffect(() => {
    fetch("/api/behavioral-today")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.behavioral_today) setBehavioralToday(j.behavioral_today);
      })
      .catch(() => {});
  }, []);

  // ─── Nutrition + burnt + micronutrients loader (responds to range filter) ───
  useEffect(() => {
    // Silent only on the very first run when seeded — range changes show the
    // loading state as before. The cancelled flag stops a superseded slow
    // response from overwriting a newer range's data (out-of-order resolve).
    let cancelled = false;
    rangeRef.current = range;
    nutritionGen.current += 1;
    const refreshAtStart = refreshSeq.current;
    const silent = firstRunWithInitial.current;
    firstRunWithInitial.current = false;
    if (!silent) setNutritionLoading(true);
    const seq = beginRange(range, silent);
    Promise.all([
      getNutrition(rangeDays(range)),
      getWhoopCaloriesBurnt(rangeDays(range)),
      getDailyVitamins(rangeDays(range)),
      getDailyNutrientsFull(rangeDays(range)),
    ])
      .then(([n, b, v, f]) => {
        if (cancelled) return;
        // The default view also seeds this page in the continuous scroll (lib/feed-seed.ts).
        if (range === "30d") writeFeedSeed("/nutrition", { nutritionData: n, burntData: b, vitaminsData: v, fullNutrients: f });
        // sameJson bail-out: the silent revalidation's data is usually
        // byte-identical to the server-seeded state — returning the previous
        // reference lets React skip the commit (and a full chart re-render).
        // A post-save refresh started after this load fetched newer macros: keep those.
        if (refreshSeq.current === refreshAtStart) setNutritionData((prev) => (sameJson(prev, n) ? prev : n));
        setBurntData((prev) => (sameJson(prev, b) ? prev : b));
        setVitaminsData((prev) => (sameJson(prev, v) ? prev : v));
        setFullNutrients((prev) => (sameJson(prev, f) ? prev : f));
        finishRange(seq, range, true);
      })
      .catch((e) => {
        console.error(e);
        if (cancelled) return;
        // The charts keep the shown range's rows; a post-save refresh must fetch that range, not the failed one.
        rangeRef.current = shownRef.current;
        finishRange(seq, range, false);
      })
      .finally(() => {
        if (!cancelled && !silent) setNutritionLoading(false);
      });
    return () => { cancelled = true; };
  }, [range, attempt, beginRange, finishRange, shownRef]);

  // ─── Meals log for one behavioral day (today by default; the two days before are one tap away,
  // because a leftover is usually noticed the next morning) ───
  const [mealsDayOffset, setMealsDayOffset] = useState(0);
  const mealsDay = shiftYmd(behavioralToday, -mealsDayOffset);
  useEffect(() => {
    let cancelled = false;
    getCronometerServings(1, mealsDay)
      .then((rows) => {
        if (!cancelled) {
          setServingsState((prev) =>
            prev.date === mealsDay && !prev.failed && sameJson(prev.rows, rows) ? prev : { date: mealsDay, rows },
          );
        }
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) setServingsState({ date: mealsDay, rows: [], failed: true });
      });
    return () => { cancelled = true; };
  }, [mealsDay]);

  // A saved portion changes that day's Uber Eats estimate in the macro charts: refetch them silently.
  // Reads the CURRENT range (not the one at tap time) and drops its result if the range changed, or a
  // newer refresh started, while it was in flight.
  const refreshNutritionSilently = useCallback(() => {
    const r = rangeRef.current;
    const gen = nutritionGen.current;
    const seq = ++refreshSeq.current;
    getNutrition(rangeDays(r))
      .then((n) => {
        if (rangeRef.current !== r || nutritionGen.current !== gen || refreshSeq.current !== seq) return;
        setNutritionData((prev) => (sameJson(prev, n) ? prev : n));
      })
      .catch(console.error);
  }, []);
  // Read-only here: the portions and leftovers are answered on /log, which saves them.
  const delivery = useDeliveryDishes(mealsDay);
  const servingsLoaded = servingsState.date === mealsDay;
  const servingsFailed = servingsLoaded && !!servingsState.failed;
  const todayServings = servingsLoaded ? servingsState.rows : [];

  // Photo-logged meals of the shown day (pds.photo_meals); reloaded after a save or a removal.
  const [photoState, setPhotoState] = useState<{ date: string | null; rows: PhotoMeal[]; failed?: boolean }>({ date: null, rows: [] });
  const [photoReload, setPhotoReload] = useState(0);
  const [photoError, setPhotoError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getPhotoMealsForDays([mealsDay])
      .then((rows) => {
        if (!cancelled) setPhotoState((prev) => (prev.date === mealsDay && !prev.failed && sameJson(prev.rows, rows) ? prev : { date: mealsDay, rows }));
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) setPhotoState({ date: mealsDay, rows: [], failed: true });
      });
    return () => { cancelled = true; };
  }, [mealsDay, photoReload]);
  const photoLoaded = photoState.date === mealsDay;
  const photoMeals = photoLoaded ? photoState.rows : [];
  const photoKcal = photoMeals.reduce((s, m) => s + m.kcal, 0);
  const onPhotoSaved = useCallback(() => {
    setPhotoReload((n) => n + 1);
    refreshNutritionSilently();
  }, [refreshNutritionSilently]);
  async function removePhotoMeal(m: PhotoMeal) {
    if (!window.confirm(`Remove this meal (${Math.round(m.kcal)} kcal)?`)) return;
    setPhotoError(null);
    try {
      const res = await fetch("/api/nutrition/photo-meals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meal_id: m.meal_id }),
      });
      if (!res.ok && res.status !== 404) {
        const j = await res.json().catch(() => null);
        setPhotoError(`Not removed: ${j?.error ?? res.status}`);
        return;
      }
      onPhotoSaved();
    } catch {
      setPhotoError("Network error: the meal was not removed.");
    }
  }
  // Drinks captured on Log (pds.photo_meals capture_kind = 'drink') of the shown day: read-only here (entered and
  // undone on Log). Their kcal / macros are already in the daily macros (getNutrition adds pds.direct_drink_daily).
  const [drinkState, setDrinkState] = useState<{ date: string | null; rows: DrinkRecord[]; failed?: boolean }>({ date: null, rows: [] });
  const [drinkReload, setDrinkReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getDirectDrinksForDays([mealsDay])
      .then((rows) => {
        if (!cancelled) setDrinkState((prev) => (prev.date === mealsDay && !prev.failed && sameJson(prev.rows, rows) ? prev : { date: mealsDay, rows }));
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) setDrinkState({ date: mealsDay, rows: [], failed: true });
      });
    return () => { cancelled = true; };
  }, [mealsDay, drinkReload]);
  const drinksLoaded = drinkState.date === mealsDay;
  const dayDrinks = drinksLoaded ? drinkState.rows : [];
  const drinkKcal = dayDrinks.filter((d) => d.overlap === "none").reduce((s, d) => s + d.kcal, 0);
  // A drink saved, edited or undone on Log (this page may be mounted in the scroll at the same time): refetch the
  // macros and the list. Registered for as long as the page is mounted.
  useEffect(() => onDrinkChange(() => {
    setDrinkReload((n) => n + 1);
    refreshNutritionSilently();
  }), [refreshNutritionSilently]);

  const mealsLoading = !servingsLoaded || !delivery.loaded || !photoLoaded || !drinksLoaded;

  // ─── Weight loader + default date init ───
  const loadWeight = useCallback(async () => {
    setWeightLoading(true);
    try {
      const res = await fetch(`/api/weight?days=${Math.max(rangeDays(range), 90)}`);
      if (!res.ok) throw new Error(`Weight load failed: HTTP ${res.status}`);
      const json = await res.json();
      setWeightRows((json.rows ?? []) as WeightRow[]);
      setWeightError(false);
    } catch (e) {
      console.error("Weight load:", e);
      setWeightError(true);
    } finally {
      setWeightLoading(false);
    }
  }, [range]);

  useEffect(() => { loadWeight(); }, [loadWeight]);

  async function deleteWeight(log_date: string) {
    if (!confirm(`Delete weight entry for ${log_date}?`)) return;
    setWeightActionError(null);
    try {
      const res = await fetch(`/api/weight?log_date=${log_date}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      await loadWeight();
    } catch (e) {
      console.error("Delete weight:", e);
      setWeightActionError("Couldn't delete that weight entry. Try again.");
    }
  }

  const latest = nutritionData[nutritionData.length - 1];

  // Calories consumed (MFP) vs burnt (WHOOP cycle kilojoule → kcal).
  // Joined by calendar_date; missing days on either side render null and skip.
  const burntByDate = new Map<string, number | null>();
  for (const b of burntData) {
    burntByDate.set(b.calendar_date, b.calories_burnt ?? null);
  }
  const allDates = new Set<string>([
    ...nutritionData.map((d) => d.calendar_date),
    ...burntData.map((d) => d.calendar_date),
  ]);
  const calorieData = Array.from(allDates)
    .sort()
    .map((cd) => {
      const n = nutritionData.find((d) => d.calendar_date === cd);
      const consumed = n?.calories ?? null;
      const burnt = burntByDate.get(cd) ?? null;
      return {
        date: formatDate(cd),
        consumed,
        burnt,
        net: consumed !== null && burnt !== null ? consumed - burnt : null,
      };
    });

  const avgBurnt = (() => {
    const vals = burntData.map((d) => Number(d.calories_burnt)).filter((v) => !isNaN(v) && v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  })();

  // ─── Weight derivations ───
  const weightChartData = weightRows.map((w) => ({
    date: formatDate(w.log_date),
    weight_lb: kgToLb(Number(w.weight_kg)),
  }));
  const latestWeight = weightRows[weightRows.length - 1];
  const latestWeightLb = latestWeight ? kgToLb(Number(latestWeight.weight_kg)) : null;
  const weightTanitaCount = weightRows.filter((w) => w.source === "tanita").length;
  const weightTrendSource =
    weightTanitaCount === 0
      ? undefined
      : weightTanitaCount === weightRows.length
        ? "TANITA"
        : "TANITA + MANUAL";
  const sevenDayWeightAvg = (() => {
    const last7 = weightRows.slice(-7);
    if (last7.length === 0) return null;
    const sum = last7.reduce((s, w) => s + Number(w.weight_kg), 0);
    return kgToLb(sum / last7.length);
  })();
  const thirtyDayDelta = (() => {
    if (weightRows.length < 2) return null;
    const recent = weightRows[weightRows.length - 1];
    // Find the row closest to (recent.log_date − 30d) without going past it.
    const targetMs = new Date(recent.log_date + "T12:00:00Z").getTime() - 30 * 24 * 3600 * 1000;
    let baseline: WeightRow | null = null;
    for (const w of weightRows) {
      if (new Date(w.log_date + "T12:00:00Z").getTime() <= targetMs) baseline = w;
      else break;
    }
    if (!baseline) return null;
    return kgToLb(Number(recent.weight_kg) - Number(baseline.weight_kg));
  })();

  const macroData = nutritionData.map((d) => ({
    date: formatDate(d.calendar_date),
    protein: d.protein_g ? +Number(d.protein_g).toFixed(1) : 0,
    carbs: d.carbs_g ? +Number(d.carbs_g).toFixed(1) : 0,
    fat: d.fat_g ? +Number(d.fat_g).toFixed(1) : 0,
  }));

  const detailData = nutritionData.map((d) => ({
    date: formatDate(d.calendar_date),
    protein: d.protein_g ? +Number(d.protein_g).toFixed(1) : null,
    fat: d.fat_g ? +Number(d.fat_g).toFixed(1) : null,
    fiber: d.fiber_g ? +Number(d.fiber_g).toFixed(1) : null,
    sugar: d.sugar_g ? +Number(d.sugar_g).toFixed(1) : null,
  }));

  const avgCalories = avg(nutritionData, "calories");
  const avgProtein = avg(nutritionData, "protein_g");
  const avgCarbs = avg(nutritionData, "carbs_g");
  const avgFat = avg(nutritionData, "fat_g");

  // Days without a Cronometer log are filled with Uber Eats estimates and
  // photo-logged meals (getNutrition) — label the source honestly.
  const estDays = nutritionData.filter((d) => isEstimateSource(d.nutrition_source)).length;
  // Direct drink captures add to any day (lib/drink-capture.ts addDirectDrinks): tagged "+ DRINKS".
  const hasDrinks = (d: any) => Number(d?.direct_drink_count) > 0;
  const macroSource = rangeSourceLabel(nutritionData.map((d) => d.nutrition_source), nutritionData.some(hasDrinks));
  // The KPI tiles' source tag names the food source; drinks are named in the tile's sublabel.
  const latestSource = baseSourceLabel(latest?.nutrition_source) ?? undefined;
  const drinkNote = latest?.nutrition_source === "direct_drink" ? "drinks only" : hasDrinks(latest) ? "incl. drinks" : null;
  const withDrinkNote = (s: string | undefined) => (drinkNote ? (s ? `${s} · ${drinkNote}` : drinkNote) : s);

  // Latest day + trailing week of the micronutrient tiles and the "All tracked nutrients" table.
  const vitaminLatest = vitaminsData[vitaminsData.length - 1];
  const vitaminLast7 = vitaminsData.slice(-7);
  const nutrientLatest = fullNutrients[fullNutrients.length - 1];
  const nutrientLast7 = fullNutrients.slice(-7);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-8">
        <div>
          <div className="flex items-center gap-2">
            <h2 data-testid={headingTestId} className="text-[28px] font-medium text-text-primary">Nutrition</h2>
            <InfoHint label="Nutrition">
              Food comes from Cronometer. On days with no Cronometer log, Uber Eats dish estimates and meals
              logged by photo fill in. Drinks logged on Log add to every day, from their label.
            </InfoHint>
          </div>
          <p className="text-sm text-text-tertiary mt-0.5">
            Macros, micronutrients &amp; weight — {rangeLabel(rangeView.shown)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <RangeLoadStatus view={rangeView} onRetry={retryRange} />
          <RangeFilter value={selectedRange} onChange={selectRange} />
        </div>
      </div>

      {logPhotoFirst && <div className="mb-8"><PhotoMealLogger first onSaved={onPhotoSaved} /></div>}

      {/* Meal timing is now automatic from Cronometer Gold per-entry timestamps
          (manual meal_events logging removed 2026-05-31). Per-meal log shows in
          "Today's Meals" below; meal-timing drivers show on /analytics/hrv. */}

      <PartGrid page="/nutrition" title="Nutrition" gap={28}>
      {/* ─── Daily Macros (Cronometer; MFP fills pre-cutover history) ──────── */}
      <PartGroup
        id="macros"
        title="Daily Macros"
        header={
          <div className="mb-3">
            <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest">Daily Macros</p>
            {estDays > 0 && (
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xs text-text-tertiary">
                  {estDays} of {nutritionData.length} days use estimates.
                </p>
                <InfoHint label="Estimates">
                  On days with no Cronometer log: Uber Eats dishes estimated from their names, counting what you
                  marked as eaten under Meals below or in the check-in (All unless you change it), plus meals you
                  logged by photo. Food that was neither delivered nor photographed is missing.
                </InfoHint>
              </div>
            )}
          </div>
        }
      >
        <Part id="calories" title="Calories" width="quarter">
          {nutritionLoading ? <TileSkeleton /> : (
            <StatCard
              label="Calories"
              value={latest?.calories ?? null}
              sublabel={withDrinkNote(avgCalories > 0 ? `avg ${Math.round(avgCalories)} kcal` : undefined)}
              source={latestSource}
            />
          )}
        </Part>
        <Part id="protein" title="Protein" width="quarter">
          {nutritionLoading ? <TileSkeleton /> : (
            <StatCard
              label="Protein"
              value={latest?.protein_g ? `${Number(latest.protein_g).toFixed(0)}g` : null}
              sublabel={withDrinkNote(avgProtein > 0 ? `avg ${avgProtein.toFixed(0)}g` : undefined)}
              source={latestSource}
            />
          )}
        </Part>
        <Part id="carbs" title="Carbs" width="quarter">
          {nutritionLoading ? <TileSkeleton /> : (
            <StatCard
              label="Carbs"
              value={latest?.carbs_g ? `${Number(latest.carbs_g).toFixed(0)}g` : null}
              sublabel={withDrinkNote(avgCarbs > 0 ? `avg ${avgCarbs.toFixed(0)}g` : undefined)}
              source={latestSource}
            />
          )}
        </Part>
        <Part id="fat" title="Fat" width="quarter">
          {nutritionLoading ? <TileSkeleton /> : (
            <StatCard
              label="Fat"
              value={latest?.fat_g ? `${Number(latest.fat_g).toFixed(0)}g` : null}
              sublabel={withDrinkNote(avgFat > 0 ? `avg ${avgFat.toFixed(0)}g` : undefined)}
              source={latestSource}
            />
          )}
        </Part>

        <Part id="calorie-trend" title="Calorie Trend — Consumed vs Burnt">
          {nutritionLoading ? <ChartSkeleton height={320} /> : (
            <ChartCard
              title="Calorie Trend — Consumed vs Burnt"
              subtitle="Intake vs WHOOP energy burnt"
              hint="Intake is Cronometer, with Uber Eats dish estimates on days with no Cronometer log. Burnt is WHOOP cycle energy expenditure (kilojoule → kcal). Net = consumed − burnt."
              source={`${macroSource} + WHOOP`}
            >
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={calorieData}>
                  <defs>
                    <linearGradient id="calConsumedGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C.accent} stopOpacity={0.18} />
                      <stop offset="95%" stopColor={C.accent} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={60} label={axisLabel("kcal", "y")} />
                  <Tooltip {...chartTooltip} />
                  <Legend wrapperStyle={legendStyle} />
                  <Area
                    type="monotone"
                    dataKey="consumed"
                    stroke={C.accent}
                    strokeWidth={2}
                    fill="url(#calConsumedGrad)"
                    name="Consumed"
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="burnt"
                    stroke={C.source.whoop}
                    strokeWidth={2}
                    dot={false}
                    name="Burnt (WHOOP)"
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </Part>

        <Part id="net-energy" title="Net Energy Balance">
          {nutritionLoading ? <ChartSkeleton height={260} /> : (
            <ChartCard
              title="Net Energy Balance"
              subtitle="Consumed − burnt · above 0 = surplus"
              source={`${macroSource} + WHOOP`}
            >
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={calorieData}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={60} label={axisLabel("kcal", "y")} />
                  <Tooltip {...chartTooltip} />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
                  <Bar dataKey="net" name="Net (kcal)" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                    {calorieData.map((d, i) => (
                      <Cell
                        key={i}
                        fill={(d.net ?? 0) >= 0 ? C.source.whoop : C.up}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </Part>

        <Part id="macro-breakdown" title="Macro Breakdown (g)">
          {nutritionLoading ? <ChartSkeleton height={300} /> : (
            <ChartCard title="Macro Breakdown (g)" source={macroSource}>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={macroData}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={48} />
                  <Tooltip {...chartTooltip} />
                  <Legend wrapperStyle={legendStyle} />
                  <Bar dataKey="protein" stackId="macros" fill={C.up} name="Protein (g)" isAnimationActive={false} />
                  <Bar dataKey="carbs" stackId="macros" fill={C.source.garmin} name="Carbs (g)" isAnimationActive={false} />
                  <Bar dataKey="fat" stackId="macros" fill={C.source.whoop} name="Fat (g)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </Part>

        <Part id="macro-detail" title="Protein, Fat, Fiber & Sugar (g)">
          {nutritionLoading ? <ChartSkeleton height={300} /> : (
            <ChartCard title="Protein, Fat, Fiber & Sugar (g)" source="CRONOMETER">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={detailData}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={40} />
                  <Tooltip {...chartTooltip} />
                  <Legend wrapperStyle={legendStyle} />
                  <Line type="monotone" dataKey="protein" stroke={C.up} strokeWidth={2} dot={false} name="Protein (g)" connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="fat" stroke={C.source.whoop} strokeWidth={2} dot={false} name="Fat (g)" connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="fiber" stroke={C.source.eightsleep} strokeWidth={2} dot={false} name="Fiber (g)" connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="sugar" stroke={C.down} strokeWidth={2} dot={false} name="Sugar (g)" connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </Part>
      </PartGroup>

      {/* ─── Vitamins & Minerals (Cronometer dietary + Onyx supplement) ───────
          One group per nutrient family; every tile is its own part. The first group carries the section heading
          and keeps the old "vitamins" id, so a saved hide / position of the section still applies to it. */}
      {VITAMIN_SECTIONS.map((grp, gi) => (
        <PartGroup
          key={grp.id}
          id={grp.id}
          title={grp.title}
          gap={12}
          header={
            <div className="mb-2">
              {gi === 0 && (
                <div className="flex items-baseline justify-between mb-3">
                  <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest">Vitamins &amp; Minerals</p>
                  <span className="text-[10px] font-mono text-text-tertiary">CRONOMETER + SUPPLEMENTS · latest day · % of RDA</span>
                </div>
              )}
              {gi === 0 && !vitaminLatest && (
                <p className="text-xs text-text-tertiary mb-3">No Cronometer micronutrient data yet — import an export to populate.</p>
              )}
              <p className="text-[10px] font-mono text-text-tertiary">{grp.group}</p>
            </div>
          }
        >
          {VITAMIN_DEFS.filter((d) => d.group === grp.group).map((d) => {
            const total = vitNum(vitaminLatest?.[`${d.key}_total_${d.tok}`]);
            const diet = vitNum(vitaminLatest?.[`${d.key}_dietary_${d.tok}`]);
            const supp = vitNum(vitaminLatest?.[`${d.key}_supplement_${d.tok}`]);
            const avg7 = avg(vitaminLast7, `${d.key}_total_${d.tok}`);
            const pct = total != null && d.rda ? (total / d.rda) * 100 : null;
            const barColor = pct == null ? "bg-white/10" : pct >= 100 ? "bg-green-500" : pct >= 50 ? "bg-cyan-500" : "bg-amber-500";
            return (
              <Part key={d.key} id={`vit-${d.key}`} title={d.label} width="quarter">
                <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-3">
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-text-secondary truncate">{d.label}</span>
                    <span className="text-[10px] font-mono text-text-tertiary shrink-0 ml-1">{pct == null ? "—" : `${Math.round(pct)}%`}</span>
                  </div>
                  <div className="text-base font-mono mt-1">
                    {fmtVit(total)}
                    <span className="text-[10px] text-text-tertiary ml-1">{d.unit}</span>
                  </div>
                  <div className="h-1 bg-white/5 rounded mt-2 overflow-hidden">
                    <div className={`h-full ${barColor}`} style={{ width: `${pct == null ? 0 : Math.min(pct, 100)}%` }} />
                  </div>
                  <div className="text-[10px] font-mono text-text-tertiary mt-1.5 truncate">
                    food {fmtVit(diet)} · supp {fmtVit(supp)} · 7d {fmtVit(avg7 || null)}
                  </div>
                </div>
              </Part>
            );
          })}
        </PartGroup>
      ))}

      {/* ─── Meals (Cronometer per-entry log + Uber Eats + photos) ─────────── */}
      <PartGroup
        id="meals"
        title="Meals"
        gap={12}
        header={
          <div className="mb-3">
            <div className="flex items-baseline justify-between mb-3">
              <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest">
                {mealsDayOffset === 0 ? "Today's Meals" : "Meals"}
              </p>
              <span className="text-[10px] font-mono text-text-tertiary">CRONOMETER + UBER EATS + PHOTOS + DRINKS · {mealsDay}</span>
            </div>
            <div className="flex gap-1.5" role="tablist" aria-label="Meals day">
              {[0, 1, 2].map((off) => (
                <button
                  key={off}
                  role="tab"
                  aria-selected={mealsDayOffset === off}
                  onClick={() => setMealsDayOffset(off)}
                  className={`px-2.5 py-1 rounded-control border text-[11px] font-mono transition-colors ${
                    mealsDayOffset === off
                      ? "border-accent/60 bg-accent/10 text-text-primary"
                      : "border-border-subtle text-text-tertiary hover:text-text-secondary"
                  }`}
                >
                  {off === 0 ? "Today" : off === 1 ? "Yesterday" : formatShortDate(shiftYmd(behavioralToday, -2))}
                </button>
              ))}
            </div>
            {mealsLoading ? (
              <p className="text-xs text-text-tertiary mt-3">Loading…</p>
            ) : todayServings.length === 0 && photoMeals.length === 0 && dayDrinks.length === 0 && delivery.items.length === 0 && delivery.leftovers.length === 0 && !servingsFailed && !photoState.failed && !drinkState.failed && !delivery.loadError ? (
              <p className="text-xs text-text-tertiary mt-3">
                Nothing logged for {mealsDayOffset === 0 ? "today" : "this day"} yet. Cronometer entries and Uber Eats orders appear here once they sync.
              </p>
            ) : null}
            {servingsFailed && <p className="text-xs text-red-400 mt-3">Couldn&apos;t load Cronometer entries.</p>}
            {delivery.loadError && <p className="text-xs text-red-400 mt-3">{delivery.loadError}</p>}
            {photoLoaded && photoState.failed && <p className="text-xs text-red-400 mt-3">Couldn&apos;t load photo meals.</p>}
            {drinksLoaded && drinkState.failed && <p className="text-xs text-red-400 mt-3">Couldn&apos;t load drinks.</p>}
          </div>
        }
      >
        {!logPhotoFirst && (
          <Part id="photo-logger" title="Log a meal by photo">
            <PhotoMealLogger onSaved={onPhotoSaved} />
          </Part>
        )}
        {todayServings.length > 0 && (
          <Part id="cronometer-entries" title="Cronometer entries">
            <div className="bg-surface-card border border-border-subtle rounded-control divide-y divide-border-subtle">
              {todayServings.map((s) => (
                <div key={s.serving_id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="text-[11px] font-mono text-text-tertiary w-20 shrink-0">
                    {s.event_time
                      ? new Date(s.event_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
                      : (s.meal_group ?? "—")}
                  </span>
                  <span className="flex-1 truncate text-text-secondary">{s.food_name}</span>
                  <span className="text-[11px] font-mono text-text-tertiary shrink-0">{s.amount_raw}</span>
                  <span className="text-[11px] font-mono text-text-tertiary w-16 text-right shrink-0">
                    {s.calories != null ? `${Math.round(Number(s.calories))} kcal` : ""}
                  </span>
                </div>
              ))}
            </div>
          </Part>
        )}
        {photoMeals.length > 0 && (
          <Part id="photo-meals" title="Meals logged by photo">
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[10px] font-mono text-text-tertiary">By photo</span>
                <span className="text-[11px] font-mono text-text-secondary">Photos ~{Math.round(photoKcal)} kcal</span>
              </div>
              <div className="bg-surface-card border border-border-subtle rounded-control divide-y divide-border-subtle">
                {photoMeals.map((m) => (
                  <div key={m.meal_id} className="flex items-start gap-2 px-4 py-2.5 text-sm">
                    <span className="text-[11px] font-mono text-text-tertiary w-14 shrink-0 pt-0.5">{formatClock(m.eaten_time)}</span>
                    <span className="flex-1 min-w-0 text-text-secondary line-clamp-2 break-words">
                      {m.items.map((i) => i.name).join(", ")}
                    </span>
                    <span className="text-[11px] font-mono text-text-tertiary w-16 text-right shrink-0 pt-0.5">~{Math.round(m.kcal)} kcal</span>
                    <button
                      onClick={() => removePhotoMeal(m)}
                      aria-label={`Remove photo meal at ${formatClock(m.eaten_time)}`}
                      className="w-11 h-11 -my-2.5 -mr-2 shrink-0 flex items-center justify-center text-text-tertiary hover:text-text-primary"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              {photoError && <p className="text-[11px] text-red-400 mt-1.5">{photoError}</p>}
            </div>
          </Part>
        )}
        {dayDrinks.length > 0 && (
          <Part id="drinks" title="Drinks">
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[10px] font-mono text-text-tertiary">Drinks (label)</span>
                <span className="text-[11px] font-mono text-text-secondary">Drinks {Math.round(drinkKcal * 10) / 10} kcal</span>
              </div>
              {/* Read-only: drinks are entered, changed and undone on Log (one place to enter data). */}
              <div className="bg-surface-card border border-border-subtle rounded-control divide-y divide-border-subtle">
                {dayDrinks.map((d) => (
                  <div key={d.client_key} className="flex items-start gap-2 px-4 py-2.5 text-sm">
                    <span className="text-[11px] font-mono text-text-tertiary w-14 shrink-0 pt-0.5">{formatClock(d.eaten_time)}</span>
                    <span className="flex-1 min-w-0 text-text-secondary break-words">
                      {d.name} · {servingsText(d.servings)}
                    </span>
                    <span className="text-[11px] font-mono text-text-tertiary text-right shrink-0 pt-0.5">
                      {d.overlap === "in_diary" ? "in diary, not counted" : `${Math.round(d.kcal * 10) / 10} kcal · ${Math.round(d.caffeine_mg)} mg caffeine`}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-1.5"><LogLink part="drinks">Change drinks on Log</LogLink></div>
            </div>
          </Part>
        )}
        {delivery.items.length > 0 && (
          <Part id="uber-eats" title="Uber Eats dishes">
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[10px] font-mono text-text-tertiary">Uber Eats</span>
                <span className="text-[11px] font-mono text-text-secondary">
                  {delivery.totalKcal != null ? `Uber Eats ~${Math.round(delivery.totalKcal)} kcal` : ""}
                </span>
              </div>
              {/* Read-only: portions are answered on Log (one place to enter data). */}
              <DeliveryDishList items={delivery.items} />
              <div className="mt-2 flex justify-end">
                <LogLink part="uber-eats">Set how much you ate on Log</LogLink>
              </div>
            </div>
          </Part>
        )}
        {delivery.leftovers.length > 0 && (
          <Part id="leftovers" title="Leftovers">
            <div>
              <div className="flex items-baseline justify-between gap-3 mb-1.5">
                <span className="text-[10px] font-mono text-text-tertiary">
                  Leftovers eaten this day. Unanswered counts as thrown out.
                </span>
                {delivery.items.length === 0 && delivery.totalKcal != null && (
                  <span className="text-[11px] font-mono text-text-secondary shrink-0">
                    Uber Eats ~{Math.round(delivery.totalKcal)} kcal
                  </span>
                )}
              </div>
              {/* Read-only: leftovers are answered on Log (one place to enter data). */}
              <LeftoverList questions={delivery.leftovers} />
              {delivery.items.length === 0 && (
                <div className="mt-2 flex justify-end">
                  <LogLink part="uber-eats">Answer leftovers on Log</LogLink>
                </div>
              )}
            </div>
          </Part>
        )}
      </PartGroup>

      {/* ─── All tracked nutrients (Cronometer dietary; latest day + 7d avg) ── */}
      <PartGroup id="all-nutrients" title="All tracked nutrients">
        <Part id="nutrients-table" title="All tracked nutrients table">
          <details className="group">
            <summary className="cursor-pointer text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3 list-none flex items-center gap-2">
              <span className="group-open:rotate-90 transition-transform">▸</span> All Tracked Nutrients
              <span className="text-text-tertiary/60 normal-case tracking-normal">— amino acids, fat fractions, etc.</span>
            </summary>
            <div className="bg-surface-card border border-border-subtle rounded-control overflow-hidden">
              <PersonalTable
                id="nutrients"
                className="w-full text-sm"
                headRowClassName="text-[10px] font-mono text-text-tertiary uppercase border-b border-border-subtle"
                rowClassName="border-b border-border-subtle/50 last:border-0 font-mono"
                columns={NUTRIENT_TABLE_COLUMNS}
                rows={EXTRA_NUTRIENT_COLS.map((n) => ({
                  key: n.col,
                  cells: {
                    nutrient: n.label,
                    latest: (
                      <>
                        {fmtNutrient(nutrientLatest?.[n.col])}
                        <span className="text-text-tertiary text-[10px] ml-1">{n.unit}</span>
                      </>
                    ),
                    avg7: fmtNutrient(avg(nutrientLast7, n.col) || null),
                  },
                }))}
              />
            </div>
          </details>
        </Part>
      </PartGroup>

      {/* ─── Body Weight ───────────────────────────────────────────────────── */}
      <PartGroup
        id="weight"
        title="Body Weight"
        header={<p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">Body Weight</p>}
      >
        <Part id="weight-latest" title="Latest weight" width="quarter">
          <StatCard
            label="Latest"
            value={latestWeightLb !== null ? `${latestWeightLb.toFixed(1)} lb` : "—"}
            sublabel={latestWeight ? formatShortDate(latestWeight.log_date) : "no entries"}
            source={latestWeight?.source === "tanita" ? "TANITA" : undefined}
          />
        </Part>
        <Part id="weight-7d" title="7-day average weight" width="quarter">
          <StatCard
            label="7d avg"
            value={sevenDayWeightAvg !== null ? `${sevenDayWeightAvg.toFixed(1)} lb` : "—"}
            sublabel="trailing 7 days"
          />
        </Part>
        <Part id="weight-30d" title="30-day weight change" width="quarter">
          <StatCard
            label="30d delta"
            value={
              thirtyDayDelta !== null
                ? `${thirtyDayDelta >= 0 ? "+" : ""}${thirtyDayDelta.toFixed(1)} lb`
                : "—"
            }
            sublabel="vs ~30 days ago"
          />
        </Part>
        <Part id="weight-count" title="Weight entries" width="quarter">
          <StatCard
            label="Entries"
            value={weightRows.length}
            sublabel="last 90 days"
          />
        </Part>

        {/* Weight is entered on Log (one place to enter data); a day can still be deleted under Recent entries. */}
        <Part id="weight-log" title="Log weight">
          <div className="flex justify-end">
            <LogLink part="weight">Log today&apos;s weight on Log</LogLink>
          </div>
        </Part>

        <Part id="weight-trend" title="Weight Trend">
          <ChartCard
            title="Weight Trend"
            source={weightTrendSource}
          >
            {weightLoading ? (
              <p className="text-[11px] text-text-tertiary font-mono py-6 text-center">Loading…</p>
            ) : weightError ? (
              <div className="py-6 text-center">
                <p className="text-[11px] text-text-tertiary font-mono mb-2">
                  Couldn&apos;t load your weight history. Try again in a moment.
                </p>
                <button
                  onClick={() => { void loadWeight(); }}
                  className="text-accent text-sm hover:underline"
                >
                  Retry
                </button>
              </div>
            ) : weightChartData.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-6 text-center">
                No entries yet. Log your first weight above to start the trend.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={weightChartData}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={50} domain={["auto", "auto"]} label={axisLabel("lb", "y")} />
                  <Tooltip {...chartTooltip} />
                  <Line
                    type="monotone"
                    dataKey="weight_lb"
                    stroke={C.source.eightsleep}
                    strokeWidth={2}
                    dot={{ r: 3, fill: C.source.eightsleep }}
                    name="Weight (lb)"
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
        </Part>

        {/* Recent entries (delete-only — edit a row by re-logging the same date) */}
        {weightRows.length > 0 && (
          <Part id="weight-recent" title="Recent weight entries">
            <ChartCard
              title="Recent entries"
              subtitle="Newest first · re-log a date on Log to overwrite"
            >
              <div className="space-y-1">
                {[...weightRows].reverse().slice(0, 10).map((w) => (
                  <div
                    key={w.log_date}
                    className="flex items-center justify-between gap-3 py-1.5 border-b border-border-subtle/40 last:border-b-0 text-[12px] font-mono"
                  >
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-text-tertiary tabular-nums shrink-0 w-[80px]">
                        {formatShortDate(w.log_date)}
                      </span>
                      <span className="text-text-primary tabular-nums">
                        {kgToLb(Number(w.weight_kg))!.toFixed(1)} lb
                      </span>
                      <span className="text-text-tertiary tabular-nums">
                        ({Number(w.weight_kg).toFixed(2)} kg)
                      </span>
                      {w.source === "tanita" && (
                        <span className="text-[9px] text-amber-500/80 tracking-wider shrink-0">TANITA</span>
                      )}
                      {w.notes && (
                        <span className="text-text-tertiary truncate">· {w.notes}</span>
                      )}
                    </div>
                    <button
                      onClick={() => deleteWeight(w.log_date)}
                      className="text-[10px] text-text-tertiary hover:text-red-400 transition-colors shrink-0"
                    >
                      delete
                    </button>
                  </div>
                ))}
              </div>
              {weightActionError && (
                <p role="alert" className="text-[11px] text-red-400 mt-2">{weightActionError}</p>
              )}
            </ChartCard>
          </Part>
        )}
      </PartGroup>
      </PartGrid>
    </>
  );
}
