// Run: node --test tests/care-google.test.cjs
// Google Calendar sync for /health care items (lib/care-google.ts, lib/care-google-server.ts and
// the /api/care/google/* routes), against a FAKE Google and an in-memory database:
//   - the sign-in asks for exactly one scope, with state + PKCE;
//   - the sync creates / rewrites / removes only events that carry Onyx's tag for that item;
//   - nothing calls Google until the credentials exist AND a connection was made.
// SYNTHETIC DATA ONLY: invented labels, dates, ids and tokens; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const G = loadTs("lib/care-google.ts");

const ID1 = "11111111-2222-4333-8444-555555555555";
const ID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ID3 = "99999999-8888-4777-8666-555555555555";
const CAL = "calendar-fixture-1";
const item = (over = {}) => ({
  id: ID1, title: "Routine checkup", kind: "medical", due: "2026-03-10", time: null, tz: "America/New_York",
  months: 12, booked: false, notes: "Private note that must stay in Onyx", archived: false, completedOn: null, ...over,
});

// ---------- sign-in ----------

test("the consent URL asks for exactly one scope, with state and PKCE", async () => {
  assert.equal(G.GOOGLE_SCOPE, "https://www.googleapis.com/auth/calendar.app.created");
  const verifier = G.randomToken(48);
  const state = G.randomToken(32);
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/); // RFC 7636 length and alphabet
  assert.notEqual(G.randomToken(32), state);
  const url = new URL(G.buildAuthUrl({ clientId: "client-fixture", redirectUri: "https://onyx.example/api/care/google/callback", state, challenge: await G.pkceChallenge(verifier) }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const q = url.searchParams;
  assert.equal(q.get("scope"), G.GOOGLE_SCOPE);
  assert.ok(!/gmail|mail\.google|calendar\.events|auth\/calendar(\s|$)|readonly|drive|contacts/.test(q.get("scope")));
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("include_granted_scopes"), "false");
  assert.equal(q.get("state"), state);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("redirect_uri"), "https://onyx.example/api/care/google/callback");
  assert.equal(q.get("client_id"), "client-fixture");
  // RFC 7636 appendix B test vector.
  assert.equal(await G.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("the granted scope must be exactly the one asked for", () => {
  assert.equal(G.scopeIsExactly(G.GOOGLE_SCOPE), true);
  assert.equal(G.scopeIsExactly(`${G.GOOGLE_SCOPE} https://www.googleapis.com/auth/calendar`), false);
  assert.equal(G.scopeIsExactly("https://www.googleapis.com/auth/calendar.events"), false);
  assert.equal(G.scopeIsExactly("https://mail.google.com/"), false);
  assert.equal(G.scopeIsExactly(""), false);
  assert.equal(G.scopeIsExactly(undefined), false);
});

test("the sign-in cookie round-trips and rejects anything malformed", () => {
  const state = G.randomToken(32);
  const verifier = G.randomToken(48);
  assert.deepEqual(G.parseOauthCookie(G.oauthCookieValue(state, verifier)), { state, verifier });
  for (const bad of [null, undefined, "", "onlyone", "a.b", `${state}.${verifier}.x`, `${state}.`, `${state}.has space and more characters`]) {
    assert.equal(G.parseOauthCookie(bad), null, String(bad));
  }
  assert.equal(G.sameToken("abc", "abc"), true);
  assert.equal(G.sameToken("abc", "abd"), false);
  assert.equal(G.sameToken("abc", "abcd"), false);
});

// ---------- a care item as an event ----------

test("an item becomes an all-day or timed event that carries Onyx's tag and no notes", async () => {
  const allDay = G.eventForItem(item(), 0);
  assert.equal(allDay.id, "care11111111222243338444555555555555g0");
  assert.match(allDay.id, /^[a-v0-9]{5,1024}$/); // Google's id alphabet
  assert.equal(allDay.summary, "Book: Routine checkup"); // a due date must not read like an appointment
  assert.deepEqual(allDay.start, { date: "2026-03-10" });
  assert.deepEqual(allDay.end, { date: "2026-03-11" });
  assert.equal(allDay.transparency, "transparent");
  assert.deepEqual(allDay.extendedProperties, { private: { onyxCareItem: ID1 } });
  assert.ok(!JSON.stringify(allDay).includes("Private note"), "notes never leave Onyx");

  const timed = G.eventForItem(item({ booked: true, time: "23:30", tz: "Europe/Madrid", months: 0 }), 2);
  assert.equal(timed.id, "care11111111222243338444555555555555g2");
  assert.equal(timed.summary, "Routine checkup");
  assert.deepEqual(timed.start, { dateTime: "2026-03-10T23:30:00", timeZone: "Europe/Madrid" });
  assert.deepEqual(timed.end, { dateTime: "2026-03-11T00:30:00", timeZone: "Europe/Madrid" }); // across midnight
  assert.equal(timed.transparency, "opaque");
  assert.ok(!("recurrence" in timed), "repeats count from completion, so no recurring event is sent");
  assert.match(G.eventForItem(item({ months: 6 }), 0).description, /Repeats 6 months after you mark it complete/);

  assert.equal(await G.fingerprint(allDay), await G.fingerprint(G.eventForItem(item(), 0)));
  assert.notEqual(await G.fingerprint(allDay), await G.fingerprint(G.eventForItem(item({ due: "2026-03-11" }), 0)));
  assert.equal(await G.fingerprint(allDay), await G.fingerprint(G.eventForItem(item({ notes: "different note" }), 0)), "a note change is not a calendar change");
  assert.equal(G.shouldHaveEvent(item()), true);
  assert.equal(G.shouldHaveEvent(item({ archived: true })), false);
});

// ---------- the sync, against a fake Google ----------

function fakeGoogle() {
  const g = { events: new Map(), calls: [], fail: null };
  const failing = (op, id) => (g.fail && g.fail.op === op && (!g.fail.id || g.fail.id === id) ? { ok: false, status: g.fail.status } : null);
  g.api = {
    async getEvent(cal, id) {
      g.calls.push(["get", id]);
      assert.equal(cal, CAL);
      const f = failing("get", id);
      if (f) return f;
      return g.events.has(id) ? { ok: true, value: g.events.get(id) } : { ok: false, status: 404 };
    },
    async insertEvent(cal, event) {
      g.calls.push(["insert", event.id]);
      assert.equal(cal, CAL);
      const f = failing("insert", event.id);
      if (f) return f;
      if (g.events.has(event.id)) return { ok: false, status: 409 };
      g.events.set(event.id, { ...event, status: "confirmed" });
      return { ok: true, value: g.events.get(event.id) };
    },
    async updateEvent(cal, id, event) {
      g.calls.push(["update", id]);
      const f = failing("update", id);
      if (f) return f;
      if (!g.events.has(id)) return { ok: false, status: 404 };
      g.events.set(id, { ...event, status: "confirmed" });
      return { ok: true, value: g.events.get(id) };
    },
    async deleteEvent(cal, id) {
      g.calls.push(["delete", id]);
      const f = failing("delete", id);
      if (f) return f;
      const e = g.events.get(id);
      if (!e || e.status === "cancelled") return { ok: false, status: 410 };
      g.events.set(id, { ...e, status: "cancelled" });
      return { ok: true, value: null };
    },
  };
  return g;
}

/** Apply the links a run returned on top of the ones it was given, like the database does. */
const merge = (links, changed) => [...links.filter((l) => !changed.some((c) => c.itemId === l.itemId)), ...changed];

/** The rule that matters most: no rewrite or removal without first reading that same event. */
function assertReadBeforeWrite(calls) {
  calls.forEach(([op, id], i) => {
    if (op === "update" || op === "delete") assert.deepEqual(calls[i - 1], ["get", id], `${op} of ${id} must follow a read of it`);
  });
}

const E1 = G.eventId(ID1, 0), E2 = G.eventId(ID2, 0);

test("first sync makes one tagged event per active item; a second sync makes no call at all", async () => {
  const g = fakeGoogle();
  const items = [item(), item({ id: ID2, title: "Dental cleaning", booked: true, time: "09:30" }), item({ id: ID3, title: "Old item", archived: true })];
  const first = await G.runSync(g.api, CAL, items, []);
  assert.deepEqual({ ok: first.ok, created: first.created, updated: first.updated, removed: first.removed, failed: first.failed }, { ok: true, created: 2, updated: 0, removed: 0, failed: 0 });
  assert.deepEqual([...g.events.keys()].sort(), [E1, E2].sort());
  for (const e of g.events.values()) assert.ok([ID1, ID2].includes(e.extendedProperties.private.onyxCareItem));
  assert.equal(first.links.length, 2);
  assert.ok(first.links.every((l) => l.state === "present" && l.calendarId === CAL && l.generation === 0));

  g.calls.length = 0;
  const second = await G.runSync(g.api, CAL, items, first.links);
  assert.deepEqual(g.calls, [], "an unchanged item costs no Google call");
  assert.equal(second.unchanged, 2);
  assert.deepEqual(second.links, []);
  assert.equal(second.ok, true);
});

test("a changed item is read, checked, then rewritten; an archived or removed one is taken off", async () => {
  const g = fakeGoogle();
  const a = item(), b = item({ id: ID2, title: "Dental cleaning" });
  let links = (await G.runSync(g.api, CAL, [a, b], [])).links;

  g.calls.length = 0;
  const changed = await G.runSync(g.api, CAL, [item({ due: "2026-04-01", booked: true }), b], links);
  assert.deepEqual(g.calls, [["get", E1], ["update", E1]]);
  assert.equal(changed.updated, 1);
  assert.equal(changed.unchanged, 1);
  assert.equal(g.events.get(E1).summary, "Routine checkup");
  assert.deepEqual(g.events.get(E1).start, { date: "2026-04-01" });
  links = merge(links, changed.links);

  g.calls.length = 0;
  const archived = await G.runSync(g.api, CAL, [item({ due: "2026-04-01", booked: true, archived: true }), b], links);
  assert.deepEqual(g.calls, [["get", E1], ["delete", E1]]);
  assert.equal(archived.removed, 1);
  assert.equal(g.events.get(E1).status, "cancelled");
  links = merge(links, archived.links);
  assert.equal(links.find((l) => l.itemId === ID1).state, "gone");

  g.calls.length = 0;
  const removed = await G.runSync(g.api, CAL, [], links); // item b was removed in Onyx: no longer in the list
  assert.deepEqual(g.calls, [["get", E2], ["delete", E2]]);
  assert.equal(removed.removed, 1);
  links = merge(links, removed.links);

  g.calls.length = 0;
  const idle = await G.runSync(g.api, CAL, [], links);
  assert.deepEqual(g.calls, [], "events already taken off are not asked about again");
  assert.equal(idle.ok, true);

  // Restoring the archived item: its old event was removed, so it gets a new one under the next id.
  const restored = await G.runSync(g.api, CAL, [item({ due: "2026-04-01", booked: true })], links);
  assert.equal(restored.created, 1);
  assert.equal(restored.links[0].generation, 1);
  assert.equal(g.events.get(G.eventId(ID1, 1)).status, "confirmed");
  assert.equal(g.events.get(E1).status, "cancelled");
});

test("an event Onyx did not create is never changed or removed, even under an Onyx id", async () => {
  const foreign = { id: E1, status: "confirmed", summary: "Someone else's event", extendedProperties: { private: {} } };
  const otherItems = { id: E1, status: "confirmed", summary: "Tagged for another item", extendedProperties: { private: { onyxCareItem: ID2 } } };
  for (const stranger of [foreign, otherItems, { id: E1, status: "confirmed", summary: "No properties at all" }]) {
    // Insert path: the id is taken by something that is not ours.
    let g = fakeGoogle();
    g.events.set(E1, stranger);
    const made = await G.runSync(g.api, CAL, [item()], []);
    assert.equal(g.events.get(E1), stranger, "left exactly as it was");
    assert.equal(made.created, 1);
    assert.equal(made.foreign, 1);
    assert.equal(made.links[0].eventId, G.eventId(ID1, 1));
    assert.ok(!g.calls.some(([op, id]) => (op === "update" || op === "delete") && id === E1));
    assertReadBeforeWrite(g.calls);

    // Update path: Onyx believes E1 is its event, but the tag says otherwise.
    g = fakeGoogle();
    g.events.set(E1, stranger);
    const link = { itemId: ID1, calendarId: CAL, eventId: E1, generation: 0, fingerprint: "stale", state: "present" };
    const upd = await G.runSync(g.api, CAL, [item()], [link]);
    assert.equal(g.events.get(E1), stranger);
    assert.equal(upd.updated, 0);
    assert.equal(upd.created, 1);
    assert.ok(!g.calls.some(([op, id]) => (op === "update" || op === "delete") && id === E1));

    // Removal path: the item is archived, but the event under its id is not ours.
    g = fakeGoogle();
    g.events.set(E1, stranger);
    const rem = await G.runSync(g.api, CAL, [item({ archived: true })], [link]);
    assert.equal(g.events.get(E1), stranger);
    assert.equal(rem.removed, 0);
    assert.equal(rem.foreign, 1);
    assert.deepEqual(g.calls, [["get", E1]]);
    assert.equal(rem.links[0].state, "gone"); // forgotten, not removed
  }
});

test("an event removed or purged in Google is made again", async () => {
  const g = fakeGoogle();
  const links = (await G.runSync(g.api, CAL, [item()], [])).links;
  g.events.set(E1, { ...g.events.get(E1), status: "cancelled" }); // removed by hand in Google Calendar
  const again = await G.runSync(g.api, CAL, [item({ due: "2026-05-01" })], links);
  assert.equal(again.created, 1);
  assert.equal(again.links[0].generation, 1);
  assertReadBeforeWrite(g.calls);

  const h = fakeGoogle();
  const purged = await G.runSync(h.api, CAL, [item()], [{ itemId: ID1, calendarId: CAL, eventId: E1, generation: 0, fingerprint: "stale", state: "present" }]);
  assert.deepEqual(h.calls, [["get", E1], ["insert", E1]]); // 404: the id is free again
  assert.equal(purged.created, 1);

  // A crash after the insert but before the link was saved: the next run finds its own event and rewrites it.
  const c = fakeGoogle();
  await G.runSync(c.api, CAL, [item()], []);
  c.calls.length = 0;
  const recovered = await G.runSync(c.api, CAL, [item()], []);
  assert.deepEqual(c.calls, [["insert", E1], ["get", E1], ["update", E1]]);
  assert.equal(recovered.updated, 1);
  assert.equal(c.events.size, 1, "no duplicate event");
});

test("one failing item does not stop the rest; lost access or a missing calendar stops the run", async () => {
  const items = [item(), item({ id: ID2, title: "Dental cleaning" })];
  let g = fakeGoogle();
  g.fail = { op: "insert", id: E1, status: 500 };
  const partial = await G.runSync(g.api, CAL, items, []);
  assert.deepEqual({ ok: partial.ok, created: partial.created, failed: partial.failed, error: partial.error }, { ok: false, created: 1, failed: 1, error: "google_500" });
  assert.ok(g.events.has(E2));

  g = fakeGoogle();
  g.fail = { op: "insert", status: 401 };
  const noAccess = await G.runSync(g.api, CAL, items, []);
  assert.equal(noAccess.ok, false);
  assert.equal(noAccess.error, "google_auth");
  assert.deepEqual(g.calls, [["insert", E1]], "nothing is tried after access is lost");

  g = fakeGoogle();
  g.fail = { op: "insert", status: 404 };
  const noCalendar = await G.runSync(g.api, CAL, items, []);
  assert.equal(noCalendar.error, "calendar_missing");
  assert.equal(g.calls.length, 1);

  g = fakeGoogle();
  g.fail = { op: "get", status: 0 };
  const offline = await G.runSync(g.api, CAL, [item({ archived: true })], [{ itemId: ID1, calendarId: CAL, eventId: E1, generation: 0, fingerprint: "x", state: "present" }]);
  assert.equal(offline.error, "google_unreachable");
  assert.deepEqual(offline.links, [], "an event that could not be checked is not forgotten");

  // An id that keeps answering "exists" on insert and "not found" on read never settles: the item
  // is counted as failed (also when an earlier item already failed), and the next item still runs.
  g = fakeGoogle();
  g.fail = { op: "insert", id: E1, status: 500 };
  const stuckApi = { ...g.api, insertEvent: async (cal, event) => (event.id === E2 ? { ok: false, status: 409 } : g.api.insertEvent(cal, event)) };
  const stuck = await G.runSync(stuckApi, CAL, [...items, item({ id: ID3, title: "Eye exam" })], []);
  assert.deepEqual({ ok: stuck.ok, created: stuck.created, failed: stuck.failed }, { ok: false, created: 1, failed: 2 });
  assert.ok(g.events.has(G.eventId(ID3, 0)));

  // Links that belong to another calendar (an earlier connection) are ignored, not acted on.
  g = fakeGoogle();
  const other = await G.runSync(g.api, CAL, [], [{ itemId: ID1, calendarId: "some-other-calendar", eventId: E1, generation: 0, fingerprint: "x", state: "present" }]);
  assert.deepEqual(g.calls, []);
  assert.deepEqual(other.links, []);
});

// ---------- the server module and the routes, with a fake database and a fake fetch ----------

function fakeDb(tables) {
  const KEY = { ci_tokens: "service", care_calendar_sync: "id", care_calendar_links: "item_id", care_items: "id" };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = "select"; }
    select() { return this; }
    upsert(rows, opts) { this.op = "upsert"; this.payload = Array.isArray(rows) ? rows : [rows]; assert.equal(opts.onConflict, KEY[this.table]); return this; }
    insert(row) { this.op = "insert"; this.payload = [row]; return this; }
    update(values) { this.op = "update"; this.payload = values; return this; }
    eq(col, v) { this.filters.push((r) => r[col] === v); return this; }
    is(col, v) { this.filters.push((r) => (r[col] ?? null) === v); return this; }
    order() { return this; }
    limit() { return this; }
    single() { this.one = true; return this; }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
    run() {
      tables.calls.push(`${this.op} ${this.table}`);
      const rows = (tables[this.table] ??= []);
      const match = (r) => this.filters.every((f) => f(r));
      if (this.op === "select") return { data: rows.filter(match), count: rows.length, error: null };
      if (this.op === "update") { const hit = rows.filter(match); for (const r of hit) Object.assign(r, this.payload); return { data: hit, error: null }; }
      for (const row of this.payload) {
        const existing = rows.find((r) => r[KEY[this.table]] === row[KEY[this.table]]);
        if (existing) Object.assign(existing, row); else rows.push({ ...row });
      }
      return { data: this.one ? this.payload[0] : this.payload, error: null };
    }
  }
  return { from: (table) => new Query(table) };
}

