// Run: node --test tests/health-calendar.test.cjs
// /health: the Month view with synced calendar events next to care items, and the read-only
// "Your calendar events" card's states. Renders the real components to static markup (no browser). SYNTHETIC data only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./helpers/load-ts.cjs");

const { CareCalendar, DueSoon } = loadTs("app/health/CareCalendar.tsx");
const Card = loadTs("app/health/CalendarEventsCard.tsx").default;

const TODAY = "2030-03-05";
// Local noon-ish instants, so the day an event lands on does not depend on the machine's zone.
const local = (day, hour, minute = 0) => new Date(2030, 2, day, hour, minute).toISOString();
const timed = (key, title, day, hour, over = {}) => ({
  key, title, allDay: false, startAt: local(day, hour), endAt: local(day, hour + 1), startDate: `2030-03-${String(day).padStart(2, "0")}`,
  endDate: `2030-03-${String(day).padStart(2, "0")}`, calendar: "main", account: "acct one", location: null, status: "confirmed", recurring: false, ...over,
});
const allDay = (key, title, from, to) => ({
  key, title, allDay: true, startAt: null, endAt: null, startDate: from, endDate: to, calendar: "side", account: "acct two", location: null, status: "confirmed", recurring: false,
});
const care = (id, title, due, over = {}) => ({ id, title, due, months: 0, booked: false, archived: false, kind: "other", time: null, tz: "America/New_York", notes: "", completedOn: null, ...over });

const ITEMS = [care("c1", "Routine care visit", "2030-03-05")];
const EVENTS = [
  timed("e-noon", "Synthetic noon review", 5, 12, { location: "Room 4", status: "tentative" }),
  timed("e-morning", "Synthetic morning sync", 5, 9),
  allDay("e-day", "Synthetic two-day block", "2030-03-05", "2030-03-06"),
  timed("e-other", "Synthetic later meeting", 20, 15),
];
const month = (props) => renderToStaticMarkup(React.createElement(CareCalendar, { items: ITEMS, today: TODAY, ...props }));
const cell = (html, day) => {
  // The <td> whose date number is `day` inside March (cells of other months are dimmed).
  const cells = html.split("<td").slice(1).filter((td) => !td.includes("opacity-40"));
  return cells.find((td) => new RegExp(`>${day}(<span class="sr-only"> \\(today\\)</span>)?</div>`).test(td)) ?? "";
};

test("month view lists care items first, then the calendar's events, each marked read-only", () => {
  const html = month({ external: EVENTS });
  const day5 = cell(html, 5);
  const order = ["Routine care visit", "Synthetic two-day block", "Synthetic morning sync"].map((t) => day5.indexOf(`>${t}<`));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], "care item, then all-day, then by start time");
  assert.match(day5, /\+1 more/, "the fourth entry of the day is counted, not dropped silently");
  assert.match(day5, /Synthetic two-day block<span class="sr-only">: All day, Google Calendar: side \(read-only\)<\/span>/);
  assert.match(day5, /Synthetic morning sync<span class="sr-only">: [^<]*Google Calendar: main \(read-only\)<\/span>/);
  assert.match(day5, /Routine care visit<span class="sr-only">: Due, needs booking<\/span>/, "the care item keeps its own status");
  assert.match(cell(html, 6), />Synthetic two-day block</, "a two-day all-day event is on both days");
  assert.match(cell(html, 20), />Synthetic later meeting</);
  assert.equal(cell(html, 7).includes("Google Calendar:"), false);
  assert.match(html, /<caption class="sr-only">March 2030: care items and calendar events by day<\/caption>/);
  assert.match(html, /read-only copies of events on your calendars/);
});

test("with no synced events the month is the care calendar alone", () => {
  for (const html of [month({}), month({ external: [] })]) {
    assert.match(cell(html, 5), />Routine care visit</);
    assert.equal(/Google Calendar: \w+ \(read-only\)/.test(html), false);
    assert.equal(html.includes("Synthetic"), false);
  }
});

test("calendar events never reach the due-soon list or the care items", () => {
  const html = renderToStaticMarkup(React.createElement(DueSoon, { items: ITEMS, today: TODAY }));
  assert.match(html, /Routine care visit/);
  assert.equal(html.includes("Synthetic"), false);
  assert.equal(ITEMS.length, 1);
});

const view = (over) => ({ state: "ready", events: [], lastSync: null, truncated: false, calendars: null, stale: false, ...over });
const sync = (minutesAgo, status = "success", error = null) => ({ at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), status, error });
const card = (calendar) => renderToStaticMarkup(React.createElement(Card, { calendar }));

test("events card: synced shows the calendars, their event counts and the last sync age", () => {
  const html = card(view({ lastSync: sync(20), calendars: [{ account: "acct one", calendar: "main", events: 66 }, { account: "acct two", calendar: "side", events: 1 }] }));
  assert.match(html, /Google Calendar: <span class="text-up">connected<\/span>/);
  assert.match(html, /main <span[^>]*>\(acct one\)<\/span><\/span><span[^>]*>66 events<\/span>/);
  assert.match(html, /side <span[^>]*>\(acct two\)<\/span><\/span><span[^>]*>1 event<\/span>/);
  assert.match(html, /67 events in all/);
  assert.match(html, /Last sync 20 min ago\./);
});

test("events card: not synced yet, checking, unreachable and failing are different states", () => {
  const notConnected = card(view({ state: "not_connected" }));
  assert.match(notConnected, /Google Calendar: <span[^>]*>not synced yet<\/span>/);
  const neverRan = card(view({ calendars: [] }));
  assert.match(neverRan, />not synced yet</);
  const checking = card(view({ state: "loading" }));
  assert.match(checking, />checking</);
  assert.match(checking, /Checking the calendar events sync\./);
  const unreachable = card(view({ state: "error" }));
  assert.match(unreachable, />couldn&#x27;t be checked</);
  const failing = card(view({ lastSync: sync(30, "failed", "calendar 'main' (acct one): HTTP 404"), calendars: [{ account: "acct one", calendar: "main", events: 3 }] }));
  assert.match(failing, /Google Calendar: <span class="text-down">sync failing<\/span>/);
  assert.match(failing, /Last sync 30 min ago \(that run: failed\)\. calendar &#x27;main&#x27; \(acct one\): HTTP 404/);
  assert.match(failing, />3 events</, "the last good copy is still listed");
  const late = card(view({ lastSync: sync(200), calendars: [] }));
  assert.match(late, /running late/);
  const stale = card(view({ lastSync: sync(20), calendars: [], stale: true }));
  assert.match(stale, /Couldn&#x27;t refresh the calendar events/);
  for (const html of [notConnected, neverRan, checking, unreachable, failing, late, stale]) {
    assert.equal(html.includes("<button"), false, "nothing to press: there is no sign-in and no write access");
    assert.match(html, /this sync cannot change your calendars or turn a care item into a calendar event/);
    // The care-items -> Google card above it owns these: the smoke test and the UI test look them up by name.
    assert.equal(html.includes("Copy care items to Google Calendar"), false, "never the other card's heading");
    assert.equal(html.includes('aria-label="Google Calendar connection"'), false, "never the other card's label");
  }
  for (const html of [notConnected, checking, unreachable]) assert.equal(/\d+ events?</.test(html), false);
});
