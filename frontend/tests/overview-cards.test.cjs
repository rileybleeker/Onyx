// Run: node --test tests/overview-cards.test.cjs
// The overview under Today (lib/overview-cards.ts, lib/overview-views.ts, components/overview/sources.ts):
// the saved-order merge (new cards appear, removed ones drop, reset), moves and hiding, the card list against
// the nav, what each card shows from its sources, and the privacy / cache rules of those sources.
// SYNTHETIC DATA ONLY: invented values, no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const C = loadTs("lib/overview-cards.ts");
const V = loadTs("lib/overview-views.ts");
const lucide = new Proxy({}, { get: () => () => null });
const NAV = loadTs("lib/nav.ts", { "lucide-react": lucide });
const CACHE = loadTs("lib/client-cache.ts");
const S = loadTs("components/overview/sources.ts", {
  "@/lib/agents-api": { agentsApi: { inbox: async () => ({ items: [], threads: [] }) } },
  "@/lib/queries": {},
  "@/lib/queries-hrv": {},
  "@/lib/client-cache": CACHE,
});

const ids = ["a", "b", "c", "d"];
const arr = (order, hidden = []) => ({ order, hidden });

// ─── the saved order against the current card list ───────────────────────────

test("merge: no saved arrangement is the default order, everything shown", () => {
  assert.deepEqual(C.mergeArrangement(null, ids), arr(["a", "b", "c", "d"]));
  assert.deepEqual(C.mergeArrangement(null), C.defaultArrangement());
});

test("merge: a saved order is kept", () => {
  assert.deepEqual(C.mergeArrangement(arr(["d", "b", "a", "c"], ["b"]), ids), arr(["d", "b", "a", "c"], ["b"]));
});

test("merge: a new card appears right after the card before it in the default order", () => {
  // Saved before "c" existed: it lands after "b" wherever Riley put "b".
  assert.deepEqual(C.mergeArrangement(arr(["d", "b", "a"]), ids), arr(["d", "b", "c", "a"]));
  // New first card (nothing before it): first.
  assert.deepEqual(C.mergeArrangement(arr(["c", "b", "d"]), ids), arr(["a", "c", "b", "d"]));
  // Two new cards keep their default order.
  assert.deepEqual(C.mergeArrangement(arr(["d", "a"]), ids), arr(["d", "a", "b", "c"]));
  // A new card is shown, even when its neighbour is hidden.
  assert.deepEqual(C.mergeArrangement(arr(["a", "b", "d"], ["b"]), ids), arr(["a", "b", "c", "d"], ["b"]));
});

test("merge: removed cards drop out of the order and of hidden; duplicates collapse", () => {
  assert.deepEqual(C.mergeArrangement(arr(["gone", "b", "a", "b", "c", "d"], ["gone", "a"]), ids), arr(["b", "a", "c", "d"], ["a"]));
});

test("reset: the default arrangement, every card shown", () => {
  const custom = arr(["d", "c", "b", "a"], ["a", "c"]);
  assert.equal(C.isDefaultArrangement(custom, ids), false);
  const reset = C.defaultArrangement(ids);
  assert.deepEqual(reset, arr(["a", "b", "c", "d"]));
  assert.equal(C.isDefaultArrangement(reset, ids), true);
});

test("parse: only a {v: 1, order, hidden} value with card-like ids", () => {
  assert.deepEqual(C.parseArrangement({ v: 1, order: ["a", "b"], hidden: ["b"] }), arr(["a", "b"], ["b"]));
  assert.deepEqual(C.parseArrangement({ v: 1, order: ["a", "a"] }), arr(["a"], []));
  for (const bad of [null, [], "x", { order: ["a"] }, { v: 2, order: ["a"], hidden: [] }, { v: 1, order: "a" }, { v: 1, order: [1] }, { v: 1, order: ["Bad Id"] }, { v: 1, order: ["a"], hidden: [3] }]) {
    assert.equal(C.parseArrangement(bad), null, JSON.stringify(bad));
  }
  // Round trip through the stored shape.
  const a = arr(["c", "a", "b"], ["a"]);
  assert.deepEqual(C.parseArrangement(JSON.parse(JSON.stringify(C.toStored(a)))), a);
});

