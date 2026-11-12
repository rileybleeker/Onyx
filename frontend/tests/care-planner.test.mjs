import assert from 'node:assert/strict';
import {
  nextDue, validDate, todayLocal, parseItems, addDays, daysBetween, careStatus, dueSoon, monthGrid, monthBounds,
  entriesInRange, sampleItems, isSampleItem, CALENDAR_CONNECTION,
} from '../src/lib/care-planner.ts';
assert.equal(nextDue('2024-01-31', 1), '2024-02-29');
assert.equal(nextDue('2023-01-31', 1), '2023-02-28');
assert.equal(nextDue('2024-02-29', 12), '2025-02-28');
assert.equal(nextDue('2026-11-11', 3), '2027-02-11');
assert.equal(validDate('2026-02-30'), false);
assert.equal(validDate('2026-2-03'), false);
assert.throws(() => nextDue('bad', 3));
assert.throws(() => nextDue('2026-01-01', -1));
assert.equal(todayLocal(new Date(2026, 10, 11, 23, 59)), '2026-11-11');
const item = { id: 'fixture', title: 'Routine care', due: '2026-11-11', months: 12, booked: false, archived: false };
assert.deepEqual(parseItems(JSON.stringify([item])), [item]);
assert.throws(() => parseItems(JSON.stringify([item, item])));
assert.throws(() => parseItems(JSON.stringify([{...item, due: '2026-02-30'}])));
assert.throws(() => parseItems('{}'));
assert.throws(() => parseItems(JSON.stringify([{...item, months: 7}])));

// ---- date arithmetic ----
assert.equal(addDays('2026-11-30', 1), '2026-12-01');
assert.equal(addDays('2024-03-01', -1), '2024-02-29');
assert.equal(daysBetween('2026-11-11', '2026-12-11'), 30);
assert.equal(daysBetween('2026-11-11', '2026-11-01'), -10);
assert.equal(daysBetween('2026-03-08', '2026-03-09'), 1); // US DST change day
assert.throws(() => addDays('2026-02-30', 1));

// ---- status ----
const today = '2026-11-11';
assert.equal(careStatus({ due: '2026-11-10', booked: false }, today), 'overdue');
assert.equal(careStatus({ due: '2026-11-10', booked: true }, today), 'confirm-past');
assert.equal(careStatus({ due: '2026-11-11', booked: false }, today), 'needs-booking');
assert.equal(careStatus({ due: '2026-11-12', booked: true }, today), 'booked');

// ---- due soon ----
const mk = (id, due, extra = {}) => ({ id, title: id, due, months: 0, booked: false, archived: false, ...extra });
const soon = dueSoon([
  mk('far', '2027-03-01'), mk('edge', '2026-12-11'), mk('past', '2026-10-01'), mk('gone', '2026-11-15', { archived: true }),
  mk('booked', '2026-11-20', { booked: true }),
], today, 30);
assert.deepEqual(soon.map(e => e.item.id), ['past', 'booked', 'edge']);
assert.deepEqual(soon.map(e => e.status), ['overdue', 'booked', 'needs-booking']);
assert.equal(soon[0].daysAway, -41);
assert.equal(dueSoon([mk('x', '2026-12-12')], today, 30).length, 0); // day 31 is outside the window
assert.equal(dueSoon([], today).length, 0);

// ---- month grid ----
const nov = monthGrid(2026, 10); // Nov 2026 starts on a Sunday
assert.equal(nov.length, 5);
assert.ok(nov.every(week => week.length === 7));
assert.equal(nov[0][0].date, '2026-11-01');
assert.equal(nov[0][0].inMonth, true);
assert.equal(nov[4][6].date, '2026-12-05');
assert.equal(nov[4][6].inMonth, false);
const feb = monthGrid(2026, 1); // Feb 2026: Sunday start, 28 days -> exactly 4 rows
assert.equal(feb.length, 4);
const may = monthGrid(2026, 4); // May 2026 starts on a Friday and has 31 days -> 6 rows
assert.equal(may.length, 6);
assert.equal(may[0][0].date, '2026-04-26');
assert.equal(may[0][0].inMonth, false);
assert.equal(may[0][5].date, '2026-05-01');
assert.deepEqual(monthBounds(2024, 1), { start: '2024-02-01', end: '2024-02-29' });
assert.throws(() => monthGrid(2026, 12));
assert.throws(() => monthGrid(1899, 0));

