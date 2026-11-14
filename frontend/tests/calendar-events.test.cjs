// Run: node --test tests/calendar-events.test.cjs
// Synced calendar events: row parsing, range rules, day bucketing, ordering, the merge with the
// /health care entries, sync health, and the access rules of the route. SYNTHETIC rows only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const C = loadTs("lib/calendar-events.ts");
const NY = "America/New_York";

function row(over = {}) {
  return {
    event_key: "k1", account: "acct one", calendar: "main", title: "Synthetic meeting",
    start_at: "2030-03-05T15:00:00+00:00", end_at: "2030-03-05T16:00:00+00:00", all_day: false,
    start_date: "2030-03-05", end_date: "2030-03-05", tz: NY, location: null, status: "confirmed", recurring: false,
    ...over,
  };
}
const allDay = (key, start, end, over = {}) => row({ event_key: key, all_day: true, start_at: null, end_at: null, tz: null, start_date: start, end_date: end, title: `Day ${key}`, ...over });
const timed = (key, startIso, endIso, over = {}) => row({ event_key: key, start_at: startIso, end_at: endIso, start_date: startIso.slice(0, 10), end_date: endIso.slice(0, 10), title: `Timed ${key}`, ...over });
const parse = (rows) => rows.map(C.parseEventRow).filter(Boolean);

test("a row parses into an event and bad rows are dropped", () => {
  const e = C.parseEventRow(row({ location: "  Room   4 ", recurring: true }));
  assert.deepEqual(e, {
    key: "k1", title: "Synthetic meeting", allDay: false, startAt: "2030-03-05T15:00:00.000Z", endAt: "2030-03-05T16:00:00.000Z",
    startDate: "2030-03-05", endDate: "2030-03-05", calendar: "main", account: "acct one", location: "Room 4", status: "confirmed", recurring: true,
  });
  for (const bad of [null, "x", {}, row({ event_key: "" }), row({ start_date: "2030-02-30" }), row({ end_date: "2030-03-04" }),
    row({ start_at: null }), row({ start_at: "nope" }), row({ status: "cancelled" }), row({ status: "weird" })]) {
    assert.equal(C.parseEventRow(bad), null);
  }
  const day = C.parseEventRow(allDay("d", "2030-03-05", "2030-03-07"));
  assert.deepEqual([day.allDay, day.startAt, day.endAt], [true, null, null]);
  assert.equal(C.parseEventRow(row({ end_at: "2030-03-05T14:00:00+00:00" })).endAt, "2030-03-05T15:00:00.000Z", "an end before the start is clamped");
  assert.equal(C.parseEventRow(row({ status: "tentative" })).status, "tentative");
  assert.equal(C.eventTitle(C.parseEventRow(row({ title: "" }))), "(No title)");
});

test("the column list has no description, guest or link column", () => {
  assert.equal(C.CALENDAR_EVENT_COLUMNS, "event_key,account,calendar,title,start_at,end_at,all_day,start_date,end_date,tz,location,status,recurring");
});

test("range validation", () => {
  assert.equal(C.validRange("2030-03-01", "2030-03-31"), true);
  assert.equal(C.validRange("2030-03-01", "2030-03-01"), true);
  assert.equal(C.validRange("2030-03-01", "2030-05-02"), true); // 62 days
  assert.equal(C.validRange("2030-03-01", "2030-05-03"), false);
  assert.equal(C.validRange("2030-03-02", "2030-03-01"), false);
  for (const bad of [[null, "2030-03-01"], ["2030-03-01", undefined], ["2030-3-1", "2030-03-02"], ["2030-02-30", "2030-03-02"], ["2030-03-01T00:00", "2030-03-02"], [20300301, "2030-03-02"]]) {
    assert.equal(C.validRange(bad[0], bad[1]), false);
  }
  assert.equal(C.shiftDate("2030-03-01", -1), "2030-02-28");
  assert.equal(C.shiftDate("2028-02-28", 1), "2028-02-29");
  assert.equal(C.spanDays("2030-03-08", "2030-03-11"), 3);
});

test("a timed event is shown on its local start date, in the viewer's zone", () => {
  const [late] = parse([timed("late", "2030-03-06T03:30:00Z", "2030-03-06T04:30:00Z")]);
  assert.deepEqual(C.eventDays(late, "2030-03-01", "2030-03-31", NY), ["2030-03-05"], "03:30Z is the evening before in New York");
  assert.deepEqual(C.eventDays(late, "2030-03-01", "2030-03-31", "Europe/Madrid"), ["2030-03-06"]);
  assert.deepEqual(C.eventDays(late, "2030-03-06", "2030-03-31", NY), [], "outside the range");
  assert.equal(C.localDate(new Date("2030-03-06T03:30:00Z"), NY), "2030-03-05");
  assert.equal(C.localDate(new Date(2030, 2, 6, 23, 59)), "2030-03-06", "no zone = the machine's own calendar date");
});

