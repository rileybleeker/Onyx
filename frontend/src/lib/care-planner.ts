// Care planner logic for /health: dates, repeats, time zones, calendar layout, sample data.
// Pure on purpose (no imports, no I/O, no React) so the browser, the API routes and the offline
// node test (scripts/test-care-planner.mjs) all run the same code.

export const CARE_KINDS = ['medical', 'dental', 'vision', 'wellness', 'personal', 'other'] as const;
export type CareKind = typeof CARE_KINDS[number];
export const KIND_LABEL: Record<CareKind, string> = { medical: 'Medical', dental: 'Dental', vision: 'Vision', wellness: 'Wellness', personal: 'Personal', other: 'Other' };
export const REPEAT_OPTIONS = [0, 1, 3, 6, 12, 24] as const;
export const DEFAULT_TZ = 'America/New_York';

// What the old browser-only planner saved (localStorage). Still parsed for the one-time copy.
export type LocalCareItem = { id: string; title: string; due: string; months: number; booked: boolean; archived: boolean };
// A care item as stored in Onyx. `due` is the calendar day in `tz`; `time` is the wall clock in
// `tz` ("HH:MM") or null for no time; `completedOn` is the day it was last marked complete.
export type CareItem = LocalCareItem & { kind: CareKind; time: string | null; tz: string; notes: string; completedOn: string | null };

export const STORAGE_KEY = 'onyx-care-planner-v1';
// Set (to the copy time) once this browser's saved items were copied into Onyx, so the offer stops.
export const COPIED_KEY = 'onyx-care-planner-v1-copied';

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
export function parseLocalItems(value: unknown): LocalCareItem[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('Invalid saved planner');
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100 || typeof item.due !== 'string' || !validDate(item.due) || !Number.isInteger(item.months) || ![0, 1, 3, 6, 12, 24].includes(item.months) || typeof item.booked !== 'boolean' || typeof item.archived !== 'boolean') throw new Error('Invalid saved planner');
    ids.add(item.id);
    return { id: item.id, title: item.title, due: item.due, months: item.months, booked: item.booked, archived: item.archived };
  });
}
export function parseItems(raw: string): LocalCareItem[] {
  return parseLocalItems(JSON.parse(raw));
}

// A browser-saved item with the fields Onyx adds, at their defaults.
export function upgradeLocalItem(item: LocalCareItem, tz: string = DEFAULT_TZ): CareItem {
  return { ...item, kind: 'other', time: null, tz: validTimeZone(tz) ? tz : DEFAULT_TZ, notes: '', completedOn: null };
}

export type LocalCopyState =
  | { state: 'none' }                                // nothing saved in this browser
  | { state: 'offer'; items: LocalCareItem[] }       // saved items not yet copied into Onyx
  | { state: 'copied'; count: number }               // already copied; the browser copy is still there
  | { state: 'unreadable' };                         // saved data is damaged; left untouched

// What to do about the old browser-only planner. `raw` and `marker` are the two localStorage
// values (STORAGE_KEY, COPIED_KEY). Sample items were never stored, but are filtered anyway.
export function localCopyState(raw: string | null, marker: string | null): LocalCopyState {
  if (!raw) return { state: 'none' };
  let items: LocalCareItem[];
  try { items = parseItems(raw).filter(item => !isSampleItem(item)); } catch { return { state: 'unreadable' }; }
  if (items.length === 0) return { state: 'none' };
  return marker ? { state: 'copied', count: items.length } : { state: 'offer', items };
}

// ---- Wall-clock times and time zones ----------------------------------------
// An item's date and time are the wall clock where the appointment happens (its `tz`). They are
// stored as written, never converted, so a 9:00 appointment stays 9:00 across a DST change.
// The helpers below turn that wall clock into an instant only when one is needed: ordering
// items from different zones, or showing a time in the zone the reader is in.

export function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length < 1 || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function wallParts(utcMs: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

// Minutes east of UTC that `tz` is at the given instant (New York: -300 in winter, -240 in summer).
export function tzOffsetMinutes(utcMs: number, tz: string): number {
  const p = wallParts(utcMs, tz);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(utcMs / 1000) * 1000) / 60000);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// The date and time a clock in `tz` shows at the given instant.
export function zonedParts(utcMs: number, tz: string): { date: string; time: string } {
  const p = wallParts(utcMs, tz);
  return { date: `${String(p.y).padStart(4, '0')}-${pad2(p.mo)}-${pad2(p.d)}`, time: `${pad2(p.h)}:${pad2(p.mi)}` };
}

