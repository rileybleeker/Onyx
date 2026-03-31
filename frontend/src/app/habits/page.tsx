"use client";

import { useEffect, useState, useCallback } from "react";
import { getHabits, getHabitCompletions } from "@/lib/queries";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { formatDate } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CATEGORY_COLORS: Record<string, string> = {
  health: "#22c55e",
  fitness: "#3b82f6",
  mindfulness: "#a78bfa",
  productivity: "#f59e0b",
  nutrition: "#06b6d4",
  learning: "#ec4899",
  social: "#f97316",
  general: "#71717a",
};

const DEFAULT_HABIT_COLORS = [
  "#22c55e", "#3b82f6", "#a78bfa", "#f59e0b", "#06b6d4", "#ec4899", "#f97316", "#ef4444",
];

interface Habit {
  id: string;
  name: string;
  description: string | null;
  category: string;
  frequency: string;
  target_per_period: number;
  color: string;
  icon: string | null;
  active: boolean;
  sort_order: number;
  notion_reminder_id: string | null;
  created_at: string;
}

interface Completion {
  id: string;
  habit_id: string;
  completed_date: string;
  completed: boolean;
  value: number | null;
  notes: string | null;
}

function todayStr() {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
}

function getDatesArray(days: number): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toLocaleDateString("en-CA"));
  }
  return dates;
}

function calculateStreak(habit: Habit, completionMap: Map<string, boolean>): number {
  let streak = 0;
  const now = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString("en-CA");
    const key = `${habit.id}|${dateStr}`;

    // Skip weekends for weekday habits
    if (habit.frequency === "weekdays") {
      const day = d.getDay();
      if (day === 0 || day === 6) continue;
    }

    if (completionMap.get(key)) {
      streak++;
    } else {
      // Allow today to be incomplete without breaking streak
      if (i === 0) continue;
      break;
    }
  }
  return streak;
}