test("an event past midnight is listed once; one of 24 h or more is listed on each day", () => {
  const [overnight, long] = parse([
    timed("overnight", "2030-03-06T03:00:00Z", "2030-03-06T07:00:00Z"),   // 22:00 -> 02:00 New York
    timed("long", "2030-03-08T14:00:00Z", "2030-03-10T22:00:00Z"),
  ]);
  assert.deepEqual(C.eventDays(overnight, "2030-03-01", "2030-03-31", NY), ["2030-03-05"]);
  assert.deepEqual(C.eventDays(long, "2030-03-01", "2030-03-31", NY), ["2030-03-08", "2030-03-09", "2030-03-10"]);
  assert.deepEqual(C.eventDays(long, "2030-03-09", "2030-03-09", NY), ["2030-03-09"], "clipped to the range");
  const [toMidnight] = parse([timed("mid", "2030-03-08T05:00:00Z", "2030-03-09T05:00:00Z")]); // 00:00 -> 00:00 New York
  assert.deepEqual(C.eventDays(toMidnight, "2030-03-01", "2030-03-31", NY), ["2030-03-08"], "the end is exclusive");
});

test("all-day events use their own dates, never a time zone", () => {
  const [one, three] = parse([allDay("one", "2030-03-05", "2030-03-05"), allDay("three", "2030-03-30", "2030-04-01")]);
  for (const zone of [NY, "Pacific/Auckland", "Pacific/Honolulu"]) {
    assert.deepEqual(C.eventDays(one, "2030-03-01", "2030-03-31", zone), ["2030-03-05"]);
    assert.deepEqual(C.eventDays(three, "2030-03-01", "2030-03-31", zone), ["2030-03-30", "2030-03-31"], "clipped at the range end");
  }
  assert.deepEqual(C.eventDays(three, "2030-04-01", "2030-04-30", NY), ["2030-04-01"]);
});

test("a day lists all-day events first, then by start time, with a stable tie-break", () => {
  const events = parse([
    timed("b", "2030-03-05T18:00:00Z", "2030-03-05T19:00:00Z", { title: "Same" }),
    timed("a", "2030-03-05T18:00:00Z", "2030-03-05T19:00:00Z", { title: "Same" }),
    timed("early", "2030-03-05T13:00:00Z", "2030-03-05T14:00:00Z"),
    allDay("day", "2030-03-04", "2030-03-06"),
  ]);
  const byDay = C.eventsByDay(events, "2030-03-05", "2030-03-06", NY);
  assert.deepEqual(byDay.get("2030-03-05").map((e) => e.key), ["day", "early", "a", "b"]);
  assert.deepEqual(byDay.get("2030-03-06").map((e) => e.key), ["day"]);
  assert.equal(byDay.has("2030-03-04"), false);
  assert.deepEqual(C.eventsByDay([...events].reverse(), "2030-03-05", "2030-03-06", NY).get("2030-03-05").map((e) => e.key), ["day", "early", "a", "b"], "input order does not matter");
});

test("time labels", () => {
  const [meeting, noLength, long, day] = parse([
    timed("m", "2030-03-05T14:00:00Z", "2030-03-05T15:30:00Z"),
    timed("n", "2030-03-05T14:00:00Z", "2030-03-05T14:00:00Z"),
    timed("l", "2030-03-08T14:00:00Z", "2030-03-10T22:00:00Z"),
    allDay("d", "2030-03-05", "2030-03-05"),
  ]);
  assert.equal(C.timeLabel(meeting, "2030-03-05", NY, "en-US"), "9:00 AM - 10:30 AM");
  assert.equal(C.timeLabel(meeting, "2030-03-05", "Europe/Madrid", "en-US"), "3:00 PM - 4:30 PM");
  assert.equal(C.timeLabel(noLength, "2030-03-05", NY, "en-US"), "9:00 AM");
  assert.equal(C.timeLabel(day, "2030-03-05", NY, "en-US"), "All day");
  assert.equal(C.timeLabel(long, "2030-03-08", NY, "en-US"), "9:00 AM - 6:00 PM", "its first day shows the start and end clock times");
  assert.equal(C.timeLabel(long, "2030-03-09", NY, "en-US"), "Continues");
  assert.equal(C.timeLabel(long, "2030-03-10", NY, "en-US"), "Until 6:00 PM");
});

