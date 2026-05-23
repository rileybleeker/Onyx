"use client";

import { useCallback, useEffect, useState } from "react";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";

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
}

/** Current ET date as YYYY-MM-DD — used as the default event_date. */
function etTodayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
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

export default function MealsPage() {
  const [events, setEvents] = useState<MealEvent[]>([]);
  const [timing, setTiming] = useState<MealTimingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [logging, setLogging] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  // Event-date override — defaults to ET today. Same behavioral-day
  // semantics as supplements (a 12:05 AM pre-bed meal can be attributed
  // to the previous day).
  const [eventDate, setEventDate] = useState<string>(etTodayStr());

  // Optional event-time override. Empty → use now() at log time.
  const [customTimeOpen, setCustomTimeOpen] = useState(false);
  const [eventTimeLocal, setEventTimeLocal] = useState<string>("");

  const [notes, setNotes] = useState("");

  // Edit-modal state — populated from the row clicked.
  const [editDate, setEditDate] = useState("");
  const [editTime, setEditTime] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const today = etTodayStr();
  const isLoggingForToday = eventDate === today;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/meals?days=14");
      const json = await res.json();
      setEvents(json.events ?? []);
      setTiming(json.timing ?? []);
    } catch (e) {
      console.error("Meals load:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
      await load();
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
      await load();
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
      await load();
    } catch (e) {
      console.error("Delete:", e);
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setLogging(false);
    }
  }

  // KPI tiles — derived from the timing view.
  const todayRow = timing.find((t) => t.calendar_date === today);
  const last7 = timing.slice(0, 7).filter((t) => t.last_meal_hour !== null);
  const avgLastMealHour =
    last7.length > 0
      ? last7.reduce((s, t) => s + (t.last_meal_hour ?? 0), 0) / last7.length
      : null;
  const lateNights = timing
    .slice(0, 14)
    .filter((t) => t.last_meal_hour !== null && (t.last_meal_hour as number) >= 21).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[20px] font-medium text-text-primary tracking-tight">Meals</h1>
        <p className="text-[12px] text-text-tertiary mt-0.5">
          Clock-time meal events — feeds HRV timing analysis. One tap per meal; defaults to now.
        </p>
      </header>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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

      {loading ? (
        <p className="text-[12px] text-text-tertiary font-mono">Loading…</p>
      ) : (
        <>
          {/* Quick-log card */}
          <ChartCard
            title={isLoggingForToday ? "Log meal — now" : `Log meal for ${formatShortDate(eventDate)}`}
            subtitle="One tap = one event. By default uses the current clock time; tap 'change time' to log retroactively."
          >
            {/* Date override row */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
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
              {!isLoggingForToday && (
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
              )}
            </div>

            {/* Time override row */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono">
                Time
              </label>
              {!customTimeOpen ? (
                <>
                  <span className="text-[12px] font-mono text-text-secondary">now</span>
                  <button
                    onClick={() => {
                      // Seed the picker with the current local clock so the user
                      // only has to nudge it backwards.
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

            {/* Notes — optional */}
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
            subtitle="One row per ET date · last_meal_hour is what feeds the HRV pipeline"
            info="last_meal_hour is a decimal hour (e.g. 19.75 = 7:45 PM ET). meal_event_count just tells you how many times you tapped the log button that day — typically 1."
          >
            {timing.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-6 text-center">
                No meal events yet. Tap "Log last meal" above to start.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] font-mono">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-text-tertiary border-b border-border-subtle">
                      <th className="text-left py-2 px-1 font-normal w-[80px]">Date</th>
                      <th className="text-left py-2 px-1 font-normal">Last meal</th>
                      <th className="text-right py-2 px-1 font-normal w-[100px]">Last hr</th>
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
                          {t.last_meal_hour !== null ? Number(t.last_meal_hour).toFixed(2) : "—"}
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
        </>
      )}

      {/* Edit modal */}
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
    </div>
  );
}
