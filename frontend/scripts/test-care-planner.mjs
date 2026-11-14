import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
// Load the real helper module (no I/O, no imports) the same way the other offline tests do,
// so it works on any Node version CI uses.
const source = fs.readFileSync(new URL('../src/lib/care-planner.ts', import.meta.url), 'utf8');
const planner = { exports: {} };
// Same realm (not vm.runInNewContext) so deepStrictEqual compares plain objects and arrays.
new Function('exports', 'module', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)(planner.exports, planner);
const {
  nextDue, validDate, todayLocal, parseItems, addDays, daysBetween, careStatus, dueSoon, monthGrid, monthBounds,
  entriesInRange, sampleItems, isSampleItem, CALENDAR_CONNECTION,
  validTime, validTimeZone, tzOffsetMinutes, zonedInstant, zonedParts, todayIn, addMinutesWall, itemInZone, formatTime,
  compareSchedule, completionChange, upgradeLocalItem, localCopyState, CARE_KINDS, DEFAULT_TZ,
} = planner.exports;
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

// ---- wall-clock times and time zones (synthetic items only) ----
const NY = 'America/New_York', MADRID = 'Europe/Madrid', LA = 'America/Los_Angeles';
const iso = ms => new Date(ms).toISOString();
assert.equal(DEFAULT_TZ, NY);
assert.ok(validTime('00:00') && validTime('23:59') && validTime('09:05'));
assert.ok(!validTime('24:00') && !validTime('9:05') && !validTime('09:60') && !validTime('') && !validTime(null) && !validTime('09:05:00'));
assert.ok(validTimeZone(NY) && validTimeZone('UTC') && validTimeZone('America/Argentina/Buenos_Aires'));
assert.ok(!validTimeZone('Mars/Olympus') && !validTimeZone('') && !validTimeZone('New York') && !validTimeZone(5) && !validTimeZone('America/New_York; x') && !validTimeZone('a'.repeat(65)));
assert.equal(tzOffsetMinutes(Date.parse('2026-01-15T12:00:00Z'), NY), -300);
assert.equal(tzOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'), NY), -240);
assert.equal(tzOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'), MADRID), 120);
assert.equal(tzOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'), 'UTC'), 0);
assert.equal(iso(zonedInstant('2026-01-15', '09:00', NY)), '2026-01-15T14:00:00.000Z');
assert.equal(iso(zonedInstant('2026-07-15', '09:00', NY)), '2026-07-15T13:00:00.000Z');
assert.equal(iso(zonedInstant('2026-07-15', '00:00', MADRID)), '2026-07-14T22:00:00.000Z');
assert.deepEqual(zonedParts(Date.parse('2026-07-14T22:00:00Z'), MADRID), { date: '2026-07-15', time: '00:00' }); // midnight is 00:00, never 24:00
assert.throws(() => zonedInstant('2026-02-30', '09:00', NY));
assert.throws(() => zonedInstant('2026-01-15', '9am', NY));
assert.throws(() => zonedInstant('2026-01-15', '09:00', 'Nowhere/Land'));

// DST change, spring forward (US clocks jump 02:00 -> 03:00 on 2026-03-08): 02:30 does not exist,
// so it lands the same distance after the jump, at 03:30 local.
assert.equal(iso(zonedInstant('2026-03-08', '01:59', NY)), '2026-03-08T06:59:00.000Z');
assert.equal(iso(zonedInstant('2026-03-08', '02:30', NY)), '2026-03-08T07:30:00.000Z');
assert.deepEqual(zonedParts(zonedInstant('2026-03-08', '02:30', NY), NY), { date: '2026-03-08', time: '03:30' });
assert.equal(iso(zonedInstant('2026-03-08', '03:00', NY)), '2026-03-08T07:00:00.000Z');
// DST change, fall back (02:00 -> 01:00 on 2026-11-01): 01:30 happens twice; the first one is used.
assert.equal(iso(zonedInstant('2026-11-01', '01:30', NY)), '2026-11-01T05:30:00.000Z');
assert.equal(iso(zonedInstant('2026-11-01', '02:00', NY)), '2026-11-01T07:00:00.000Z');
assert.equal(iso(zonedInstant('2026-11-01', '00:59', NY)), '2026-11-01T04:59:00.000Z');
// Europe changes on other dates (2026-03-29 and 2026-10-25), so the gap between zones moves too.
assert.equal(iso(zonedInstant('2026-03-29', '02:30', MADRID)), '2026-03-29T01:30:00.000Z');
assert.equal(iso(zonedInstant('2026-10-25', '02:30', MADRID)), '2026-10-25T00:30:00.000Z');
// A repeating 09:00 appointment keeps its clock time across the change; only the instant moves.
const timed = { due: '2026-10-31', time: '09:00', tz: NY };
const repeated = { ...timed, due: nextDue(timed.due, 1) };
assert.equal(repeated.due, '2026-11-30'); // month-end clamp
assert.equal(iso(zonedInstant(timed.due, timed.time, timed.tz)), '2026-10-31T13:00:00.000Z');    // EDT
assert.equal(iso(zonedInstant(repeated.due, repeated.time, repeated.tz)), '2026-11-30T14:00:00.000Z'); // EST
assert.deepEqual(itemInZone(repeated, NY), { date: '2026-11-30', time: '09:00' });
assert.deepEqual(itemInZone(timed, MADRID), { date: '2026-10-31', time: '14:00' });   // Madrid already on winter time: 5 h apart
assert.deepEqual(itemInZone(repeated, MADRID), { date: '2026-11-30', time: '15:00' }); // both on winter time: 6 h apart
assert.equal(daysBetween('2026-10-31', '2026-11-01'), 1); // a 25-hour local day is still one day
assert.equal(addDays('2026-03-07', 1), '2026-03-08');

// Month-end repeats: clamp to the last day, and count from the original date so they do not drift.
assert.equal(nextDue('2026-01-31', 1), '2026-02-28');
assert.equal(nextDue('2026-08-31', 1), '2026-09-30');
assert.equal(nextDue('2026-08-31', 6), '2027-02-28');
assert.equal(nextDue('2027-08-31', 6), '2028-02-29'); // leap year
assert.equal(nextDue('2026-12-31', 24), '2028-12-31');
assert.equal(nextDue('2026-10-31', 3), '2027-01-31');
const monthEnd = [{ ...mk('me', '2026-08-31', { months: 1 }), time: '08:15', tz: NY }];
const projectedYear = entriesInRange(monthEnd, '2026-09-01', '2027-03-31', '2026-08-01').filter(e => e.status === 'projected');
assert.deepEqual(projectedYear.map(e => e.date), ['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31']);
assert.ok(projectedYear.every(e => e.time === '08:15')); // projections keep the time of day
assert.deepEqual(completionChange({ months: 1 }, '2026-01-31'), { due: '2026-02-28', booked: false, completedOn: '2026-01-31' });
assert.deepEqual(completionChange({ months: 12 }, '2024-02-29'), { due: '2025-02-28', booked: false, completedOn: '2024-02-29' });
assert.deepEqual(completionChange({ months: 0 }, '2026-01-31'), { archived: true, completedOn: '2026-01-31' });

// An item moved across midnight: by clock arithmetic, and by looking at it from another zone.
assert.deepEqual(addMinutesWall('2026-11-20', '23:30', 60), { date: '2026-11-21', time: '00:30' });
assert.deepEqual(addMinutesWall('2026-03-01', '00:15', -30), { date: '2026-02-28', time: '23:45' });
assert.deepEqual(addMinutesWall('2026-12-31', '23:59', 1), { date: '2027-01-01', time: '00:00' });
assert.deepEqual(addMinutesWall('2026-11-20', '10:00', 0), { date: '2026-11-20', time: '10:00' });
assert.deepEqual(addMinutesWall('2026-11-20', '10:00', 2880), { date: '2026-11-22', time: '10:00' });
assert.throws(() => addMinutesWall('2026-11-20', '10:00', 1.5));
const late = { due: '2026-11-20', time: '23:30', tz: NY };
assert.deepEqual(itemInZone(late, MADRID), { date: '2026-11-21', time: '05:30' }); // next day in Madrid
assert.deepEqual(itemInZone(late, LA), { date: '2026-11-20', time: '20:30' });     // same day in Los Angeles
assert.deepEqual(itemInZone(late, NY), { date: '2026-11-20', time: '23:30' });
assert.equal(itemInZone({ due: '2026-11-20', time: null, tz: NY }, MADRID), null); // no time: same calendar day everywhere
const early = { due: '2026-11-21', time: '00:30', tz: MADRID };
assert.deepEqual(itemInZone(early, NY), { date: '2026-11-20', time: '18:30' });   // previous day in New York
// Which day is "today" depends on the zone: at 03:30 UTC it is still the 20th in New York and already the 21st in Madrid.
const instant = new Date('2026-11-21T03:30:00Z');
assert.equal(todayIn(NY, instant), '2026-11-20');
assert.equal(todayIn(MADRID, instant), '2026-11-21');
assert.equal(careStatus({ due: '2026-11-20', booked: false }, todayIn(NY, instant)), 'needs-booking');
assert.equal(careStatus({ due: '2026-11-20', booked: false }, todayIn(MADRID, instant)), 'overdue');
// Moving an item past midnight by editing its time changes its day in the lists.
const movedItem = { ...mk('mv', '2026-11-20'), time: '23:30', tz: NY };
const shifted = addMinutesWall(movedItem.due, movedItem.time, 45);
const afterMove = { ...movedItem, due: shifted.date, time: shifted.time };
assert.equal(afterMove.due, '2026-11-21');
assert.equal(afterMove.time, '00:15');
assert.equal(entriesInRange([afterMove], '2026-11-20', '2026-11-20', today).length, 0);
assert.deepEqual(entriesInRange([afterMove], '2026-11-21', '2026-11-21', today).map(e => [e.date, e.time]), [['2026-11-21', '00:15']]);

// ---- ordering and display ----
assert.equal(formatTime('00:05'), '12:05 AM');
assert.equal(formatTime('09:30'), '9:30 AM');
assert.equal(formatTime('12:00'), '12:00 PM');
assert.equal(formatTime('23:59'), '11:59 PM');
const sameDay = [
  { ...mk('c', '2026-11-20'), time: '14:00' }, { ...mk('a', '2026-11-20'), time: null }, { ...mk('b', '2026-11-20'), time: '09:00' }, { ...mk('z', '2026-11-19'), time: '23:00' },
];
assert.deepEqual([...sameDay].sort(compareSchedule).map(i => i.id), ['z', 'a', 'b', 'c']); // earlier day, then no time, then by clock
assert.deepEqual(entriesInRange(sameDay, '2026-11-20', '2026-11-20', today).map(e => e.itemId), ['a', 'b', 'c']);
assert.deepEqual(dueSoon(sameDay, today).map(e => e.item.id), ['z', 'a', 'b', 'c']);

// ---- the old browser-only planner: one-time copy ----
const savedLocal = JSON.stringify([item, { ...item, id: 'fixture-2', title: 'Second routine item' }]);
assert.deepEqual(localCopyState(null, null), { state: 'none' });
assert.deepEqual(localCopyState('', null), { state: 'none' });
assert.deepEqual(localCopyState('[]', null), { state: 'none' });
assert.equal(localCopyState(savedLocal, null).state, 'offer');
assert.equal(localCopyState(savedLocal, null).items.length, 2);
assert.deepEqual(localCopyState(savedLocal, '2026-11-13T00:00:00.000Z'), { state: 'copied', count: 2 }); // copied once: no more offer
assert.deepEqual(localCopyState('{not json', null), { state: 'unreadable' });
assert.deepEqual(localCopyState(JSON.stringify([{ ...item, months: 7 }]), null), { state: 'unreadable' });
assert.deepEqual(localCopyState(JSON.stringify(samples), null), { state: 'none' }); // sample data is never offered for upload
assert.deepEqual(upgradeLocalItem(item, MADRID), { ...item, kind: 'other', time: null, tz: MADRID, notes: '', completedOn: null });
assert.equal(upgradeLocalItem(item, 'Nowhere/Land').tz, NY);
assert.ok(samples.every(s => CARE_KINDS.includes(s.kind) && s.tz === NY && (s.time === null || validTime(s.time))));

console.log('Care planner date, time-zone, storage, calendar and sample-data tests passed');
