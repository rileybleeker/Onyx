"use client";

import { useCallback, useEffect, useState } from "react";
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
  rangeDays,
  rangeLabel,
  type Range,
} from "@/lib/queries";
import { formatDate, kgToLb, lbToKg } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";
import { chartTooltip, axisTick, gridStyle, axisLabel } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

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
const VITAMIN_GROUPS = ["Fat-soluble", "Water-soluble", "Minerals", "Fatty acids"];

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

// ─── Meal-timing types & helpers ─────────────────────────────────────────────

interface MealEvent {
  event_id: number;
  event_date: string;
  event_time: string;
  kind: string;
  notes: string | null;
}

interface MealTimingRow {
  calendar_date: string;
  last_meal_time: string | null;
  first_meal_time: string | null;
  last_meal_hour: number | null;
  first_meal_hour: number | null;
  eating_window_hours: number | null;
  meal_event_count: number;
  last_meal_kind: string | null;
  last_meal_to_bedtime_minutes: number | null;
}

/** Hour of the day in ET (0–23). */
function etCurrentHour(): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  });
  return parseInt(fmt.format(new Date()), 10);
}

/** Current ET date as YYYY-MM-DD. */
function etTodayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Yesterday's ET date as YYYY-MM-DD. */
function etYesterdayStr(): string {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return yesterday.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Behavioral-day default for the meal log: between midnight and 4 AM ET, the
 * meal almost certainly belongs to yesterday's behavioral day (pre-bed snack
 * before the user has slept). Mirrors the supplement-intake convention so the
 * row lines up with the WHOOP cycle and the HRV pipeline's shift(-1).
 */
function defaultEventDate(): string {
  return etCurrentHour() < 4 ? etYesterdayStr() : etTodayStr();
}