const ORIGIN = "https://onyx.example";
const TOKENS = { access: "access-fixture-1", refresh: "refresh-fixture-1" };

/** A stand-in for Google's HTTPS endpoints. Records every request it receives. */
function fakeFetch(world) {
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  return async (url, init = {}) => {
    const method = init.method || "GET";
    world.fetches.push({ method, url: String(url), auth: init.headers?.Authorization ?? null });
    if (url === G.GOOGLE_TOKEN_URL) {
      const p = new URLSearchParams(init.body);
      assert.equal(p.get("client_id"), "client-fixture");
      assert.equal(p.get("client_secret"), "secret-fixture");
      if (p.get("grant_type") === "authorization_code") {
        world.exchange = Object.fromEntries(p);
        return json({ access_token: TOKENS.access, refresh_token: TOKENS.refresh, scope: world.grantedScope ?? G.GOOGLE_SCOPE, expires_in: 3599 });
      }
      if (world.revoked || p.get("refresh_token") !== TOKENS.refresh) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: TOKENS.access, expires_in: 3599 });
    }
    if (String(url).startsWith(G.GOOGLE_REVOKE_URL)) { world.revoked = true; return json({}); }
    assert.ok(String(url).startsWith(G.GOOGLE_API), `unexpected host: ${url}`);
    assert.equal(init.headers.Authorization, `Bearer ${TOKENS.access}`);
    const parts = String(url).slice(G.GOOGLE_API.length).split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 1 && method === "POST") { world.calendars.add(CAL); return json({ id: CAL, summary: JSON.parse(init.body).summary }); }
    if (parts.length === 2 && method === "GET") {
      if (world.calendarLookupStatus) return json({}, world.calendarLookupStatus);
      return world.calendars.has(parts[1]) ? json({ id: parts[1] }) : json({}, 404);
    }
    if (!world.calendars.has(parts[1])) return json({}, 404);
    const body = init.body ? JSON.parse(init.body) : null;
    const api = world.google.api;
    const res = parts.length === 3 ? await api.insertEvent(parts[1], body)
      : method === "GET" ? await api.getEvent(parts[1], parts[3])
      : method === "PUT" ? await api.updateEvent(parts[1], parts[3], body)
      : await api.deleteEvent(parts[1], parts[3]);
    return res.ok ? json(res.value ?? {}, res.value ? 200 : 204) : json({}, res.status);
  };
}