test("move: by one place, to an index, clamped, unchanged at the edges", () => {
  const a = arr(["a", "b", "c", "d"], ["c"]);
  assert.deepEqual(C.moveBy(a, "c", -1).order, ["a", "c", "b", "d"]);
  assert.deepEqual(C.moveBy(a, "a", -1), a);
  assert.deepEqual(C.moveBy(a, "d", 1), a);
  assert.deepEqual(C.moveTo(a, "a", 2).order, ["b", "c", "a", "d"]);
  assert.deepEqual(C.moveTo(a, "d", -5).order, ["d", "a", "b", "c"]);
  assert.deepEqual(C.moveTo(a, "zzz", 0), a);
  assert.deepEqual(C.moveTo(a, "b", 1), a);
  assert.deepEqual(C.moveBy(a, "c", 1).hidden, ["c"], "hiding survives a move");
});

test("hide and show: visibleIds follows the order and leaves hidden cards out", () => {
  const a = arr(["a", "b", "c", "d"]);
  const h = C.setHidden(C.setHidden(a, "c", true), "a", true);
  assert.deepEqual(C.visibleIds(h), ["b", "d"]);
  assert.deepEqual(h.hidden, ["a", "c"]);
  assert.deepEqual(C.visibleIds(C.setHidden(h, "a", false)), ["a", "b", "d"]);
  assert.equal(C.setHidden(a, "zzz", true), a);
  assert.equal(C.setHidden(h, "a", true), h);
  assert.equal(C.sameArrangement(h, arr(["a", "b", "c", "d"], ["c", "a"])), true);
});

// ─── the card list against the nav ───────────────────────────────────────────

test("cards: every href and covered page is a nav page; ids are unique and parseable", () => {
  const hrefs = new Set(NAV.NAV_ITEMS.map((i) => i.href));
  const seen = new Set();
  for (const c of C.OVERVIEW_CARDS) {
    assert.ok(!seen.has(c.id), `duplicate ${c.id}`);
    seen.add(c.id);
    assert.ok(C.parseArrangement({ v: 1, order: [c.id], hidden: [] }), `id ${c.id} must survive parseArrangement`);
    if (c.href) assert.ok(hrefs.has(c.href), `${c.id}: ${c.href} is not in lib/nav.ts`);
    for (const h of [...c.covers, ...(c.links ?? [])]) assert.ok(hrefs.has(h), `${c.id}: ${h} is not in lib/nav.ts`);
    if (c.id !== C.MORE_CARD_ID) assert.ok(V.VIEWS[c.id], `${c.id} has no view in lib/overview-views.ts`);
  }
});

test("cards: every nav page is on the overview, on its own card or on More pages (never Today itself)", () => {
  const hrefs = NAV.NAV_ITEMS.map((i) => i.href);
  const more = C.moreHrefs(hrefs);
  const covered = new Set(C.OVERVIEW_CARDS.flatMap((c) => c.covers));
  for (const h of hrefs) if (h !== "/today") assert.ok(covered.has(h) || more.includes(h), h);
  assert.ok(!more.includes("/today"));
  assert.ok(more.includes("/health/records"), "medical records: a link only, never data");
  // A page added to the nav tomorrow shows up on More pages with no other change.
  assert.ok(C.moreHrefs([...hrefs, "/new-page"]).includes("/new-page"));
});

// ─── what the cards show ─────────────────────────────────────────────────────

const NOW = new Date(2031, 2, 12, 15, 0); // a synthetic local afternoon
const day = (off) => { const d = new Date(NOW); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const at = (off, h) => { const d = new Date(NOW); d.setDate(d.getDate() + off); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const ready = (value) => ({ state: "ready", value });

test("state: loading until every source answered; error only when all failed; stale when one failed", () => {
  assert.equal(V.cardState("money", [{ state: "loading" }, ready({ status: "empty" })], NOW).kind, "loading");
  assert.equal(V.cardState("money", [{ state: "error" }, { state: "error" }], NOW).kind, "error");
  const part = V.cardState("money", [{ state: "error" }, ready({ status: "ready", count: 1, withinDays: 3, soon: [{ merchant: "Synthetic Stream", label: "renews tomorrow" }] })], NOW);
  assert.equal(part.kind, "ready");
  assert.equal(part.stale, true);
  assert.equal(part.view.metrics[0].value, "—");
  assert.equal(part.view.metrics[1].value, "1");
  assert.equal(V.cardState("nope", [], NOW).kind, "error");
});

test("recovery: latest score with its zone word, HRV, tonight's forecast, a 7-night line", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ created_at: at(i - 7, 8), recovery_score: 40 + i * 5, hrv_rmssd_milli: 50 + i }));
  const s = V.cardState("recovery", [ready({ rows }), ready({ prediction: { predicted_hrv: 61.4, prediction_lower: 52, prediction_upper: 70 } })], NOW);
  const [rec, hrv, tonight] = s.view.metrics;
  assert.equal(rec.value, "75");
  assert.equal(rec.tone, "up");
  assert.match(rec.sub, /^Green · Today$/);
  assert.equal(hrv.value, "57");
  assert.equal(tonight.value, "61");
  assert.equal(tonight.sub, "forecast 52–70");
  assert.equal(s.view.chart.values.length, 7);
  const none = V.cardState("recovery", [ready({ rows: [] }), ready({ prediction: null })], NOW).view;
  assert.equal(none.metrics[2].sub, "No forecast yet");
  assert.equal(none.chart, undefined);
});