/** Pretty-print a YYYY-MM-DD as "May 22" for inline labels. */
function formatShortDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Format an ISO timestamp as "7:43 PM" in ET. */
function formatClockET(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Format a decimal hour (e.g. 19.75) as "7:45 PM". */
function formatHourDecimal(h: number | null): string {
  if (h === null || h === undefined) return "—";
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  const ampm = hr >= 12 ? "PM" : "AM";
  const hr12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return `${hr12}:${String(min).padStart(2, "0")} ${ampm}`;
}

/**
 * Convert an ISO timestamp into the string accepted by
 * <input type="datetime-local"> ("YYYY-MM-DDTHH:MM"), rendered in the
 * user's local timezone. Returns "" for null.
 */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Reverse: datetime-local string → ISO. Empty → null. */
function localInputToIso(input: string): string | null {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
}

export default function NutritionPage() {
  // ─── Nutrition state ───
  const [nutritionData, setNutritionData] = useState<any[]>([]);
  const [burntData, setBurntData] = useState<any[]>([]);
  const [vitaminsData, setVitaminsData] = useState<any[]>([]);
  const [fullNutrients, setFullNutrients] = useState<any[]>([]);
  const [todayServings, setTodayServings] = useState<any[]>([]);
  const [nutritionLoading, setNutritionLoading] = useState(true);
  const [range, setRange] = useState<Range>("30d");

  // ─── Weight state ───
  const [weightRows, setWeightRows] = useState<WeightRow[]>([]);
  const [weightLoading, setWeightLoading] = useState(true);
  const [weightInput, setWeightInput] = useState<string>("");
  const [weightDate, setWeightDate] = useState<string>("");
  const [weightNotes, setWeightNotes] = useState<string>("");
  const [savingWeight, setSavingWeight] = useState(false);

  // ─── Meal-timing state ───
  const [events, setEvents] = useState<MealEvent[]>([]);
  const [timing, setTiming] = useState<MealTimingRow[]>([]);
  const [mealsLoading, setMealsLoading] = useState(true);
  const [logging, setLogging] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [eventDate, setEventDate] = useState<string>(defaultEventDate());
  const [mealKind, setMealKind] = useState<"last_meal" | "first_meal">("last_meal");
  const [customTimeOpen, setCustomTimeOpen] = useState(false);
  const [eventTimeLocal, setEventTimeLocal] = useState<string>("");
  const [notes, setNotes] = useState("");

  const [editDate, setEditDate] = useState("");
  const [editTime, setEditTime] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editKind, setEditKind] = useState<"last_meal" | "first_meal" | "snack" | "other">("last_meal");

  const today = etTodayStr();
  const yesterday = etYesterdayStr();
  const currentHourET = etCurrentHour();
  const isLoggingForToday = eventDate === today;
  const isAutoBedtimeAdjusted = eventDate === yesterday && currentHourET < 4;

  // ─── Meal loaders ───
  const loadMeals = useCallback(async () => {
    setMealsLoading(true);
    try {
      const res = await fetch("/api/meals?days=14");
      const json = await res.json();
      setEvents(json.events ?? []);
      setTiming(json.timing ?? []);
    } catch (e) {
      console.error("Meals load:", e);
    } finally {
      setMealsLoading(false);
    }
  }, []);

  useEffect(() => { loadMeals(); }, [loadMeals]);

  async function logMeal() {
    setLogging(true);
    try {
      const explicitTimeIso = customTimeOpen ? localInputToIso(eventTimeLocal) : null;
      const res = await fetch("/api/meals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_date: eventDate,
          event_time: explicitTimeIso ?? new Date().toISOString(),
          kind: mealKind,
          notes: notes.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setNotes("");
      setCustomTimeOpen(false);
      setEventTimeLocal("");
      await loadMeals();
    } catch (e) {
      console.error("Log meal:", e);
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setLogging(false);
    }
  }

  function startEdit(ev: MealEvent) {
    setEditingId(ev.event_id);
    setEditDate(ev.event_date);
    setEditTime(isoToLocalInput(ev.event_time));
    setEditNotes(ev.notes ?? "");
    const k = ev.kind as "last_meal" | "first_meal" | "snack" | "other";
    setEditKind(["last_meal", "first_meal", "snack", "other"].includes(k) ? k : "other");
  }

  async function saveEdit() {
    if (editingId === null) return;
    setLogging(true);
    try {
      const res = await fetch("/api/meals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: editingId,
          event_date: editDate,
          event_time: localInputToIso(editTime),
          kind: editKind,
          notes: editNotes,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEditingId(null);
      await loadMeals();
    } catch (e) {
      console.error("Save edit:", e);
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setLogging(false);
    }
  }

  async function deleteEvent(event_id: number) {
    if (!confirm("Delete this meal event?")) return;
    setLogging(true);
    try {
      const res = await fetch(`/api/meals?event_id=${event_id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      if (editingId === event_id) setEditingId(null);
      await loadMeals();
    } catch (e) {
      console.error("Delete:", e);
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setLogging(false);
    }
  }

  // KPI tiles for meal timing — derived from the timing view.
  const todayRow = timing.find((t) => t.calendar_date === today);
  const last7 = timing.slice(0, 7).filter((t) => t.last_meal_hour !== null);
  const avgLastMealHour =
    last7.length > 0
      ? last7.reduce((s, t) => s + (t.last_meal_hour ?? 0), 0) / last7.length
      : null;
  const lateNights = timing
    .slice(0, 14)
    .filter((t) => {
      const h = t.last_meal_hour as number | null;
      return h !== null && (h >= 21 || h < 4);
    }).length;

  // ─── Nutrition + burnt + micronutrients loader (responds to range filter) ───
  useEffect(() => {
    setNutritionLoading(true);
    Promise.all([
      getNutrition(rangeDays(range)),
      getWhoopCaloriesBurnt(rangeDays(range)),
      getDailyVitamins(rangeDays(range)),
      getDailyNutrientsFull(rangeDays(range)),
    ])
      .then(([n, b, v, f]) => {
        setNutritionData(n);
        setBurntData(b);
        setVitaminsData(v);
        setFullNutrients(f);
      })
      .catch(console.error)
      .finally(() => setNutritionLoading(false));
  }, [range]);

  // ─── Today's Cronometer food log ───
  useEffect(() => {
    getCronometerServings(1, today)
      .then(setTodayServings)
      .catch(console.error);
  }, [today]);

  // ─── Weight loader + default date init ───
  const loadWeight = useCallback(async () => {
    setWeightLoading(true);
    try {
      const res = await fetch(`/api/weight?days=${Math.max(rangeDays(range), 90)}`);
      const json = await res.json();
      setWeightRows((json.rows ?? []) as WeightRow[]);
    } catch (e) {
      console.error("Weight load:", e);
    } finally {
      setWeightLoading(false);
    }
  }, [range]);

  useEffect(() => { loadWeight(); }, [loadWeight]);
  useEffect(() => { setWeightDate(etTodayStr()); }, []);

  // Override the client-computed default with the server's behavioral_today
  // (TZ-aware + awake-tail-aware via pds.behavioral_today_now). Falls back
  // silently if the RPC fails; the client default already handles 00-04 ET.
  useEffect(() => {
    fetch("/api/behavioral-today")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.behavioral_today && j.behavioral_today !== eventDate) {
          setEventDate(j.behavioral_today);
        }
      })
      .catch(() => {});
    // Run once on mount; intentionally exclude eventDate from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveWeight() {
    const lb = parseFloat(weightInput);
    if (!Number.isFinite(lb) || lb <= 0 || lb > 1000) {
      alert("Enter a weight in pounds between 0 and 1000.");
      return;
    }
    setSavingWeight(true);
    try {
      const res = await fetch("/api/weight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          log_date: weightDate || etTodayStr(),
          weight_kg: lbToKg(lb),
          notes: weightNotes.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setWeightInput("");
      setWeightNotes("");
      await loadWeight();
    } catch (e) {
      console.error("Save weight:", e);
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingWeight(false);
    }
  }

  async function deleteWeight(log_date: string) {
    if (!confirm(`Delete weight entry for ${log_date}?`)) return;
    try {
      const res = await fetch(`/api/weight?log_date=${log_date}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      await loadWeight();
    } catch (e) {
      console.error("Delete weight:", e);
      alert(e instanceof Error ? e.message : String(e));
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
  const todayWeight = weightRows.find((w) => w.log_date === etTodayStr());

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

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Nutrition / Meal Timing</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            Clock-time meal events for HRV timing analysis + daily macros from MyFitnessPal — {rangeLabel(range)}
          </p>
        </div>
        <RangeFilter value={range} onChange={setRange} />
      </div>

      {/* ─── Meal Timing ────────────────────────────────────────────────── */}
      <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">Meal Timing</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="Last meal today"
          value={todayRow?.last_meal_time ? formatClockET(todayRow.last_meal_time) : "—"}
          sublabel={todayRow ? `${todayRow.meal_event_count} event${todayRow.meal_event_count === 1 ? "" : "s"}` : "no events"}
        />
        <StatCard
          label="Avg last meal (7d)"
          value={formatHourDecimal(avgLastMealHour)}
          sublabel="trailing 7 days"
        />
        <StatCard
          label="Late nights (9pm–4am)"
          value={lateNights}
          sublabel="of last 14 days"
        />
        <StatCard
          label="Events logged"
          value={events.length}
          sublabel="last 14 days"
        />
      </div>

      {mealsLoading ? (
        <p className="text-[12px] text-text-tertiary font-mono mb-10">Loading meal events…</p>
      ) : (
        <div className="space-y-6 mb-10">
          {/* Quick-log card */}
          <ChartCard
            title={isLoggingForToday ? "Log meal — now" : `Log meal for ${formatShortDate(eventDate)}`}
            subtitle="One tap = one event. By default uses the current clock time; tap 'change time' to log retroactively."
          >
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono">
                Date
              </label>
              <input
                type="date"
                value={eventDate}
                max={today}
                onChange={(e) => setEventDate(e.target.value || today)}
                className="px-2 py-1 text-[12px] font-mono bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
              />
              {isAutoBedtimeAdjusted ? (
                <>
                  <span className="text-[10px] font-mono text-emerald-300/90">
                    auto-attributed to {formatShortDate(eventDate)} — pre-bed meal
                  </span>
                  <button
                    onClick={() => setEventDate(today)}
                    className="text-[10px] font-mono text-text-tertiary hover:text-text-primary underline underline-offset-2"
                  >
                    use today instead
                  </button>
                </>
              ) : !isLoggingForToday ? (
                <>
                  <span className="text-[10px] font-mono text-amber-400/90">
                    logging to {formatShortDate(eventDate)} — not today
                  </span>
                  <button
                    onClick={() => setEventDate(today)}
                    className="text-[10px] font-mono text-text-tertiary hover:text-text-primary underline underline-offset-2"
                  >
                    reset to today
                  </button>
                </>
              ) : null}
            </div>

            {(isAutoBedtimeAdjusted || !isLoggingForToday) && (
              <div className="mb-3 px-3 py-2 text-[11px] leading-snug bg-emerald-500/5 border border-emerald-500/15 rounded-[4px] text-text-secondary">
                <span className="font-mono uppercase tracking-wide text-[9px] text-emerald-300/90 block mb-0.5">
                  Why {formatShortDate(eventDate)}?
                </span>
                {isAutoBedtimeAdjusted ? (
                  <>
                    It&apos;s {currentHourET < 1 ? "just past" : "after"} midnight, so this meal almost certainly belongs to <b>yesterday&apos;s</b> behavioral day —
                    the pre-bed window before tonight&apos;s WHOOP cycle starts.
                    The actual clock time stays accurate; only the date column flips.
                    This lines the row up with the sleep that follows so the HRV pipeline
                    can compute <code className="font-mono text-emerald-300/90">last_meal_to_bedtime_min</code> correctly.
                    Tap <i>use today instead</i> if this was actually a 1 AM meal mid-day.
                  </>
                ) : (
                  <>
                    Each meal&apos;s <code className="font-mono text-emerald-300/90">event_date</code> reflects the behavioral day
                    it belongs to — the day that <i>ends</i> with the following sleep. Same convention as supplements.
                  </>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 mb-3">
              <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono">
                Kind
              </label>
              <button
                onClick={() => setMealKind("last_meal")}
                className={`px-2.5 py-1 text-[11px] font-mono rounded-[4px] border transition-colors ${
                  mealKind === "last_meal"
                    ? "bg-[#1DB954]/20 border-[#1DB954]/40 text-text-primary"
                    : "bg-black/20 border-border-subtle text-text-tertiary hover:text-text-secondary"
                }`}
              >
                last meal
              </button>
              <button
                onClick={() => setMealKind("first_meal")}
                className={`px-2.5 py-1 text-[11px] font-mono rounded-[4px] border transition-colors ${
                  mealKind === "first_meal"
                    ? "bg-[#1DB954]/20 border-[#1DB954]/40 text-text-primary"
                    : "bg-black/20 border-border-subtle text-text-tertiary hover:text-text-secondary"
                }`}
              >
                first meal
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 mb-3">
              <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono">
                Time
              </label>
              {!customTimeOpen ? (
                <>
                  <span className="text-[12px] font-mono text-text-secondary">now</span>
                  <button
                    onClick={() => {
                      setEventTimeLocal(isoToLocalInput(new Date().toISOString()));
                      setCustomTimeOpen(true);
                    }}
                    className="text-[10px] font-mono text-text-tertiary hover:text-text-primary underline underline-offset-2"
                  >
                    change time
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="datetime-local"
                    value={eventTimeLocal}
                    onChange={(e) => setEventTimeLocal(e.target.value)}
                    className="px-2 py-1 text-[12px] font-mono bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
                  />
                  <span className="text-[10px] font-mono text-amber-400/90">
                    logging at an earlier clock time
                  </span>
                  <button
                    onClick={() => {
                      setCustomTimeOpen(false);
                      setEventTimeLocal("");
                    }}
                    className="text-[10px] font-mono text-text-tertiary hover:text-text-primary underline underline-offset-2"
                  >
                    reset to now
                  </button>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 mb-3">
              <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono shrink-0">
                Notes
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="optional — e.g. 'late dinner', 'fasting before bed'"
                className="flex-1 min-w-[200px] px-2 py-1 text-[12px] font-mono bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
              />
            </div>

            <button
              onClick={logMeal}
              disabled={logging}
              className="w-full px-4 py-3 text-[13px] font-medium text-text-primary bg-[#1DB954]/20 hover:bg-[#1DB954]/30 disabled:opacity-40 disabled:cursor-not-allowed border border-[#1DB954]/40 rounded-[4px] transition-colors"
            >
              {logging ? "Saving…" : mealKind === "first_meal" ? "Log first meal" : "Log last meal"}
            </button>
          </ChartCard>

          {/* Daily timing summary */}
          <ChartCard
            title="Daily timing"
            subtitle="One row per ET date · last_meal → bedtime gap is what the HRV pipeline reads"
            info="last_meal → bedtime is computed against the WHOOP cycle that closes the behavioral day; it stays monotonic in physiological lateness even for post-midnight meals (a 1:30 AM meal + 1:35 AM bedtime = 5 min). NULL until WHOOP syncs that night's sleep."
          >
            {timing.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-6 text-center">
                No meal events yet. Tap &quot;Log last meal&quot; above to start.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] font-mono">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-text-tertiary border-b border-border-subtle">
                      <th className="text-left py-2 px-1 font-normal w-[80px]">Date</th>
                      <th className="text-left py-2 px-1 font-normal">Last meal</th>
                      <th className="text-right py-2 px-1 font-normal w-[110px]">→ Bedtime</th>
                      <th className="text-right py-2 px-1 font-normal w-[80px]">Window</th>
                      <th className="text-right py-2 px-1 font-normal w-[60px]">Events</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timing.map((t) => (
                      <tr
                        key={t.calendar_date}
                        className="border-b border-border-subtle/50 hover:bg-white/[0.02]"
                      >
                        <td className="py-1.5 px-1 text-text-secondary">
                          {formatShortDate(t.calendar_date)}
                        </td>
                        <td className="py-1.5 px-1 text-text-primary">
                          {formatClockET(t.last_meal_time)}
                        </td>
                        <td className="py-1.5 px-1 text-right text-text-secondary tabular-nums">
                          {t.last_meal_to_bedtime_minutes !== null
                            ? `${Math.round(t.last_meal_to_bedtime_minutes)} min`
                            : "—"}
                        </td>
                        <td className="py-1.5 px-1 text-right text-text-secondary tabular-nums">
                          {t.eating_window_hours !== null ? `${Number(t.eating_window_hours).toFixed(1)}h` : "—"}
                        </td>
                        <td className="py-1.5 px-1 text-right text-text-tertiary tabular-nums">
                          {t.meal_event_count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ChartCard>

          {/* Raw events — for editing / deleting */}
          <ChartCard
            title="Recent events"
            subtitle={`${events.length} events · newest first`}
          >
            {events.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-4 text-center">
                No events in the last 14 days.
              </p>
            ) : (
              <div className="space-y-1">
                {events.map((e) => (
                  <div
                    key={e.event_id}
                    className="flex items-center justify-between gap-3 py-1.5 border-b border-border-subtle/40 last:border-b-0 text-[12px] font-mono"
                  >
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-text-tertiary tabular-nums shrink-0 w-[90px]">
                        {e.event_date.slice(5)} {formatClockET(e.event_time)}
                      </span>
                      <span className="text-text-primary truncate">
                        {e.kind.replace(/_/g, " ")}
                      </span>
                      {e.notes && (
                        <span className="text-text-tertiary truncate">· {e.notes}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => startEdit(e)}
                        className="px-2 py-1 text-[10px] font-mono text-text-secondary hover:text-text-primary bg-black/20 hover:bg-black/40 border border-border-subtle rounded-[4px] transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteEvent(e.event_id)}
                        className="px-2 py-1 text-[10px] font-mono text-red-400/80 hover:text-red-400 bg-black/20 hover:bg-red-500/10 border border-red-500/20 hover:border-red-500/40 rounded-[4px] transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ChartCard>
        </div>
      )}

      <div className="border-t border-border-subtle mb-8" />

      {/* ─── Daily Macros (Cronometer; MFP fills pre-cutover history) ──────── */}
      <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">Cronometer · Daily Macros</p>

      {nutritionLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-surface-card border border-border-subtle rounded-[6px] p-4 space-y-3">
                <div className="h-3 w-16 bg-white/5 animate-pulse rounded" />
                <div className="h-8 w-24 bg-white/5 animate-pulse rounded" />
              </div>
            ))}
          </div>
          <div className="h-[320px] bg-surface-card border border-border-subtle rounded-[6px] animate-pulse" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatCard
              label="Calories"
              value={latest?.calories ?? null}
              sublabel={avgCalories > 0 ? `avg ${Math.round(avgCalories)} kcal` : undefined}
              source="CRONOMETER"
            />
            <StatCard
              label="Protein"
              value={latest?.protein_g ? `${Number(latest.protein_g).toFixed(0)}g` : null}
              sublabel={avgProtein > 0 ? `avg ${avgProtein.toFixed(0)}g` : undefined}
              source="CRONOMETER"
            />
            <StatCard
              label="Carbs"
              value={latest?.carbs_g ? `${Number(latest.carbs_g).toFixed(0)}g` : null}
              sublabel={avgCarbs > 0 ? `avg ${avgCarbs.toFixed(0)}g` : undefined}
              source="CRONOMETER"
            />
            <StatCard
              label="Fat"
              value={latest?.fat_g ? `${Number(latest.fat_g).toFixed(0)}g` : null}
              sublabel={avgFat > 0 ? `avg ${avgFat.toFixed(0)}g` : undefined}
              source="CRONOMETER"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ChartCard
              title="Calorie Trend — Consumed vs Burnt"
              subtitle="Cronometer daily intake against WHOOP cycle energy expenditure (kilojoule → kcal). Net = consumed − burnt."
              source="CRONOMETER + WHOOP"
              className="lg:col-span-2"
            >
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={calorieData}>
                  <defs>
                    <linearGradient id="calConsumedGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
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
                    stroke="#06b6d4"
                    strokeWidth={2}
                    fill="url(#calConsumedGrad)"
                    name="Consumed (Cronometer)"
                    connectNulls={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="burnt"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={false}
                    name="Burnt (WHOOP)"
                    connectNulls={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Net Energy Balance"
              subtitle="Consumed − burnt per day. Above zero = surplus, below = deficit."
              source="CRONOMETER + WHOOP"
              className="lg:col-span-2"
            >
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={calorieData}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={60} label={axisLabel("kcal", "y")} />
                  <Tooltip {...chartTooltip} />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
                  <Bar dataKey="net" name="Net (kcal)" radius={[2, 2, 0, 0]}>
                    {calorieData.map((d, i) => (
                      <Cell
                        key={i}
                        fill={(d.net ?? 0) >= 0 ? "#f59e0b" : "#22c55e"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Macro Breakdown (g)" source="CRONOMETER" className="lg:col-span-2">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={macroData}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={48} />
                  <Tooltip {...chartTooltip} />
                  <Legend wrapperStyle={legendStyle} />
                  <Bar dataKey="protein" stackId="macros" fill="#22c55e" name="Protein (g)" />
                  <Bar dataKey="carbs" stackId="macros" fill="#3b82f6" name="Carbs (g)" />
                  <Bar dataKey="fat" stackId="macros" fill="#f59e0b" name="Fat (g)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Protein, Fat, Fiber & Sugar (g)" source="CRONOMETER" className="lg:col-span-2">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={detailData}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={40} />
                  <Tooltip {...chartTooltip} />
                  <Legend wrapperStyle={legendStyle} />
                  <Line type="monotone" dataKey="protein" stroke="#22c55e" strokeWidth={2} dot={false} name="Protein (g)" connectNulls={false} />
                  <Line type="monotone" dataKey="fat" stroke="#f59e0b" strokeWidth={2} dot={false} name="Fat (g)" connectNulls={false} />
                  <Line type="monotone" dataKey="fiber" stroke="#a78bfa" strokeWidth={2} dot={false} name="Fiber (g)" connectNulls={false} />
                  <Line type="monotone" dataKey="sugar" stroke="#f87171" strokeWidth={2} dot={false} name="Sugar (g)" connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </>
      )}

      <div className="border-t border-border-subtle my-10" />

      {/* ─── Vitamins & Minerals (Cronometer dietary + Onyx supplement) ─────── */}
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest">Vitamins &amp; Minerals</p>
        <span className="text-[10px] font-mono text-text-tertiary">CRONOMETER + SUPPLEMENTS · latest day · % of RDA</span>
      </div>
      {(() => {
        const vL = vitaminsData[vitaminsData.length - 1];
        const last7 = vitaminsData.slice(-7);
        const num = (v: any) => (v == null ? null : Number(v));
        const fmtN = (v: number | null) =>
          v == null ? "—" : v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(0) : v.toFixed(1);
        return (
          <div className="space-y-5">
            {VITAMIN_GROUPS.map((grp) => (
              <div key={grp}>
                <p className="text-[10px] font-mono text-text-tertiary mb-2">{grp}</p>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {VITAMIN_DEFS.filter((d) => d.group === grp).map((d) => {
                    const total = num(vL?.[`${d.key}_total_${d.tok}`]);
                    const diet = num(vL?.[`${d.key}_dietary_${d.tok}`]);
                    const supp = num(vL?.[`${d.key}_supplement_${d.tok}`]);
                    const avg7 = avg(last7, `${d.key}_total_${d.tok}`);
                    const pct = total != null && d.rda ? (total / d.rda) * 100 : null;
                    const barColor = pct == null ? "bg-white/10" : pct >= 100 ? "bg-green-500" : pct >= 50 ? "bg-cyan-500" : "bg-amber-500";
                    return (
                      <div key={d.key} className="bg-surface-card border border-border-subtle rounded-[6px] p-3">
                        <div className="flex justify-between items-baseline">
                          <span className="text-xs text-text-secondary truncate">{d.label}</span>
                          <span className="text-[10px] font-mono text-text-tertiary shrink-0 ml-1">{pct == null ? "—" : `${Math.round(pct)}%`}</span>
                        </div>
                        <div className="text-base font-mono mt-1">
                          {fmtN(total)}
                          <span className="text-[10px] text-text-tertiary ml-1">{d.unit}</span>
                        </div>
                        <div className="h-1 bg-white/5 rounded mt-2 overflow-hidden">
                          <div className={`h-full ${barColor}`} style={{ width: `${pct == null ? 0 : Math.min(pct, 100)}%` }} />
                        </div>
                        <div className="text-[10px] font-mono text-text-tertiary mt-1.5 truncate">
                          food {fmtN(diet)} · supp {fmtN(supp)} · 7d {fmtN(avg7 || null)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {!vL && (
              <p className="text-xs text-text-tertiary">No Cronometer micronutrient data yet — import an export to populate.</p>
            )}
          </div>
        );
      })()}

      <div className="border-t border-border-subtle my-10" />

      {/* ─── Today's meals (Cronometer per-entry log) ──────────────────────── */}
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest">Today&apos;s Meals</p>
        <span className="text-[10px] font-mono text-text-tertiary">CRONOMETER · {today}</span>
      </div>
      {todayServings.length === 0 ? (
        <p className="text-xs text-text-tertiary mb-2">
          No Cronometer entries for today yet. Entries appear after you export from Cronometer and the import runs.
        </p>
      ) : (
        <div className="bg-surface-card border border-border-subtle rounded-[6px] divide-y divide-border-subtle">
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
      )}

      <div className="border-t border-border-subtle my-10" />

      {/* ─── All tracked nutrients (Cronometer dietary; latest day + 7d avg) ── */}
      <details className="group">
        <summary className="cursor-pointer text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3 list-none flex items-center gap-2">
          <span className="group-open:rotate-90 transition-transform">▸</span> All Tracked Nutrients
          <span className="text-text-tertiary/60 normal-case tracking-normal">— amino acids, fat fractions, etc.</span>
        </summary>
        {(() => {
          const fL = fullNutrients[fullNutrients.length - 1];
          const last7 = fullNutrients.slice(-7);
          const fmtN = (v: any) => (v == null ? "—" : Number(v) >= 10 ? Number(v).toFixed(0) : Number(v).toFixed(2));
          return (
            <div className="bg-surface-card border border-border-subtle rounded-[6px] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] font-mono text-text-tertiary uppercase border-b border-border-subtle">
                    <th className="text-left px-4 py-2">Nutrient</th>
                    <th className="text-right px-4 py-2">Latest</th>
                    <th className="text-right px-4 py-2">7d avg</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {EXTRA_NUTRIENT_COLS.map((n) => (
                    <tr key={n.col} className="border-b border-border-subtle/50 last:border-0">
                      <td className="text-left px-4 py-1.5 text-text-secondary font-sans">{n.label}</td>
                      <td className="text-right px-4 py-1.5">{fmtN(fL?.[n.col])}<span className="text-text-tertiary text-[10px] ml-1">{n.unit}</span></td>
                      <td className="text-right px-4 py-1.5 text-text-tertiary">{fmtN(avg(last7, n.col) || null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })()}
      </details>

      <div className="border-t border-border-subtle my-10" />

      {/* ─── Body Weight ───────────────────────────────────────────────────── */}
      <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">Body Weight</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="Latest"
          value={latestWeightLb !== null ? `${latestWeightLb.toFixed(1)} lb` : "—"}
          sublabel={latestWeight ? formatShortDate(latestWeight.log_date) : "no entries"}
        />
        <StatCard
          label="7d avg"
          value={sevenDayWeightAvg !== null ? `${sevenDayWeightAvg.toFixed(1)} lb` : "—"}
          sublabel="trailing 7 days"
        />
        <StatCard
          label="30d delta"
          value={
            thirtyDayDelta !== null
              ? `${thirtyDayDelta >= 0 ? "+" : ""}${thirtyDayDelta.toFixed(1)} lb`
              : "—"
          }
          sublabel="vs ~30 days ago"
        />
        <StatCard
          label="Entries"
          value={weightRows.length}
          sublabel="last 90 days"
        />
      </div>

      <div className="space-y-6 mb-10">
        {/* Quick-log card */}
        <ChartCard
          title={weightDate === etTodayStr() ? "Log weight — today" : `Log weight for ${formatShortDate(weightDate)}`}
          subtitle={
            todayWeight && weightDate === etTodayStr()
              ? `Already logged today (${kgToLb(Number(todayWeight.weight_kg))!.toFixed(1)} lb). Saving overwrites.`
              : "One entry per day. Stored in kg; entered + displayed in pounds."
          }
        >
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono">
              Date
            </label>
            <input
              type="date"
              value={weightDate}
              max={etTodayStr()}
              onChange={(e) => setWeightDate(e.target.value || etTodayStr())}
              disabled={savingWeight}
              className="px-2 py-1 text-[12px] font-mono bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none disabled:opacity-40"
            />
            {weightDate !== etTodayStr() && (
              <>
                <span className="text-[10px] font-mono text-amber-400/90">
                  logging to {formatShortDate(weightDate)} — not today
                </span>
                <button
                  onClick={() => setWeightDate(etTodayStr())}
                  className="text-[10px] font-mono text-text-tertiary hover:text-text-primary underline underline-offset-2"
                >
                  reset to today
                </button>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono">
              Weight
            </label>
            <input
              type="number"
              step="0.1"
              inputMode="decimal"
              value={weightInput}
              onChange={(e) => setWeightInput(e.target.value)}
              placeholder="e.g. 178.4"
              disabled={savingWeight}
              className="w-[120px] px-2 py-1 text-[12px] font-mono bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none disabled:opacity-40"
            />
            <span className="text-[10px] font-mono text-text-tertiary">lb</span>
            {weightInput && !isNaN(parseFloat(weightInput)) && (
              <span className="text-[10px] font-mono text-text-tertiary">
                = {lbToKg(parseFloat(weightInput)).toFixed(2)} kg
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono shrink-0">
              Notes
            </label>
            <input
              type="text"
              value={weightNotes}
              onChange={(e) => setWeightNotes(e.target.value)}
              placeholder="optional — e.g. 'morning, post-bathroom', 'after workout'"
              disabled={savingWeight}
              className="flex-1 min-w-[200px] px-2 py-1 text-[12px] font-mono bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none disabled:opacity-40"
            />
          </div>

          <button
            onClick={saveWeight}
            disabled={savingWeight || !weightInput}
            className="w-full px-4 py-3 text-[13px] font-medium text-text-primary bg-[#1DB954]/20 hover:bg-[#1DB954]/30 disabled:opacity-40 disabled:cursor-not-allowed border border-[#1DB954]/40 rounded-[4px] transition-colors"
          >
            {savingWeight ? "Saving…" : "Save weight"}
          </button>
        </ChartCard>

        {/* Trend chart */}
        <ChartCard
          title="Weight Trend"
          subtitle="One row per ET day · displayed in pounds (stored as kg)"
        >
          {weightLoading ? (
            <p className="text-[11px] text-text-tertiary font-mono py-6 text-center">Loading…</p>
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
                  stroke="#a78bfa"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#a78bfa" }}
                  name="Weight (lb)"
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Recent entries (delete-only — edit a row by re-logging the same date) */}
        {weightRows.length > 0 && (
          <ChartCard
            title="Recent entries"
            subtitle="Newest first · re-log the same date to overwrite · trash to delete"
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
          </ChartCard>
        )}
      </div>

      {/* Edit modal — shared, lives at the bottom so it overlays everything */}
      {editingId !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setEditingId(null)}
        >
          <div
            className="bg-surface-card border border-border-subtle rounded-[6px] shadow-card p-5 w-full max-w-md mt-12"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[14px] font-medium text-text-primary">Edit meal event</h2>
              <button
                onClick={() => setEditingId(null)}
                disabled={logging}
                className="text-[11px] text-text-tertiary hover:text-text-secondary font-mono disabled:opacity-40"
              >
                Close
              </button>
            </div>

            <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
              Kind
            </label>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {(["last_meal", "first_meal", "snack", "other"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setEditKind(k)}
                  disabled={logging}
                  className={`px-2.5 py-1 text-[11px] font-mono rounded-[4px] border transition-colors disabled:opacity-40 ${
                    editKind === k
                      ? "bg-[#1DB954]/20 border-[#1DB954]/40 text-text-primary"
                      : "bg-black/20 border-border-subtle text-text-tertiary hover:text-text-secondary"
                  }`}
                >
                  {k.replace(/_/g, " ")}
                </button>
              ))}
            </div>

            <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
              Date
            </label>
            <input
              type="date"
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              disabled={logging}
              className="w-full mb-3 px-3 py-2 text-[13px] font-mono bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none disabled:opacity-50"
            />

            <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
              Time
            </label>
            <input
              type="datetime-local"
              value={editTime}
              onChange={(e) => setEditTime(e.target.value)}
              disabled={logging}
              className="w-full mb-3 px-3 py-2 text-[13px] font-mono bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none disabled:opacity-50"
            />

            <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
              Notes
            </label>
            <textarea
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              disabled={logging}
              rows={2}
              className="w-full mb-3 px-3 py-2 text-[13px] bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none resize-none disabled:opacity-50"
            />

            <div className="flex justify-between gap-2">
              <button
                onClick={() => deleteEvent(editingId)}
                disabled={logging}
                className="px-3 py-2 text-[12px] text-red-400/80 hover:text-red-400 disabled:opacity-40 transition-colors"
              >
                Delete
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditingId(null)}
                  disabled={logging}
                  className="px-3 py-2 text-[12px] text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={logging}
                  className="px-4 py-2 text-[12px] font-medium text-text-primary bg-[#1DB954]/20 hover:bg-[#1DB954]/30 disabled:opacity-40 disabled:cursor-not-allowed border border-[#1DB954]/40 rounded-[4px] transition-colors"
                >
                  {logging ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