export default function HabitsPage() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newHabit, setNewHabit] = useState({
    name: "",
    description: "",
    category: "general",
    frequency: "daily",
    color: DEFAULT_HABIT_COLORS[0],
    icon: "",
    createReminder: true,
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [h, c] = await Promise.all([getHabits(), getHabitCompletions(90)]);
      setHabits(h);
      setCompletions(c);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const completionMap = new Map<string, boolean>();
  completions.forEach((c) => {
    if (c.completed) completionMap.set(`${c.habit_id}|${c.completed_date}`, true);
  });

  const today = todayStr();

  async function toggleCompletion(habitId: string) {
    const key = `${habitId}|${today}`;
    const isCompleted = completionMap.get(key);
    setToggling((prev) => new Set(prev).add(habitId));

    const sb = createSupabaseBrowser();
    try {
      if (isCompleted) {
        // Delete the completion
        await sb
          .from("habit_completions")
          .delete()
          .eq("habit_id", habitId)
          .eq("completed_date", today);
        setCompletions((prev) =>
          prev.filter((c) => !(c.habit_id === habitId && c.completed_date === today))
        );
      } else {
        // Upsert a completion
        const { data } = await sb
          .from("habit_completions")
          .upsert({ habit_id: habitId, completed_date: today, completed: true }, { onConflict: "habit_id,completed_date" })
          .select()
          .single();
        if (data) {
          setCompletions((prev) => [
            ...prev.filter((c) => !(c.habit_id === habitId && c.completed_date === today)),
            data,
          ]);
        }
      }
    } catch (e) {
      console.error("Failed to toggle habit:", e);
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(habitId);
        return next;
      });
    }
  }

  async function createHabit() {
    setSaving(true);
    const sb = createSupabaseBrowser();
    try {
      const payload: any = {
        name: newHabit.name.trim(),
        description: newHabit.description.trim() || null,
        category: newHabit.category,
        frequency: newHabit.frequency,
        color: newHabit.color,
        icon: newHabit.icon.trim() || null,
        sort_order: habits.length,
      };

      // Create in Supabase
      const { data, error } = await sb.from("habits").insert(payload).select().single();
      if (error) throw error;

      // Create Notion reminder via API route
      if (newHabit.createReminder && data) {
        try {
          const res = await fetch("/api/habits/notion-reminder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ habitId: data.id, name: data.name, category: data.category, frequency: data.frequency }),
          });
          if (res.ok) {
            const { notionPageId } = await res.json();
            if (notionPageId) {
              await sb.from("habits").update({ notion_reminder_id: notionPageId }).eq("id", data.id);
              data.notion_reminder_id = notionPageId;
            }
          }
        } catch (e) {
          console.error("Notion reminder creation failed (habit still created):", e);
        }
      }

      setHabits((prev) => [...prev, data]);
      setNewHabit({ name: "", description: "", category: "general", frequency: "daily", color: DEFAULT_HABIT_COLORS[(habits.length + 1) % DEFAULT_HABIT_COLORS.length], icon: "", createReminder: true });
      setShowAddForm(false);
    } catch (e) {
      console.error("Failed to create habit:", e);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-white/5 animate-pulse rounded" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-surface-card border border-border-subtle rounded-[6px] p-4 space-y-3">
              <div className="h-3 w-16 bg-white/5 animate-pulse rounded" />
              <div className="h-8 w-24 bg-white/5 animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const todayCompleted = habits.filter((h) => completionMap.get(`${h.id}|${today}`)).length;
  const streaks = habits.map((h) => ({ habit: h, streak: calculateStreak(h, completionMap) }));
  const longestStreak = streaks.length > 0 ? Math.max(...streaks.map((s) => s.streak)) : 0;
  const bestHabit = streaks.find((s) => s.streak === longestStreak)?.habit;

  // Last 30 days for heatmap
  const heatmapDates = getDatesArray(30);

  // Completion rate (last 7 days)
  const last7 = getDatesArray(7);
  const possibleLast7 = habits.length * 7;
  const completedLast7 = habits.reduce((acc, h) => {
    return acc + last7.filter((d) => completionMap.get(`${h.id}|${d}`)).length;
  }, 0);
  const completionRate = possibleLast7 > 0 ? Math.round((completedLast7 / possibleLast7) * 100) : 0;

  return (
    <>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Habits</h2>
          <p className="text-sm text-text-tertiary mt-0.5">Track daily behaviors and build streaks</p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="px-3 py-1.5 text-[13px] font-medium bg-accent/10 text-accent border border-accent/20 rounded-[6px] hover:bg-accent/20 transition-colors"
        >
          {showAddForm ? "Cancel" : "+ New Habit"}
        </button>
      </div>

      {/* Add Habit Form */}
      {showAddForm && (
        <div className="bg-surface-card border border-border-subtle rounded-[6px] p-5 mb-8 shadow-card">
          <h3 className="text-[13px] font-medium text-text-secondary mb-4">New Habit</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] text-text-tertiary font-medium uppercase tracking-wider block mb-1">Name</label>
              <input
                value={newHabit.name}
                onChange={(e) => setNewHabit({ ...newHabit, name: e.target.value })}
                placeholder="e.g., Meditate 10 min"
                className="w-full bg-white/5 border border-border-subtle rounded-[4px] px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary/50 focus:outline-none focus:border-accent/50"
              />
            </div>
            <div>
              <label className="text-[11px] text-text-tertiary font-medium uppercase tracking-wider block mb-1">Description</label>
              <input
                value={newHabit.description}
                onChange={(e) => setNewHabit({ ...newHabit, description: e.target.value })}
                placeholder="Optional details"
                className="w-full bg-white/5 border border-border-subtle rounded-[4px] px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary/50 focus:outline-none focus:border-accent/50"
              />
            </div>
            <div>
              <label className="text-[11px] text-text-tertiary font-medium uppercase tracking-wider block mb-1">Category</label>
              <select
                value={newHabit.category}
                onChange={(e) => setNewHabit({ ...newHabit, category: e.target.value })}
                className="w-full bg-white/5 border border-border-subtle rounded-[4px] px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent/50"
              >
                {Object.keys(CATEGORY_COLORS).map((c) => (
                  <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-text-tertiary font-medium uppercase tracking-wider block mb-1">Frequency</label>
              <select
                value={newHabit.frequency}
                onChange={(e) => setNewHabit({ ...newHabit, frequency: e.target.value })}
                className="w-full bg-white/5 border border-border-subtle rounded-[4px] px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent/50"
              >
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-text-tertiary font-medium uppercase tracking-wider block mb-1">Icon (emoji)</label>
              <input
                value={newHabit.icon}
                onChange={(e) => setNewHabit({ ...newHabit, icon: e.target.value })}
                placeholder="e.g., 🧘"
                className="w-full bg-white/5 border border-border-subtle rounded-[4px] px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary/50 focus:outline-none focus:border-accent/50"
              />
            </div>
            <div>
              <label className="text-[11px] text-text-tertiary font-medium uppercase tracking-wider block mb-1">Color</label>
              <div className="flex gap-2 mt-1">
                {DEFAULT_HABIT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewHabit({ ...newHabit, color: c })}
                    className="w-7 h-7 rounded-full transition-transform"
                    style={{
                      backgroundColor: c,
                      transform: newHabit.color === c ? "scale(1.2)" : "scale(1)",
                      outline: newHabit.color === c ? "2px solid white" : "none",
                      outlineOffset: "2px",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={newHabit.createReminder}
                onChange={(e) => setNewHabit({ ...newHabit, createReminder: e.target.checked })}
                className="rounded accent-accent"
              />
              Create Notion reminder
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={createHabit}
              disabled={!newHabit.name.trim() || saving}
              className="px-4 py-2 text-[13px] font-medium bg-accent text-white rounded-[6px] hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "Creating..." : "Create Habit"}
            </button>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Today" value={`${todayCompleted}/${habits.length}`} sublabel="habits completed" />
        <StatCard label="7-Day Rate" value={`${completionRate}%`} sublabel={`${completedLast7} of ${possibleLast7} check-ins`} />
        <StatCard label="Longest Streak" value={longestStreak} unit="days" sublabel={bestHabit?.name} />
        <StatCard label="Active Habits" value={habits.length} />
      </div>

      {/* Today's Checklist */}
      {habits.length > 0 && (
        <ChartCard title="Today's Habits" subtitle={new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}>
          <div className="space-y-1">
            {habits.map((h) => {
              const done = completionMap.get(`${h.id}|${today}`);
              const isToggling = toggling.has(h.id);
              const streak = calculateStreak(h, completionMap);

              return (
                <button
                  key={h.id}
                  onClick={() => toggleCompletion(h.id)}
                  disabled={isToggling}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-[4px] transition-all text-left group ${
                    done
                      ? "bg-white/[0.03]"
                      : "hover:bg-white/[0.03]"
                  } ${isToggling ? "opacity-50" : ""}`}
                >
                  {/* Checkbox */}
                  <div
                    className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all shrink-0 ${
                      done ? "border-transparent" : "border-white/20 group-hover:border-white/40"
                    }`}
                    style={done ? { backgroundColor: h.color } : {}}
                  >
                    {done && (
                      <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>

                  {/* Icon + Name */}
                  <span className="text-lg leading-none">{h.icon || ""}</span>
                  <div className="flex-1 min-w-0">
                    <span className={`text-sm font-medium transition-colors ${done ? "text-text-tertiary line-through" : "text-text-primary"}`}>
                      {h.name}
                    </span>
                    {h.description && (
                      <p className="text-[11px] text-text-tertiary truncate mt-0.5">{h.description}</p>
                    )}
                  </div>

                  {/* Streak badge */}
                  {streak > 0 && (
                    <span
                      className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: `${h.color}20`, color: h.color }}
                    >
                      {streak}d streak
                    </span>
                  )}

                  {/* Category pill */}
                  <span className="text-[10px] font-mono text-text-tertiary/60 uppercase tracking-wider hidden sm:inline">
                    {h.category}
                  </span>
                </button>
              );
            })}
          </div>
        </ChartCard>
      )}

      {/* Heatmap */}
      {habits.length > 0 && (
        <ChartCard title="30-Day Heatmap" className="mt-6">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal pr-3 py-1 sticky left-0 bg-surface-card min-w-[140px]">
                    Habit
                  </th>
                  {heatmapDates.map((d) => (
                    <th
                      key={d}
                      className="text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal px-0.5 py-1 min-w-[24px]"
                    >
                      <span className="block rotate-[-45deg] origin-bottom-left translate-x-2 whitespace-nowrap">
                        {formatDate(d)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {habits.map((h) => (
                  <tr key={h.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="text-text-secondary pr-3 py-1 sticky left-0 bg-surface-card truncate max-w-[160px]" title={h.name}>
                      <span className="mr-1.5">{h.icon || ""}</span>
                      {h.name}
                    </td>
                    {heatmapDates.map((d) => {
                      const done = completionMap.get(`${h.id}|${d}`);
                      return (
                        <td key={d} className="px-0.5 py-1 text-center">
                          <div
                            className="w-5 h-5 rounded-sm mx-auto transition-colors"
                            style={{
                              backgroundColor: done ? `${h.color}cc` : "rgba(255,255,255,0.03)",
                            }}
                            title={`${h.name}: ${d} — ${done ? "Done" : "Missed"}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      )}

      {/* Streaks */}
      {habits.length > 0 && (
        <ChartCard title="Current Streaks" className="mt-6">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {streaks
              .sort((a, b) => b.streak - a.streak)
              .map(({ habit, streak }) => (
                <div
                  key={habit.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-[4px] bg-white/[0.02]"
                >
                  <span className="text-xl">{habit.icon || "+"}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary font-medium truncate">{habit.name}</p>
                    <p className="text-[11px] font-mono" style={{ color: habit.color }}>
                      {streak > 0 ? `${streak} day${streak !== 1 ? "s" : ""}` : "No streak"}
                    </p>
                  </div>
                  {/* Mini bar */}
                  <div className="w-12 h-2 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.min(100, (streak / 30) * 100)}%`,
                        backgroundColor: habit.color,
                      }}
                    />
                  </div>
                </div>
              ))}
          </div>
        </ChartCard>
      )}

      {/* Empty state */}
      {habits.length === 0 && !showAddForm && (
        <div className="text-center py-20">
          <p className="text-4xl mb-4">+</p>
          <p className="text-text-secondary text-sm">No habits yet. Click &quot;+ New Habit&quot; to get started.</p>
        </div>
      )}
    </>
  );
}