test("activity: steps per day from Garmin and WHOOP (larger wins), today marked so far", () => {
  const cycles = [
    { start_time: at(-1, 23), end_time: null, timezone_offset: "+00:00", step_count: 4000, strain: 6.2 },
    { start_time: at(-2, 23), end_time: at(-1, 23), timezone_offset: "+00:00", step_count: 9000, strain: 12.5 },
  ];
  const s = V.cardState("activity", [ready({ rows: cycles }), ready({ rows: [{ calendar_date: day(-1), total_steps: 7000 }] })], NOW).view;
  assert.equal(s.metrics[2].value, "6.2");
  assert.equal(s.metrics[2].sub, "so far today");
  assert.equal(s.chart.values.length, 7);
});

test("money: alert count with a word for urgency, renewals, read-only note; no amounts invented", () => {
  const alerts = [{ kind: "low-cash", severity: "high", title: "Cash may run low", detail: "synthetic", href: "/financials/forecast" }, { kind: "budget", severity: "medium", title: "A budget is heading over", detail: "synthetic", href: "/financials/budgets" }];
  const v = V.cardState("money", [ready({ status: "ready", alerts }), ready({ status: "empty" })], NOW).view;
  assert.equal(v.metrics[0].value, "2");
  assert.equal(v.metrics[0].tone, "down");
  assert.match(v.metrics[0].sub, /need action now/);
  assert.equal(v.metrics[1].value, "0");
  assert.deepEqual(v.lines.map((l) => l.text), ["Cash may run low", "A budget is heading over"]);
  assert.match(v.note, /never moves money/);
});

test("habits, agents, status, screen time, calendar: numbers from the synthetic answers", () => {
  const h = V.cardState("habits", [ready({ today: day(0), days: [{ date: day(0), answered: 20, total: 20 }, { date: day(-1), answered: 3, total: 20 }] }), ready({ overview: { book: { title: "A synthetic book" }, percent: 42, chaptersDone: 5, totalChapters: 12, streak: { current: 4, best: 9, loggedToday: false, atRisk: true } } })], NOW).view;
  assert.equal(h.metrics[0].value, "20/20");
  assert.equal(h.metrics[0].sub, "Done today");
  assert.equal(h.metrics[1].value, "42");
  assert.equal(h.metrics[2].sub, "at risk today");
  assert.equal(h.metrics[2].tone, "mid");
  assert.equal(h.lines[0].text, "Yesterday: 3 of 20 answered");

  const a = V.cardState("agents", [ready({ items: [{ kind: "card" }, { kind: "message" }], threads: [{ id: "scout", unread: 2, last: { id: 9, preview: "A synthetic note" } }, { id: "quiet", unread: 0, last: { id: 3 } }] })], NOW).view;
  assert.deepEqual(a.metrics.map((m) => m.value), ["1", "2", "1"]);
  assert.equal(a.lines[0].text, "scout: A synthetic note");

  const st = V.cardState("status", [ready({ sources: { x: { label: "Synthetic A", status: "success" }, y: { label: "Synthetic B", status: "failed" }, z: { label: "Synthetic C", status: "partial" } }, fetchedAt: at(0, 14) })], NOW).view;
  assert.deepEqual(st.metrics.map((m) => m.value), ["1", "1", "1"]);
  assert.deepEqual(st.lines.map((l) => l.text), ["Synthetic B: failed", "Synthetic C: degraded"]);

  const sc = V.cardState("screen-time", [ready({ status: "ready", days: [{ date: day(-2), totalMin: 200, complete: true }, { date: day(-1), totalMin: 135, complete: true }, { date: day(0), totalMin: 20, complete: false }], avgTotalMin: 167.5, avgLateNightMin: 30, completeDays: 2 })], NOW).view;
  assert.equal(sc.metrics[0].value, "2h 15m");
  assert.equal(sc.metrics[0].sub, "Yesterday");
  assert.equal(sc.chart.partialLast, true);
  assert.equal(V.cardState("screen-time", [ready({ status: "empty", sync: null })], NOW).view.note, "The iPhone app hasn't sent any days yet.");

  const cal = V.cardState("calendar", [ready({ status: "ready", events: [], truncated: false, lastSync: null }), ready({ items: [{ id: "c1", title: "Synthetic checkup", due: day(-2), months: 12, booked: false, archived: false, kind: "medical", time: null, tz: "America/New_York", notes: "", completedOn: null }] })], NOW).view;
  assert.equal(cal.metrics[0].value, "0");
  assert.equal(cal.metrics[2].value, "1");
  assert.equal(cal.metrics[2].tone, "down");
  assert.match(cal.lines[0].text, /^Synthetic checkup · 2 days overdue$/);
});