// ---- calendar entries ----
const items = [
  mk('once', '2026-11-20'),
  mk('yearly', '2026-11-25', { months: 12, booked: true }),
  mk('overdue-repeat', '2026-09-01', { months: 3 }),
  mk('archived', '2026-11-22', { archived: true, months: 1 }),
];
const novEntries = entriesInRange(items, '2026-11-01', '2026-11-30', today);
assert.deepEqual(novEntries.map(e => e.itemId), ['once', 'yearly']); // overdue item is in September, outside this window
const sepEntries = entriesInRange(items, '2026-09-01', '2026-09-30', today);
assert.deepEqual(sepEntries.map(e => [e.itemId, e.status]), [['overdue-repeat', 'overdue']]);
// Repeats from an overdue item count from today (completion), not from the missed date.
const feb27 = entriesInRange(items, '2027-02-01', '2027-02-28', today);
assert.deepEqual(feb27.map(e => [e.itemId, e.status, e.date]), [['overdue-repeat', 'projected', '2027-02-11']]);
// Repeats from an on-time item count from its due date, for every multiple of the interval.
const next = entriesInRange(items, '2027-11-01', '2027-11-30', today);
assert.ok(next.some(e => e.itemId === 'yearly' && e.status === 'projected' && e.date === '2027-11-25'));
assert.ok(next.every(e => e.itemId !== 'archived' && e.itemId !== 'once'));
assert.ok(entriesInRange(items, '2030-11-01', '2030-11-30', today).some(e => e.itemId === 'yearly' && e.date === '2030-11-25'));
// Month-end projections are computed from the original date, so they do not drift.
const monthly = [mk('m', '2026-12-31', { months: 1 })];
assert.equal(entriesInRange(monthly, '2027-02-01', '2027-02-28', today)[0].date, '2027-02-28');
assert.equal(entriesInRange(monthly, '2027-03-01', '2027-03-31', today)[0].date, '2027-03-31');
// Projection stops at the 10-year cap.
assert.equal(entriesInRange([mk('c', '2026-11-11', { months: 12 })], '2037-01-01', '2040-12-31', today).length, 0);
assert.equal(entriesInRange([], '2026-11-01', '2026-11-30', today).length, 0);

// ---- sample data ----
const samples = sampleItems(today);
assert.ok(samples.length >= 4);
assert.ok(samples.every(isSampleItem));
assert.ok(samples.every(s => s.title.startsWith('Sample:') && validDate(s.due)));
assert.ok(samples.some(s => careStatus(s, today) === 'overdue'));
assert.ok(samples.some(s => careStatus(s, today) === 'booked'));
assert.ok(samples.some(s => careStatus(s, today) === 'needs-booking'));
assert.ok(!isSampleItem(item));
assert.deepEqual(sampleItems(today), sampleItems(today)); // deterministic
assert.ok(parseItems(JSON.stringify(samples)).length === samples.length); // valid shape, but never written by the UI
assert.ok(dueSoon(samples, today).length >= 3);

// ---- calendar connection is explicitly disconnected, nothing granted ----
assert.equal(CALENDAR_CONNECTION.status, 'disconnected');
assert.equal(CALENDAR_CONNECTION.canConnect, false);
assert.ok(CALENDAR_CONNECTION.permissions.length > 0);
assert.ok(CALENDAR_CONNECTION.permissions.every(p => p.granted === false));

console.log('Care planner date, storage, calendar and sample-data tests passed');