test("calendar entries for /health are display-only copies, never care items", () => {
  const events = parse([
    timed("t", "2030-03-05T14:00:00Z", "2030-03-05T15:00:00Z", { location: "Room 4", status: "tentative" }),
    allDay("d", "2030-03-05", "2030-03-06"),
  ]);
  const entries = C.externalEntries(events, "2030-03-01", "2030-03-31", NY, "en-US");
  assert.deepEqual(entries.map((e) => [e.date, e.key, e.when]), [
    ["2030-03-05", "calendar:d:2030-03-05", "All day"], ["2030-03-05", "calendar:t:2030-03-05", "9:00 AM - 10:00 AM"], ["2030-03-06", "calendar:d:2030-03-06", "All day"],
  ]);
  for (const e of entries) {
    assert.equal(e.status, "external");
    assert.equal(e.itemId, "", "no care item id: nothing can edit, complete or archive it");
    assert.equal(e.sample, false);
    assert.equal(e.months, 0);
    assert.equal(e.time, null, "`time` is a care item's own HH:MM; a calendar entry's text is `when`");
    assert.equal(e.calendar, "main");
  }
  assert.deepEqual([entries[1].tentative, entries[1].location, entries[0].tentative], [true, "Room 4", false]);
  assert.equal(new Set(entries.map((e) => e.key)).size, entries.length, "keys are unique per shown day");
});

test("merging puts care items first on a day and keeps both lists whole", () => {
  const care = [{ date: "2030-03-05", key: "care-1" }, { date: "2030-03-09", key: "care-2" }];
  const external = [{ date: "2030-03-05", key: "calendar:a" }, { date: "2030-03-05", key: "calendar:b" }, { date: "2030-03-07", key: "calendar:c" }];
  const merged = C.mergeByDate(care, external);
  assert.deepEqual(merged.get("2030-03-05").map((e) => e.key), ["care-1", "calendar:a", "calendar:b"]);
  assert.deepEqual(merged.get("2030-03-07").map((e) => e.key), ["calendar:c"]);
  assert.deepEqual(merged.get("2030-03-09").map((e) => e.key), ["care-2"]);
  assert.equal([...merged.values()].flat().length, 5);
  assert.equal(C.mergeByDate(care, []).size, 2, "no calendar events = the care calendar exactly as before");
  assert.equal(care.length, 2, "inputs are not changed");
});

test("sync health: ok, late after 3 h or a partial run, failing after 8 h or a failed run", () => {
  const now = Date.parse("2030-03-05T12:00:00Z");
  const at = (h, status = "success") => ({ at: new Date(now - h * 3_600_000).toISOString(), status, error: null });
  assert.equal(C.syncHealth(null, now), "never");
  assert.equal(C.syncHealth(at(0.5), now), "ok");
  assert.equal(C.syncHealth(at(3.1), now), "late");
  assert.equal(C.syncHealth(at(0.5, "partial"), now), "late");
  assert.equal(C.syncHealth(at(8.1), now), "failing");
  assert.equal(C.syncHealth(at(0.5, "failed"), now), "failing");
  assert.equal(C.syncHealth({ at: "bad", status: "success", error: null }, now), "failing");
});

test("the /health card state: checking, synced, late, failing, not synced yet, unreachable", () => {
  const now = Date.parse("2030-03-05T12:00:00Z");
  const sync = (h, status = "success", error = null) => ({ at: new Date(now - h * 3_600_000).toISOString(), status, error });
  const state = (load, last) => C.readConnection(load, last, now);
  assert.equal(state("loading", null).status, "checking");
  assert.equal(state("error", sync(0.2)).status, "unavailable", "Onyx could not read its copy: not 'not synced', not 'empty'");
  assert.equal(state("not_connected", null).status, "not-synced", "the table does not exist yet");
  assert.equal(state("not_connected", sync(0.2, "failed", "table missing")).status, "not-synced");
  assert.equal(state("ready", null).status, "not-synced", "the table exists but the sync has never run");
  assert.equal(state("ready", sync(0.3)).status, "synced");
  assert.equal(state("ready", sync(0.3)).statusLabel, "Synced (read-only)");
  assert.equal(state("ready", sync(2.9)).status, "synced");
  assert.equal(state("ready", sync(3.1)).status, "late");
  assert.equal(state("ready", sync(0.3, "partial")).status, "late");
  assert.equal(state("ready", sync(8.1)).status, "failing");
  assert.equal(state("ready", sync(0.3, "failed", "x")).status, "failing");
  assert.equal(state("ready", sync(0.3, "failed", "x")).statusLabel, "Sync failing");
  assert.equal(state("ready", { at: "not a date", status: "success", error: null }).status, "failing", "an unreadable time is never fresh");
  for (const [load, last] of [["loading", null], ["error", null], ["not_connected", null], ["ready", null], ["ready", sync(0.3)], ["ready", sync(9)], ["ready", sync(0.3, "partial")]]) {
    const c = state(load, last);
    assert.equal(c.readOnly, true);
    assert.equal(c.writesToCalendar, false);
    assert.ok(c.statusLabel && c.detail);
  }
});