function setup({ configured = true } = {}) {
  const world = { fetches: [], google: fakeGoogle(), calendars: new Set(), afterQueue: [], tables: { calls: [], care_items: [] } };
  const response = (status, body, headers) => {
    const cookies = new Map();
    return { status, body, headers: new Headers(headers), cookies: { set: (name, value, opts) => cookies.set(name, { value, ...opts }), get: (name) => cookies.get(name) } };
  };
  const stubs = {
    "server-only": {},
    "next/server": {
      NextResponse: {
        json: (body, init) => response(init?.status ?? 200, body, init?.headers),
        redirect: (url) => response(307, null, { location: String(url) }),
      },
      after: (fn) => world.afterQueue.push(fn),
    },
    "@supabase/supabase-js": { createClient: () => fakeDb(world.tables) },
  };
  if (configured) { process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-fixture"; process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "secret-fixture"; }
  else { delete process.env.GOOGLE_CALENDAR_CLIENT_ID; delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET; }
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(world);
  const load = (file) => loadTs(file, stubs);
  world.routes = {
    status: load("app/api/care/google/status/route.ts"), start: load("app/api/care/google/start/route.ts"),
    callback: load("app/api/care/google/callback/route.ts"), sync: load("app/api/care/google/sync/route.ts"),
    disconnect: load("app/api/care/google/disconnect/route.ts"), items: load("app/api/care/items/route.ts"),
    one: load("app/api/care/items/[id]/route.ts"),
  };
  world.done = () => { globalThis.fetch = realFetch; delete process.env.GOOGLE_CALENDAR_CLIENT_ID; delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET; };
  world.runAfter = async () => { while (world.afterQueue.length) await world.afterQueue.shift()(); };
  return world;
}

const headers = (h) => ({ get: (name) => h[name.toLowerCase()] ?? null });
function request({ body, cookie, query = "", origin = ORIGIN } = {}) {
  const h = { origin, host: "onyx.example", ...(body === undefined ? {} : { "content-type": "application/json" }) };
  return {
    headers: headers(h), text: async () => (body === undefined ? "" : JSON.stringify(body)),
    nextUrl: { origin: ORIGIN, protocol: "https:", searchParams: new URLSearchParams(query) },
    cookies: { get: (name) => (cookie && name === G.OAUTH_COOKIE ? { value: cookie } : undefined) },
  };
}
const row = (it) => ({
  id: it.id, title: it.title, kind: it.kind, due_date: it.due, due_time: it.time, time_zone: it.tz, repeat_months: it.months,
  booked: it.booked, notes: it.notes, archived: it.archived, last_completed_on: it.completedOn, removed_at: null,
});

/** Press Connect, then come back from Google with the right state. */
async function connect(world, { scope } = {}) {
  if (scope) world.grantedScope = scope;
  const started = await world.routes.start.POST(request());
  assert.equal(started.status, 200);
  const cookie = started.cookies.get(G.OAUTH_COOKIE);
  const state = new URL(started.body.url).searchParams.get("state");
  const back = await world.routes.callback.GET(request({ cookie: cookie.value, query: `state=${state}&code=code-fixture` }));
  return { started, cookie, state, back };
}

test("not set up (the default): no route calls Google, touches the token store, or schedules a sync", async () => {
  const w = setup({ configured: false });
  try {
    const status = await w.routes.status.GET();
    assert.deepEqual(status.body, { configured: false, connected: false, calendarName: "Onyx care", connectedAt: null, lastSync: null });
    assert.equal(status.headers.get("Cache-Control"), "no-store");
    const start = await w.routes.start.POST(request());
    assert.equal(start.status, 409);
    assert.equal(start.cookies.get(G.OAUTH_COOKIE), undefined);
    assert.equal((await w.routes.sync.POST(request())).status, 409);
    const back = await w.routes.callback.GET(request({ cookie: "x.y", query: "state=x&code=c" }));
    assert.equal(back.headers.get("location"), `${ORIGIN}/health?calendar=error&reason=not_configured`);
    assert.equal((await w.routes.disconnect.POST(request())).status, 200);
    assert.deepEqual(w.tables.calls, [], "no database call");

    // Saving a care item schedules nothing.
    const created = await w.routes.items.POST(request({ body: item() }));
    assert.equal(created.status, 201);
    assert.equal(w.afterQueue.length, 0);
    assert.deepEqual(w.fetches, [], "Google is never contacted");
    assert.ok(!w.tables.calls.some((c) => c.includes("ci_tokens") || c.includes("care_calendar")));
  } finally { w.done(); }
});

test("set up but not connected: still no call to Google until Riley presses Connect and returns", async () => {
  const w = setup();
  try {
    assert.deepEqual((await w.routes.status.GET()).body, { configured: true, connected: false, calendarName: "Onyx care", connectedAt: null, lastSync: null });
    assert.equal((await w.routes.sync.POST(request())).status, 409);
    await w.routes.items.POST(request({ body: item() }));
    assert.equal(w.afterQueue.length, 1);
    await w.runAfter(); // the background sync finds no connection and stops
    assert.equal((await w.routes.start.POST(request({ origin: "https://evil.example" }))).status, 403);

    const started = await w.routes.start.POST(request());
    const url = new URL(started.body.url);
    assert.equal(url.searchParams.get("scope"), G.GOOGLE_SCOPE);
    assert.equal(url.searchParams.get("redirect_uri"), `${ORIGIN}/api/care/google/callback`);
    const cookie = started.cookies.get(G.OAUTH_COOKIE);
    assert.deepEqual({ httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, path: cookie.path, maxAge: cookie.maxAge },
      { httpOnly: true, secure: true, sameSite: "lax", path: "/api/care/google/callback", maxAge: 600 });
    const pending = G.parseOauthCookie(cookie.value);
    assert.equal(url.searchParams.get("state"), pending.state);
    assert.equal(url.searchParams.get("code_challenge"), await G.pkceChallenge(pending.verifier));
    assert.ok(!started.body.url.includes(pending.verifier), "the verifier never leaves the cookie");

    // Returns that must be refused before anything is sent to Google.
    const refused = [
      [request({ query: `state=${pending.state}&code=c` }), "no_pending_sign_in"],                        // no cookie
      [request({ cookie: cookie.value, query: "state=someone-elses-state-value-000000&code=c" }), "state_mismatch"],
      [request({ cookie: cookie.value, query: "code=c" }), "state_mismatch"],                              // no state at all
      [request({ cookie: cookie.value, query: `state=${pending.state}` }), "no_code"],
    ];
    for (const [req, reason] of refused) {
      const back = await w.routes.callback.GET(req);
      assert.equal(back.headers.get("location"), `${ORIGIN}/health?calendar=error&reason=${reason}`);
      assert.equal(back.cookies.get(G.OAUTH_COOKIE).maxAge, 0, "the sign-in cookie is always cleared");
    }
    const denied = await w.routes.callback.GET(request({ cookie: cookie.value, query: `state=${pending.state}&error=access_denied` }));
    assert.equal(denied.headers.get("location"), `${ORIGIN}/health?calendar=denied`);

    assert.deepEqual(w.fetches, [], "Google is never contacted");
    assert.deepEqual(w.tables.ci_tokens ?? [], []);
  } finally { w.done(); }
});

test("connecting stores the refresh token, makes the Onyx calendar, and the first sync writes tagged events", async () => {
  const w = setup();
  try {
    w.tables.care_items.push(row(item()), row(item({ id: ID2, title: "Dental cleaning", booked: true, time: "09:30" })), row(item({ id: ID3, archived: true })));
    const { back, state, cookie } = await connect(w);
    assert.equal(back.headers.get("location"), `${ORIGIN}/health?calendar=connected`);
    assert.equal(back.cookies.get(G.OAUTH_COOKIE).maxAge, 0);
    // The code was exchanged with the PKCE verifier and the same redirect address.
    assert.equal(w.exchange.code, "code-fixture");
    assert.equal(w.exchange.code_verifier, G.parseOauthCookie(cookie.value).verifier);
    assert.equal(w.exchange.redirect_uri, `${ORIGIN}/api/care/google/callback`);
    assert.ok(state);
    assert.deepEqual(w.fetches.map((f) => `${f.method} ${f.url}`), [`POST ${G.GOOGLE_TOKEN_URL}`, `POST ${G.GOOGLE_API}/calendars`]);
    assert.equal(JSON.parse(w.tables.ci_tokens[0].token_data).refresh_token, TOKENS.refresh);
    assert.equal(w.tables.ci_tokens[0].service, "google_calendar");
    assert.ok(!w.tables.ci_tokens[0].token_data.includes(TOKENS.access), "access tokens are never stored");
    assert.equal(w.tables.care_calendar_sync[0].calendar_id, CAL);

    assert.equal(w.afterQueue.length, 1, "the first sync is scheduled for after the redirect");
    await w.runAfter();
    assert.deepEqual([...w.google.events.keys()].sort(), [E1, E2].sort());
    assert.deepEqual(w.google.events.get(E2).start, { dateTime: "2026-03-10T09:30:00", timeZone: "America/New_York" });
    assert.ok(!JSON.stringify([...w.google.events.values()]).includes("Private note"));
    assert.equal(w.tables.care_calendar_links.length, 2);

    const status = (await w.routes.status.GET()).body;
    assert.equal(status.connected, true);
    assert.deepEqual({ ok: status.lastSync.ok, created: status.lastSync.created, failed: status.lastSync.failed, error: status.lastSync.error }, { ok: true, created: 2, failed: 0, error: null });

    // Sync now: nothing changed, so the only request is the access-token refresh.
    w.fetches.length = 0;
    const again = await w.routes.sync.POST(request());
    assert.equal(again.status, 200);
    assert.deepEqual({ created: again.body.sync.created, unchanged: again.body.sync.unchanged, ok: again.body.sync.ok }, { created: 0, unchanged: 2, ok: true });
    assert.deepEqual(w.fetches.map((f) => f.url), [G.GOOGLE_TOKEN_URL]);
    assert.equal((await w.routes.sync.POST(request({ origin: "https://evil.example" }))).status, 403);

    // Changing an item through the API schedules a sync that rewrites its event after a read.
    w.google.calls.length = 0;
    const patched = await w.routes.one.PATCH(request({ body: { archived: true } }), { params: Promise.resolve({ id: ID1 }) });
    assert.equal(patched.status, 200);
    await w.runAfter();
    assert.deepEqual(w.google.calls, [["get", E1], ["delete", E1]]);
    assert.equal(w.tables.care_calendar_links.find((l) => l.item_id === ID1).state, "gone");
  } finally { w.done(); }
});

test("a grant with any other scope is refused, revoked and not stored", async () => {
  const w = setup();
  try {
    const { back } = await connect(w, { scope: `${G.GOOGLE_SCOPE} https://www.googleapis.com/auth/calendar` });
    assert.equal(back.headers.get("location"), `${ORIGIN}/health?calendar=error&reason=wrong_scope`);
    assert.ok(w.fetches.some((f) => f.url.startsWith(G.GOOGLE_REVOKE_URL)));
    assert.ok(!w.fetches.some((f) => f.url.startsWith(G.GOOGLE_API)), "no calendar is made");
    assert.deepEqual(w.tables.ci_tokens ?? [], []);
    assert.equal(w.afterQueue.length, 0);
    assert.equal((await w.routes.status.GET()).body.connected, false);
  } finally { w.done(); }
});

test("disconnect revokes and forgets the token; afterwards nothing calls Google again", async () => {
  const w = setup();
  try {
    w.tables.care_items.push(row(item()));
    await connect(w);
    await w.runAfter();
    w.fetches.length = 0;
    const off = await w.routes.disconnect.POST(request());
    assert.equal(off.status, 200);
    assert.equal(off.body.connected, false);
    assert.deepEqual(w.fetches.map((f) => f.url), [`${G.GOOGLE_REVOKE_URL}?token=${TOKENS.refresh}`]);
    assert.equal(w.tables.ci_tokens[0].token_data, "{}");
    assert.equal(w.tables.care_calendar_sync[0].calendar_id, CAL, "the calendar is remembered for a later reconnect");
    assert.equal(w.google.events.get(E1).status, "confirmed", "events stay in Google");

    w.fetches.length = 0;
    assert.equal((await w.routes.sync.POST(request())).status, 409);
    await w.routes.items.POST(request({ body: item({ id: ID2, title: "Dental cleaning" }) }));
    await w.runAfter();
    assert.deepEqual(w.fetches, []);
    assert.equal((await w.routes.disconnect.POST(request({ origin: "https://evil.example" }))).status, 403);

    // Connecting again while Google has a hiccup: no second calendar is made, nothing is stored.
    w.revoked = false;
    w.fetches.length = 0;
    w.calendarLookupStatus = 503;
    const hiccup = await connect(w);
    assert.equal(hiccup.back.headers.get("location"), `${ORIGIN}/health?calendar=error&reason=calendar_lookup_503`);
    assert.ok(!w.fetches.some((f) => f.method === "POST" && f.url === `${G.GOOGLE_API}/calendars`));
    assert.equal(w.tables.ci_tokens[0].token_data, "{}");
    assert.equal((await w.routes.status.GET()).body.connected, false);

    // Connecting again reuses the same calendar instead of making a second one.
    w.calendarLookupStatus = 0;
    w.revoked = false;
    w.fetches.length = 0;
    const again = await connect(w);
    assert.equal(again.back.headers.get("location"), `${ORIGIN}/health?calendar=connected`);
    assert.deepEqual(w.fetches.map((f) => `${f.method} ${f.url}`), [`POST ${G.GOOGLE_TOKEN_URL}`, `GET ${G.GOOGLE_API}/calendars/${CAL}`]);
    assert.equal((await w.routes.status.GET()).body.connected, true);
  } finally { w.done(); }
});

test("a revoked token or a failing Google is reported as a code, with no token or event text in logs", async () => {
  const w = setup();
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    w.tables.care_items.push(row(item({ title: "Very private label" })));
    await connect(w);
    w.revoked = true; // Riley removed Onyx's access in his Google account
    const res = await w.routes.sync.POST(request());
    assert.equal(res.status, 200);
    assert.deepEqual({ ok: res.body.sync.ok, error: res.body.sync.error }, { ok: false, error: "google_auth" });
    assert.equal(w.google.calls.length, 0);
    assert.equal((await w.routes.status.GET()).body.lastSync.error, "google_auth");

    w.revoked = false;
    w.google.fail = { op: "insert", status: 500 };
    const failed = await w.routes.sync.POST(request());
    assert.deepEqual({ ok: failed.body.sync.ok, failed: failed.body.sync.failed, error: failed.body.sync.error }, { ok: false, failed: 1, error: "google_500" });
    const everything = JSON.stringify([res.body, failed.body, w.tables.care_calendar_sync, logged]);
    for (const secret of ["Very private label", TOKENS.access, TOKENS.refresh, "secret-fixture"]) assert.ok(!everything.includes(secret), secret);
  } finally { console.error = original; w.done(); }
});

