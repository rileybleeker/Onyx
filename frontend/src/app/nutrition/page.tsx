"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AreaChart, Area,
  BarChart, Bar,
  LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from "recharts";
import { getMfpNutrition, rangeDays, rangeLabel, type Range } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";
import { chartTooltip, axisTick, gridStyle, axisLabel } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

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

export default function NutritionPage() {
  // ─── Nutrition state ───
  const [nutritionData, setNutritionData] = useState<any[]>([]);
  const [nutritionLoading, setNutritionLoading] = useState(true);
  const [range, setRange] = useState<Range>("30d");

  // ─── Meal-timing state ───
  const [events, setEvents] = useState<MealEvent[]>([]);
  const [timing, setTiming] = useState<MealTimingRow[]>([]);
  const [mealsLoading, setMealsLoading] = useState(true);
  const [logging, setLogging] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [eventDate, setEventDate] = useState<string>(defaultEventDate());
  const [customTimeOpen, setCustomTimeOpen] = useState(false);
  const [eventTimeLocal, setEventTimeLocal] = useState<string>("");
  const [notes, setNotes] = useState("");

  const [editDate, setEditDate] = useState("");
  const [editTime, setEditTime] = useState("");
  const [editNotes, setEditNotes] = useState("");

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
          kind: "last_meal",
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
    .filter((t) => t.last_meal_hour !== null && (t.last_meal_hour as number) >= 21).length;

  // ─── Nutrition loader (responds to range filter) ───
  useEffect(() => {
    setNutritionLoading(true);
    getMfpNutrition(rangeDays(range))
      .then(setNutritionData)
      .catch(console.error)
      .finally(() => setNutritionLoading(false));
  }, [range]);

  const latest = nutritionData[nutritionData.length - 1];

  const calorieData = nutritionData.map((d) => ({
    date: formatDate(d.calendar_date),
    calories: d.calories ?? null,
  }));

  const macroData = nutritionData.map((d) => ({
    date: formatDate(d.calendar_date),
    protein: d.protein_g ? +Number(d.protein_g).toFixed(1) : 0,
    carbs: d.carbs_g ? +Number(d.carbs_g).toFixed(1) : 0,
    fat: d.fat_g ? +Number(d.fat_g).toFixed(1) : 0,
  }));

  const fiberSugarData = nutritionData.map((d) => ({
    date: formatDate(d.calendar_date),
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
          label="Late nights (≥9pm)"
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
              {logging ? "Saving…" : "Log last meal"}
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
            subtitle={`${events.length} events · newest first · tap row to edit`}
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
                        {e.kind === "last_meal" ? "last meal" : e.kind}
                      </span>
                      {e.notes && (
                        <span className="text-text-tertiary truncate">· {e.notes}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => startEdit(e)}
                        className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
                      >
                        edit
                      </button>
                      <button
                        onClick={() => deleteEvent(e.event_id)}
                        className="text-[10px] text-text-tertiary hover:text-red-400 transition-colors"
                      >
                        delete
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

      {/* ─── Daily Macros (MyFitnessPal) ──────────────────────────────────── */}
      <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">MFP · Daily Macros</p>

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
              source="MFP"
            />
            <StatCard
              label="Protein"
              value={latest?.protein_g ? `${Number(latest.protein_g).toFixed(0)}g` : null}
              sublabel={avgProtein > 0 ? `avg ${avgProtein.toFixed(0)}g` : undefined}
              source="MFP"
            />
            <StatCard
              label="Carbs"
              value={latest?.carbs_g ? `${Number(latest.carbs_g).toFixed(0)}g` : null}
              sublabel={avgCarbs > 0 ? `avg ${avgCarbs.toFixed(0)}g` : undefined}
              source="MFP"
            />
            <StatCard
              label="Fat"
              value={latest?.fat_g ? `${Number(latest.fat_g).toFixed(0)}g` : null}
              sublabel={avgFat > 0 ? `avg ${avgFat.toFixed(0)}g` : undefined}
              source="MFP"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ChartCard title="Calorie Trend" source="MFP" className="lg:col-span-2">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={calorieData}>
                  <defs>
                    <linearGradient id="calGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={60} label={axisLabel("kcal", "y")} />
                  <Tooltip {...chartTooltip} />
                  <Area
                    type="monotone"
                    dataKey="calories"
                    stroke="#06b6d4"
                    strokeWidth={2}
                    fill="url(#calGrad)"
                    name="Calories (kcal)"
                    connectNulls={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Macro Breakdown (g)" source="MFP" className="lg:col-span-2">
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

            <ChartCard title="Fiber & Sugar (g)" source="MFP">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={fiberSugarData}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={40} />
                  <Tooltip {...chartTooltip} />
                  <Legend wrapperStyle={legendStyle} />
                  <Line type="monotone" dataKey="fiber" stroke="#a78bfa" strokeWidth={2} dot={false} name="Fiber (g)" connectNulls={false} />
                  <Line type="monotone" dataKey="sugar" stroke="#f87171" strokeWidth={2} dot={false} name="Sugar (g)" connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Protein vs Fat (g)" source="MFP">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={macroData}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis tick={axisTick} width={40} />
                  <Tooltip {...chartTooltip} />
                  <Legend wrapperStyle={legendStyle} />
                  <Line type="monotone" dataKey="protein" stroke="#22c55e" strokeWidth={2} dot={false} name="Protein (g)" />
                  <Line type="monotone" dataKey="fat" stroke="#f59e0b" strokeWidth={2} dot={false} name="Fat (g)" />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </>
      )}

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