test("a fetched body is accepted only in the two known shapes", () => {
  assert.equal(C.readCalendarResponse({ status: "not_connected", lastSync: null }).status, "not_connected");
  assert.equal(C.readCalendarResponse({ status: "ready", events: [], truncated: false, lastSync: null }).status, "ready");
  for (const bad of [null, {}, { status: "ready" }, { status: "ready", events: "x" }, { error: "calendar unavailable" }]) {
    assert.throws(() => C.readCalendarResponse(bad));
  }
});

test("the lib has no runtime import and does no I/O", () => {
  const src = fs.readFileSync(path.join(SRC, "lib/calendar-events.ts"), "utf8");
  assert.ok(!/^import\s(?!type\b)/m.test(src), "Today's regression test bundles this file on its own");
  assert.ok(!/fetch\(|createClient|process\.env/.test(src));
});

test("route is force-dynamic, no-store, read-only and outside the CI carve-out", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/calendar/events/route.ts"), "utf8");
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /no-store/);
  assert.match(route, /validRange\(/);
  assert.deepEqual(route.match(/export async function (\w+)/g), ["export async function GET"], "GET only: nothing can write through this route");
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.ok(!mw.includes("/api/calendar"), "owner session only: never in isCiRoute()");
});

test("server reader is server-only, reads explicit columns and never writes", () => {
  const src = fs.readFileSync(path.join(SRC, "lib/calendar-events-server.ts"), "utf8");
  assert.ok(src.startsWith('import "server-only";'));
  assert.match(src, /select\(CALENDAR_EVENT_COLUMNS\)/);
  assert.ok(!/\.(insert|upsert|update|delete)\(/.test(src), "the frontend only ever reads calendar events");
  assert.deepEqual(src.match(/console\.\w+\(.*\)/g), ['console.error("calendar events read failed:", code || "unknown")'], "errors log a code, never rows");
  const status = fs.readFileSync(path.join(SRC, "app/api/status/route.ts"), "utf8");
  assert.ok(!status.includes("calendar-events-server") && !status.includes('"calendar_events"'), "/api/status is cacheable: heartbeats only, no event rows");
});

test("the calendar events path only reads: no page sends anything to it, and it never touches care items", () => {
  // The files that fetch or draw the synced events issue GETs only and hold no button.
  for (const file of ["app/health/useCalendarEvents.ts", "app/health/CalendarEventsCard.tsx", "app/health/CareCalendar.tsx"]) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    assert.ok(!/method\s*:/.test(src), `${file} sends no request with a method (GET only)`);
    assert.ok(!/api\/care\//.test(src), `${file} never calls a care-item or care-calendar route`);
  }
  assert.ok(!fs.readFileSync(path.join(SRC, "app/health/CalendarEventsCard.tsx"), "utf8").includes("<button"), "nothing to press on the read-only card");
  // Wherever the events route is requested, it is a plain GET.
  for (const file of ["app/health/useCalendarEvents.ts", "app/today/TodayClient.tsx"]) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    const calls = src.match(/fetch\(`\/api\/calendar\/events[^)]*\)/g) ?? [];
    assert.ok(calls.length === 1, `${file} requests the events route once`);
    assert.ok(!/method|body/.test(calls[0]), `${file} only reads the events route`);
  }
  // The care-item write paths and the care-items -> Google sync never read the synced events.
  for (const file of ["lib/care-items.ts", "lib/care-items-server.ts", "lib/care-google.ts", "lib/care-google-server.ts"]) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    assert.ok(!src.includes("calendar-events") && !src.includes("calendar_events"), `${file} is independent of the synced calendar events`);
  }
});