// ─── sources: keys, privacy, cache rules ─────────────────────────────────────

test("sources: every card reads cache keys that follow the rules; private data stays in memory", () => {
  const all = C.OVERVIEW_CARDS.flatMap((c) => S.cardSources(c.id).map((s) => ({ card: c.id, ...s })));
  for (const s of all) {
    assert.ok(s.key.startsWith("/api/") || /^[a-z-]+:[a-z0-9:-]+$/.test(s.key), `${s.card}: ${s.key} is neither a URL nor "<area>:<name>"`);
    assert.ok(s.freshMs >= 60_000, `${s.card}: ${s.key} freshMs`);
    assert.equal(typeof s.check, "function");
    assert.ok(!s.key.startsWith("/api/medical"), "medical records are never read by the overview");
    assert.ok(!s.key.startsWith("/api/experiments"), "the experiment arm is never read by the overview (reading it stamps it revealed)");
  }
  for (const key of ["/api/finance/alerts", "/api/procurement/renewals/summary", "/api/screen-time/summary"]) {
    assert.ok(all.some((s) => s.key === key), key);
    assert.equal(CACHE.isSensitiveKey(key), true, `${key} must stay memory-only`);
  }
  assert.equal(all.find((s) => s.key === "/api/care/items").persist, false);
  // The warm-up stores with default persistence: memory-only sources and Today's own keys are not in it.
  const warm = S.overviewWarmers().map((w) => w.key);
  assert.ok(!warm.includes("/api/care/items"));
  assert.ok(!warm.includes("agents:inbox"));
  for (const w of S.overviewWarmers()) assert.ok(w.freshMs >= 10 * 60_000);
});

test("sources: keys Today also reads are the exact URLs Today uses, so one fetch serves both", () => {
  // Today's own URLs live in TodayClient.tsx and the import-free helpers it reads them from.
  const today = ["app/today/TodayClient.tsx", "lib/money-alerts-view.ts"].filter((f) => fs.existsSync(path.join(SRC, f))).map((f) => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n");
  for (const url of ["/api/reading", "/api/orders/summary", "/api/procurement/renewals/summary", "/api/finance/alerts"]) assert.ok(today.includes(`"${url}"`), url);
  const sources = S.cardSources("calendar").map((s) => s.key);
  assert.ok(sources[0].startsWith("/api/calendar/events?from="), sources[0]);
  assert.ok(today.includes("/api/calendar/events?from=${firstDay}&to=${shiftDate(firstDay, 1)}"));
  assert.ok(S.todayCalendarUrl(NOW).endsWith(`from=${day(0)}&to=${day(1)}`));
});

test("speed rules: one IntersectionObserver, DeferredMount bodies, no chart library, no animation", () => {
  const card = fs.readFileSync(path.join(SRC, "components/overview/OverviewCard.tsx"), "utf8");
  assert.match(card, /new IntersectionObserver/);
  assert.match(card, /DeferredMount/);
  for (const f of ["OverviewCard.tsx", "Spark.tsx", "Overview.tsx"]) {
    const src = fs.readFileSync(path.join(SRC, "components/overview", f), "utf8");
    assert.doesNotMatch(src, /from "recharts"/, `${f}: hand-drawn SVG only`);
    assert.doesNotMatch(src, /animate-/, `${f}: no animation`);
  }
  const wrapper = fs.readFileSync(path.join(SRC, "components/overview/TodayOverview.tsx"), "utf8");
  assert.match(wrapper, /ssr: false/, "the overview is its own chunk, after Today");
});
