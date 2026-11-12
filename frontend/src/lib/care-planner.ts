export type CareItem = { id: string; title: string; due: string; months: number; booked: boolean; archived: boolean };
export const STORAGE_KEY = 'onyx-care-planner-v1';
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function nextDue(date: string, months: number): string {
  if (!validDate(date) || !Number.isInteger(months) || months < 1 || months > 120) throw new Error('Invalid recurrence');
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1 + months, 1, 12));
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result.toISOString().slice(0, 10);
}
export function parseItems(raw: string): CareItem[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 500) throw new Error('Invalid saved planner');
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100 || typeof item.due !== 'string' || !validDate(item.due) || !Number.isInteger(item.months) || ![0, 1, 3, 6, 12, 24].includes(item.months) || typeof item.booked !== 'boolean' || typeof item.archived !== 'boolean') throw new Error('Invalid saved planner');
    ids.add(item.id);
    return { id: item.id, title: item.title, due: item.due, months: item.months, booked: item.booked, archived: item.archived };
  });
}

// ---- Calendar / agenda / due-soon helpers (pure, no I/O) -------------------

export function addDays(date: string, days: number): string {
  if (!validDate(date) || !Number.isInteger(days)) throw new Error('Invalid date');
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const result = d.toISOString().slice(0, 10);
  if (!validDate(result)) throw new Error('Date out of range');
  return result;
}

export function daysBetween(from: string, to: string): number {
  if (!validDate(from) || !validDate(to)) throw new Error('Invalid date');
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

export type CareStatus = 'overdue' | 'confirm-past' | 'needs-booking' | 'booked';

// What a stored item means today. "booked" only ever records the user's own
// confirmation; nothing here talks to a provider or a calendar.
export function careStatus(item: Pick<CareItem, 'due' | 'booked'>, today: string): CareStatus {
  if (item.booked) return item.due < today ? 'confirm-past' : 'booked';
  return item.due < today ? 'overdue' : 'needs-booking';
}

export type DueSoonEntry = { item: CareItem; status: CareStatus; daysAway: number };

// Everything overdue or due within `windowDays` (inclusive), soonest first.
export function dueSoon(items: CareItem[], today: string, windowDays = 30): DueSoonEntry[] {
  const last = addDays(today, windowDays);
  return items
    .filter(item => !item.archived && item.due <= last)
    .map(item => ({ item, status: careStatus(item, today), daysAway: daysBetween(today, item.due) }))
    .sort((a, b) => a.item.due.localeCompare(b.item.due) || a.item.id.localeCompare(b.item.id));
}

export type MonthCell = { date: string; inMonth: boolean };

// Sunday-first weeks covering the month. `month` is 0-11 like Date.
export function monthGrid(year: number, month: number): MonthCell[][] {
  if (!Number.isInteger(year) || year < 1900 || year > 9998 || !Number.isInteger(month) || month < 0 || month > 11) throw new Error('Invalid month');
  const first = `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`;
  const offset = new Date(`${first}T12:00:00Z`).getUTCDay();
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const rows = Math.ceil((offset + length) / 7);
  return Array.from({ length: rows }, (_, row) => Array.from({ length: 7 }, (_, col) => {
    const index = row * 7 + col - offset;
    return { date: addDays(first, index), inMonth: index >= 0 && index < length };
  }));
}

export function monthBounds(year: number, month: number): { start: string; end: string } {
  const grid = monthGrid(year, month);
  const cells = grid.flat().filter(cell => cell.inMonth);
  return { start: cells[0].date, end: cells[cells.length - 1].date };
}

export type CalendarEntry = {
  key: string;
  itemId: string;
  title: string;
  date: string;
  status: CareStatus | 'projected';
  sample: boolean;
  months: number;
};

// Entries to draw between `start` and `end` (inclusive). Each active item shows
// on its real date. Repeating items also get "projected" dates: where the next
// ones would land if the visit happens on schedule. For an item already past
// due, the projection starts from today, because repeats count from completion.
export function entriesInRange(items: CareItem[], start: string, end: string, today: string): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  for (const item of items) {
    if (item.archived) continue;
    const sample = isSampleItem(item);
    if (item.due >= start && item.due <= end) {
      out.push({ key: item.id, itemId: item.id, title: item.title, date: item.due, status: careStatus(item, today), sample, months: item.months });
    }
    if (item.months > 0) {
      const base = item.due >= today ? item.due : today;
      for (let k = 1; item.months * k <= 120; k++) {
        const date = nextDue(base, item.months * k);
        if (date > end) break;
        if (date >= start) out.push({ key: `${item.id}:projected:${k}`, itemId: item.id, title: item.title, date, status: 'projected', sample, months: item.months });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
}

// ---- Synthetic sample data (display only, never stored or sent) -------------

export const SAMPLE_PREFIX = 'sample-';
export const isSampleItem = (item: Pick<CareItem, 'id'>): boolean => item.id.startsWith(SAMPLE_PREFIX);

// Invented labels with dates relative to `today`, so the demo always shows an
// overdue item, items due soon, and booked ones. Not anyone's real care.
export function sampleItems(today: string): CareItem[] {
  const at = (days: number) => addDays(today, days);
  return [
    { id: `${SAMPLE_PREFIX}1`, title: 'Sample: annual checkup', due: at(-12), months: 12, booked: false, archived: false },
    { id: `${SAMPLE_PREFIX}2`, title: 'Sample: dental cleaning', due: at(9), months: 6, booked: true, archived: false },
    { id: `${SAMPLE_PREFIX}3`, title: 'Sample: eye exam', due: at(20), months: 24, booked: false, archived: false },
    { id: `${SAMPLE_PREFIX}4`, title: 'Sample: flu shot', due: at(45), months: 12, booked: true, archived: false },
    { id: `${SAMPLE_PREFIX}5`, title: 'Sample: skin check', due: at(6), months: 12, booked: false, archived: false },
  ];
}

// ---- Calendar connection (nothing is connected in this release) -------------

export type CalendarPermission = { id: 'read-calendars' | 'write-events'; label: string; granted: boolean };
export type CalendarConnection = {
  provider: string;
  status: 'disconnected';
  statusLabel: string;
  permissions: CalendarPermission[];
  canConnect: boolean;
};

// Static on purpose: no sign-in, token or calendar read/write exists. Both
// permissions are listed as not granted so the page can say exactly what a
// future connection would ask for, and nothing here claims otherwise.
export const CALENDAR_CONNECTION: CalendarConnection = {
  provider: 'Google Calendar',
  status: 'disconnected',
  statusLabel: 'Not connected',
  permissions: [
    { id: 'read-calendars', label: 'Read your calendars (to avoid double-booking)', granted: false },
    { id: 'write-events', label: 'Create and update events on one calendar you choose', granted: false },
  ],
  canConnect: false,
};