// The instant (ms since epoch) of a wall-clock date + time in `tz`. Two DST edge cases:
// a time the clocks skip (spring forward, 02:30) resolves to the same distance after the jump
// (03:30); a time that happens twice (fall back, 01:30) resolves to the first, earlier one.
export function zonedInstant(date: string, time: string, tz: string): number {
  if (!validDate(date) || !validTime(time) || !validTimeZone(tz)) throw new Error('Invalid date, time or time zone');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const before = tzOffsetMinutes(wall - 86400000, tz);
  const after = tzOffsetMinutes(wall + 86400000, tz);
  const candidates = [...new Set([before, after])].map(offset => ({ offset, at: wall - offset * 60000 })).filter(c => tzOffsetMinutes(c.at, tz) === c.offset);
  if (candidates.length === 0) return wall - before * 60000; // skipped by a DST jump
  return Math.min(...candidates.map(c => c.at));
}

// Today's calendar day in `tz`.
export function todayIn(tz: string, now: Date = new Date()): string {
  return zonedParts(now.getTime(), tz).date;
}

// A wall-clock date + time moved by whole minutes (pure clock arithmetic, no zone involved):
// 23:30 plus 60 minutes is 00:30 on the next day.
export function addMinutesWall(date: string, time: string, minutes: number): { date: string; time: string } {
  if (!validDate(date) || !validTime(time) || !Number.isInteger(minutes)) throw new Error('Invalid date or time');
  const [h, mi] = time.split(':').map(Number);
  const total = h * 60 + mi + minutes;
  const dayShift = Math.floor(total / 1440);
  const rest = total - dayShift * 1440;
  return { date: addDays(date, dayShift), time: `${pad2(Math.floor(rest / 60))}:${pad2(rest % 60)}` };
}

// Where a timed item lands on a clock in another zone; null for an item with no time (a date
// with no time is the same calendar day everywhere). An 11:30 PM New York appointment is
// 5:30 AM the next day in Madrid.
export function itemInZone(item: Pick<CareItem, 'due' | 'time' | 'tz'>, viewTz: string): { date: string; time: string } | null {
  if (!item.time) return null;
  return zonedParts(zonedInstant(item.due, item.time, item.tz), viewTz);
}

// "9:05 AM" for "09:05".
export function formatTime(time: string): string {
  if (!validTime(time)) return time;
  const [h, mi] = time.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad2(mi)} ${h < 12 ? 'AM' : 'PM'}`;
}

type Scheduled = { due: string; time?: string | null; title: string; id: string };
// Order for a list: by day, then no-time items first, then by clock time, then by label.
export function compareSchedule(a: Scheduled, b: Scheduled): number {
  return a.due.localeCompare(b.due) || (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export type CompletionChange = { completedOn: string; due?: string; booked?: boolean; archived?: boolean };
// What "Mark complete today" changes: a repeating item becomes due again N months after the
// completion day (its time of day is kept) and is no longer booked; a one-off is archived.
export function completionChange(item: Pick<CareItem, 'months'>, today: string): CompletionChange {
  return item.months > 0 ? { due: nextDue(today, item.months), booked: false, completedOn: today } : { archived: true, completedOn: today };
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
    .sort((a, b) => compareSchedule(a.item, b.item));
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
  time: string | null;
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
    const time = item.time ?? null;
    if (item.due >= start && item.due <= end) {
      out.push({ key: item.id, itemId: item.id, title: item.title, date: item.due, time, status: careStatus(item, today), sample, months: item.months });
    }
    if (item.months > 0) {
      const base = item.due >= today ? item.due : today;
      for (let k = 1; item.months * k <= 120; k++) {
        const date = nextDue(base, item.months * k);
        if (date > end) break;
        if (date >= start) out.push({ key: `${item.id}:projected:${k}`, itemId: item.id, title: item.title, date, time, status: 'projected', sample, months: item.months });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
}

// ---- Synthetic sample data (display only, never stored or sent) -------------

export const SAMPLE_PREFIX = 'sample-';
export const isSampleItem = (item: Pick<CareItem, 'id'>): boolean => item.id.startsWith(SAMPLE_PREFIX);

// Invented labels with dates relative to `today`, so the demo always shows an
// overdue item, items due soon, and booked ones. Not anyone's real care.
export function sampleItems(today: string): CareItem[] {
  const mk = (n: number, title: string, kind: CareKind, days: number, months: number, booked: boolean, time: string | null = null): CareItem =>
    ({ id: `${SAMPLE_PREFIX}${n}`, title, kind, due: addDays(today, days), time, tz: DEFAULT_TZ, months, booked, archived: false, notes: '', completedOn: null });
  return [
    mk(1, 'Sample: annual checkup', 'medical', -12, 12, false),
    mk(2, 'Sample: dental cleaning', 'dental', 9, 6, true, '09:30'),
    mk(3, 'Sample: eye exam', 'vision', 20, 24, false),
    mk(4, 'Sample: flu shot', 'medical', 45, 12, true, '14:00'),
    mk(5, 'Sample: skin check', 'medical', 6, 12, false),
  ];
}
