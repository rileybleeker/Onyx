"use client";
import { useMemo, useState } from 'react';
import { type CalendarEntry, type CareItem, type CareStatus, dueSoon, entriesInRange, formatTime, monthBounds, monthGrid } from '@/lib/care-planner';

const panel = 'rounded-2xl border border-border-default bg-surface-card p-5';
const button = 'rounded-lg border border-border-default px-3 py-2 text-sm hover:bg-surface-hover disabled:opacity-50';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const STATUS_LABEL: Record<CareStatus | 'projected', string> = {
  overdue: 'Overdue, needs booking',
  'confirm-past': 'Past appointment, confirm completion',
  'needs-booking': 'Due, needs booking',
  booked: 'Booked by you',
  projected: 'Projected if completed on schedule',
};
const STATUS_TONE: Record<CareStatus | 'projected', string> = {
  overdue: 'text-down',
  'confirm-past': 'text-mid',
  'needs-booking': 'text-mid',
  booked: 'text-up',
  projected: 'text-text-tertiary',
};

function relative(daysAway: number): string {
  if (daysAway === 0) return 'today';
  const n = Math.abs(daysAway);
  const unit = `${n} day${n === 1 ? '' : 's'}`;
  return daysAway < 0 ? `${unit} ago` : `in ${unit}`;
}

export function DueSoon({ items, today }: { items: CareItem[]; today: string }) {
  const entries = useMemo(() => (today ? dueSoon(items, today, 30) : []), [items, today]);
  return <section className={`${panel} space-y-3`} aria-label="Due soon">
    <h2 className="font-semibold">Due soon</h2>
    <p className="text-xs text-text-secondary">Overdue items and anything due in the next 30 days.</p>
    {entries.length === 0
      ? <p className="text-sm text-text-secondary">Nothing due in the next 30 days.</p>
      : <ul className="space-y-2">{entries.map(({ item, status, daysAway }) => <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-xl border border-border-default px-4 py-3">
        <span className="font-medium break-words">{item.title}</span>
        <span className="text-sm text-text-secondary">{item.due}{item.time ? ` at ${formatTime(item.time)}` : ''} ({relative(daysAway)}) · <span className={STATUS_TONE[status]}>{STATUS_LABEL[status]}</span></span>
      </li>)}</ul>}
  </section>;
}

export function CareCalendar({ items, today }: { items: CareItem[]; today: string }) {
  const [shown, setShown] = useState<{ year: number; month: number } | null>(null);
  const [mode, setMode] = useState<'month' | 'agenda'>('month');
  const year = shown ? shown.year : today ? Number(today.slice(0, 4)) : 0;
  const month = shown ? shown.month : today ? Number(today.slice(5, 7)) - 1 : 0;
  const view = useMemo(() => {
    if (!year) return null;
    const { start, end } = monthBounds(year, month);
    const grid = monthGrid(year, month);
    const byDate = new Map<string, CalendarEntry[]>();
    // The grid also shows a few days of the neighbouring months, so fill those too.
    for (const entry of entriesInRange(items, grid[0][0].date, grid[grid.length - 1][6].date, today)) byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
    const entries = [...byDate.values()].flat().filter(entry => entry.date >= start && entry.date <= end);
    return { grid, byDate, entries };
  }, [items, today, year, month]);
  if (!view) return null;

  const move = (delta: number) => {
    const index = year * 12 + month + delta;
    const nextYear = Math.floor(index / 12);
    if (nextYear < 1900 || nextYear > 9998) return;
    setShown({ year: nextYear, month: index % 12 });
  };
  const label = `${MONTHS[month]} ${year}`;

  return <section className={`${panel} space-y-4`} aria-label="Care calendar">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-semibold" aria-live="polite">{label}</h2>
      <div className="flex flex-wrap gap-2">
        <button className={button} onClick={() => move(-1)} disabled={year === 1900 && month === 0} aria-label="Previous month">Prev</button>
        <button className={button} onClick={() => setShown(null)}>Today</button>
        <button className={button} onClick={() => move(1)} disabled={year === 9998 && month === 11} aria-label="Next month">Next</button>
        <button className={button} aria-pressed={mode === 'month'} onClick={() => setMode('month')}>Month</button>
        <button className={button} aria-pressed={mode === 'agenda'} onClick={() => setMode('agenda')}>Agenda</button>
      </div>
    </div>
    {mode === 'month'
      ? <div className="overflow-x-auto"><table className="w-full table-fixed border-collapse text-xs">
        <caption className="sr-only">{label}: care items by day</caption>
        <thead><tr>{WEEKDAYS.map(day => <th key={day} scope="col" className="p-1 text-left font-medium text-text-secondary">{day}</th>)}</tr></thead>
        <tbody>{view.grid.map((week, row) => <tr key={row}>{week.map(cell => {
          const entries = view.byDate.get(cell.date) ?? [];
          return <td key={cell.date} className={`h-20 border border-border-subtle p-1 align-top ${cell.inMonth ? '' : 'opacity-40'} ${cell.date === today ? 'bg-accent-muted' : ''}`}>
            <div className={cell.date === today ? 'font-semibold text-accent' : 'text-text-secondary'}>{Number(cell.date.slice(8))}{cell.date === today && <span className="sr-only"> (today)</span>}</div>
            <ul className="mt-1 space-y-0.5">{entries.slice(0, 2).map(entry => <li key={entry.key} title={`${entry.title}${entry.time ? `, ${formatTime(entry.time)}` : ''}: ${STATUS_LABEL[entry.status]}`} className={`truncate ${STATUS_TONE[entry.status]} ${entry.status === 'projected' ? 'italic' : ''}`}>{entry.title}<span className="sr-only">: {STATUS_LABEL[entry.status]}</span></li>)}
              {entries.length > 2 && <li className="text-text-tertiary">+{entries.length - 2} more</li>}</ul>
          </td>;
        })}</tr>)}</tbody>
      </table></div>
      : view.entries.length === 0
        ? <p className="text-sm text-text-secondary">Nothing scheduled in {label}.</p>
        : <ul className="space-y-2">{view.entries.map(entry => <li key={entry.key} className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-xl border border-border-default px-4 py-3">
          <span className={`font-medium break-words ${entry.status === 'projected' ? 'italic' : ''}`}>{entry.title}</span>
          <span className="text-sm text-text-secondary">{entry.date}{entry.time ? ` at ${formatTime(entry.time)}` : ''} · <span className={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</span>{entry.months > 0 && entry.status !== 'projected' && ` · Every ${entry.months} month${entry.months === 1 ? '' : 's'} after completion`}</span>
        </li>)}</ul>}
    <p className="text-xs text-text-secondary">Dates come only from what you entered here. Projected dates (italic) assume a repeating item is completed on schedule; repeats count from the day you complete them, so they can move.</p>
  </section>;
}
