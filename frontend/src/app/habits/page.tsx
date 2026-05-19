"use client";

import { useEffect, useState, useCallback } from "react";
import { getHabitJournal, rangeDays, rangeLabel, type Range } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";

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

interface NotionHabit {
  id: string;
  name: string;
  category: string;
  frequency: string;
  active: boolean;
  lastCompleted: string | null;
}

interface JournalEntry {
  cycle_date: string;
  question: string;
  category: string | null;
  answer: string | null;
}

function todayStr() {
  return new Date().toLocaleDateString("en-CA");
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

function calculateStreak(habitName: string, frequency: string, completionSet: Set<string>): number {
  let streak = 0;
  const now = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString("en-CA");

    if (frequency === "weekdays") {
      const day = d.getDay();
      if (day === 0 || day === 6) continue;
    }

    if (completionSet.has(`${habitName}|${dateStr}`)) {
      streak++;
    } else {
      if (i === 0) continue; // Allow today to be incomplete
      break;
    }
  }
  return streak;
}

export default function HabitsPage() {
  const [habits, setHabits] = useState<NotionHabit[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<Range>("30d");

  const load = useCallback(async (days: number) => {
    setLoading(true);
    try {
      const [habitsRes, journalData] = await Promise.all([
        fetch("/api/habits/list").then((r) => r.json()),
        getHabitJournal(days),
      ]);
      setHabits(habitsRes.habits || []);
      setJournal(journalData);

      // Sync completions from Notion (Last Completed dates)
      setSyncing(true);
      const syncRes = await fetch("/api/habits/sync", { method: "POST" });
      if (syncRes.ok) {
        const { count } = await syncRes.json();
        if (count > 0) {
          // Reload journal data to pick up synced entries
          const updated = await getHabitJournal(days);
          setJournal(updated);
        }
      }
      setSyncing(false);
    } catch (e) {
      console.error(e);
      setSyncing(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(rangeDays(range)); }, [load, range]);

  // Build a set of "habitName|date" for completed entries
  const completionSet = new Set<string>();
  journal.forEach((j) => {
    if (j.answer?.toLowerCase() === "yes") {
      completionSet.add(`${j.question}|${j.cycle_date}`);
    }
  });

  const today = todayStr();

  async function toggleCompletion(habit: NotionHabit) {
    const key = `${habit.name}|${today}`;
    const isCompleted = completionSet.has(key);
    setToggling((prev) => new Set(prev).add(habit.name));

    try {
      const res = await fetch("/api/habits/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          habit: habit.name,
          date: today,
          category: habit.category,
          notionPageId: habit.id,
          undo: isCompleted,
        }),
      });

      if (res.ok) {
        if (isCompleted) {
          setJournal((prev) =>
            prev.filter((j) => !(j.question === habit.name && j.cycle_date === today))
          );
        } else {
          setJournal((prev) => [
            ...prev.filter((j) => !(j.question === habit.name && j.cycle_date === today)),
            { cycle_date: today, question: habit.name, category: habit.category, answer: "Yes" },
          ]);
        }
      }
    } catch (e) {
      console.error("Failed to toggle habit:", e);
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(habit.name);
        return next;
      });
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

  const todayCompleted = habits.filter((h) => completionSet.has(`${h.name}|${today}`)).length;
  const streaks = habits.map((h) => ({
    habit: h,
    streak: calculateStreak(h.name, h.frequency, completionSet),
  }));
  const longestStreak = streaks.length > 0 ? Math.max(...streaks.map((s) => s.streak)) : 0;
  const bestHabit = streaks.find((s) => s.streak === longestStreak)?.habit;

  const heatmapDates = getDatesArray(Math.min(rangeDays(range), 365));

  const last7 = getDatesArray(7);
  const possibleLast7 = habits.length * 7;
  const completedLast7 = habits.reduce((acc, h) => {
    return acc + last7.filter((d) => completionSet.has(`${h.name}|${d}`)).length;
  }, 0);
  const completionRate = possibleLast7 > 0 ? Math.round((completedLast7 / possibleLast7) * 100) : 0;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Habits</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            Track daily behaviors and build streaks — {rangeLabel(range)}
            {syncing && <span className="ml-2 text-accent animate-pulse">syncing from Notion...</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <RangeFilter value={range} onChange={setRange} />
          <a
            href="https://www.notion.so/29cc936fd5e14ae8b10a4fe5c5f7a6cd"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 text-[13px] font-medium bg-white/5 text-text-secondary border border-border-subtle rounded-[6px] hover:bg-white/10 transition-colors"
          >
            Manage in Notion
          </a>
        </div>
      </div>

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
              const done = completionSet.has(`${h.name}|${today}`);
              const isToggling = toggling.has(h.name);
              const streak = calculateStreak(h.name, h.frequency, completionSet);
              const color = CATEGORY_COLORS[h.category] || CATEGORY_COLORS.general;

              return (
                <button
                  key={h.id}
                  onClick={() => toggleCompletion(h)}
                  disabled={isToggling}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-[4px] transition-all text-left group ${
                    done ? "bg-white/[0.03]" : "hover:bg-white/[0.03]"
                  } ${isToggling ? "opacity-50" : ""}`}
                >
                  <div
                    className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all shrink-0 ${
                      done ? "border-transparent" : "border-white/20 group-hover:border-white/40"
                    }`}
                    style={done ? { backgroundColor: color } : {}}
                  >
                    {done && (
                      <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <span className={`text-sm font-medium transition-colors ${done ? "text-text-tertiary line-through" : "text-text-primary"}`}>
                      {h.name}
                    </span>
                  </div>

                  {streak > 0 && (
                    <span
                      className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: `${color}20`, color }}
                    >
                      {streak}d streak
                    </span>
                  )}

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
        <ChartCard title={`Heatmap — ${rangeLabel(range)}`} className="mt-6">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal pr-3 py-1 sticky left-0 bg-surface-card min-w-[140px]">
                    Habit
                  </th>
                  {heatmapDates.map((d) => (
                    <th key={d} className="text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal px-0.5 py-1 min-w-[24px]">
                      <span className="block rotate-[-45deg] origin-bottom-left translate-x-2 whitespace-nowrap">
                        {formatDate(d)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {habits.map((h) => {
                  const color = CATEGORY_COLORS[h.category] || CATEGORY_COLORS.general;
                  return (
                    <tr key={h.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="text-text-secondary pr-3 py-1 sticky left-0 bg-surface-card truncate max-w-[160px]" title={h.name}>
                        {h.name}
                      </td>
                      {heatmapDates.map((d) => {
                        const done = completionSet.has(`${h.name}|${d}`);
                        return (
                          <td key={d} className="px-0.5 py-1 text-center">
                            <div
                              className="w-5 h-5 rounded-sm mx-auto transition-colors"
                              style={{ backgroundColor: done ? `${color}cc` : "rgba(255,255,255,0.03)" }}
                              title={`${h.name}: ${d} — ${done ? "Done" : "Missed"}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
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
              .map(({ habit, streak }) => {
                const color = CATEGORY_COLORS[habit.category] || CATEGORY_COLORS.general;
                return (
                  <div key={habit.id} className="flex items-center gap-3 px-3 py-2.5 rounded-[4px] bg-white/[0.02]">
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary font-medium truncate">{habit.name}</p>
                      <p className="text-[11px] font-mono" style={{ color }}>
                        {streak > 0 ? `${streak} day${streak !== 1 ? "s" : ""}` : "No streak"}
                      </p>
                    </div>
                    <div className="w-12 h-2 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${Math.min(100, (streak / 30) * 100)}%`, backgroundColor: color }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
        </ChartCard>
      )}

      {habits.length === 0 && (
        <div className="text-center py-20">
          <p className="text-text-secondary text-sm mb-3">No active habits found.</p>
          <a
            href="https://www.notion.so/29cc936fd5e14ae8b10a4fe5c5f7a6cd"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent text-sm hover:underline"
          >
            Add habits in Notion
          </a>
        </div>
      )}
    </>
  );
}