// ---------- boundaries checked from the source ----------

const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test("one scope in the whole app, owner-session routes, additive service-role-only schema", () => {
  const sources = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
  const scopes = new Set();
  for (const file of sources) for (const m of read(file).matchAll(/https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._\/-]+/g)) scopes.add(m[0]);
  assert.deepEqual([...scopes], [G.GOOGLE_SCOPE], "calendar.app.created is the only Google scope in the app");

  const middleware = read(SRC, "middleware.ts");
  const ciBlock = middleware.slice(middleware.indexOf("function isCiRoute"), middleware.indexOf("const PUBLIC_MANIFEST"));
  assert.ok(ciBlock.length > 0 && !ciBlock.includes("/api/care"), "/api/care/google must not be admitted by the CI token");
  assert.ok(!/api\\\/care|care\/google/.test(middleware.slice(middleware.indexOf("PUBLIC_MANIFEST"), middleware.indexOf("export async function middleware"))), "and is not public");

  for (const name of ["status", "start", "callback", "sync", "disconnect"]) {
    const src = read(SRC, "app", "api", "care", "google", name, "route.ts");
    assert.match(src, /export const dynamic = "force-dynamic"/, name);
    assert.ok(!/console\.(log|info|warn)\(/.test(src), name);
    if (["start", "sync", "disconnect"].includes(name)) assert.match(src, /readCareBody\(req, req\.nextUrl\.origin, null\)/, `${name} must check the Origin`);
  }
  const server = read(SRC, "lib", "care-google-server.ts");
  assert.match(server, /^import "server-only";/);
  assert.ok(!/sync_log/.test(server), "no heartbeat rows: results live in care_calendar_sync");
  // Every path to Google's API goes through an access token that only a stored connection or a
  // just-verified sign-in can produce.
  assert.equal((server.match(/\bfetch\(/g) || []).length, 1, "one fetch call site (googleFetch)");
  for (const file of ["app/health/CalendarConnectionCard.tsx", "app/health/HealthClient.tsx", "lib/care-google.ts"]) {
    const src = read(SRC, file);
    assert.ok(!/googleapis\.com\/calendar\/v3[^"']*["']\s*[,)]/.test(src.replace(/export const GOOGLE_API[^\n]*/, "")) && !/oauth2\.googleapis\.com/.test(src.replace(/export const GOOGLE_(TOKEN|REVOKE)_URL[^\n]*/g, "")), `${file} never calls Google`);
    assert.ok(!/\bfetch\(\s*[`'"]https?:/.test(src), `${file} fetches same-origin paths only`);
    assert.ok(!/SERVICE_ROLE|client_secret|CLIENT_SECRET/.test(src), file);
  }

  const sql = read(SRC, "..", "..", "sql", "care_calendar_sync_schema.sql");
  assert.ok(!/\b(drop|truncate|delete)\b/i.test(sql), "additive only");
  const statements = sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
  for (const table of ["care_calendar_sync", "care_calendar_links"]) {
    assert.match(statements, new RegExp(`ALTER TABLE pds\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(statements, new RegExp(`REVOKE ALL ON pds\\.${table} FROM PUBLIC, anon, authenticated`));
  }
  assert.ok(!/GRANT[^;]*\b(anon|authenticated|public)\b/i.test(statements));
  assert.ok(!/CREATE POLICY/i.test(statements));
  assert.ok(!/refresh_token|access_token/i.test(statements), "tokens are not in these tables");
});
