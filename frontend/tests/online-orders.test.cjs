// Run: node --test tests/online-orders.test.cjs
// /orders logic (lib/online-orders.ts): row parsing, the read-time "on the way / needs attention /
// no delivery email / delivered" rules, marks matched by alias, the PATCH request checks, tracking
// links, and that the new routes stay behind the owner session (not in middleware's CI carve-out).
// SYNTHETIC DATA ONLY: invented stores, items and numbers; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const L = loadTs("lib/online-orders.ts");

// 2026-03-10 15:00 ET
const NOW = new Date("2026-03-10T19:00:00Z");

function order(over = {}) {
  return L.parseOrderRow({
    order_key: "o:store.example:1001",
    aliases: ["o:store.example:1001", "t:1Z999AA10123456784"],
    merchant_name: "Example Store",
    order_number: "1001",
    tracking: [{ number: "1Z999AA10123456784", carrier: "UPS", delivered: false }],
    items: ["Blue Widget"],
    item_count: 1,
    status: "shipped",
    issue: null,
    partially_delivered: false,
    ordered_at: "2026-03-05T14:00:00Z",
    shipped_at: "2026-03-07T14:00:00Z",
    out_for_delivery_at: null,
    delivered_at: null,
    canceled_at: null,
    expected_date: null,
    last_event_at: "2026-03-07T14:00:00Z",
    confirms_delivery: true,
    ships_physically: true,
    ...over,
  });
}
const state = (o, mark = null, now = NOW) => L.classifyOrder(o, mark, now);

test("parseOrderRow keeps valid rows and rejects broken ones", () => {
  const o = order();
  assert.equal(o.key, "o:store.example:1001");
  assert.equal(o.tracking[0].carrier, "UPS");
  assert.equal(L.parseOrderRow({ order_key: "x", status: "lost", last_event_at: "2026-03-01T00:00:00Z" }), null);
  assert.equal(L.parseOrderRow({ order_key: "x", status: "shipped" }), null);
  assert.equal(L.parseOrderRow(null), null);
  const bad = order({ tracking: [{ number: "" }, "x", { number: "TBA123456789012", carrier: null }], items: ["", 3, "Cup"] });
  assert.deepEqual(bad.tracking.map((t) => t.number), ["TBA123456789012"]);
  assert.deepEqual(bad.items, ["Cup"]);
  assert.ok(order({ aliases: [] }).aliases.includes("o:store.example:1001"));
});

test("shipped with an expected date: on the way, then needs attention 2 days after", () => {
  assert.equal(state(order({ expected_date: "2026-03-10" })).state, "arriving");
  assert.equal(state(order({ expected_date: "2026-03-10" })).reason, "Arriving today");
  assert.equal(state(order({ expected_date: "2026-03-11" })).reason, "Arriving tomorrow");
  assert.equal(state(order({ expected_date: "2026-03-09" })).state, "arriving");     // 1 day late: grace
  const late = state(order({ expected_date: "2026-03-08" }));
  assert.equal(late.state, "attention");
  assert.match(late.reason, /Was due Mar 8; no delivery email yet/);
});

test("a store that never emails on delivery goes to 'no delivery email', not attention", () => {
  const c = state(order({ expected_date: "2026-03-01", confirms_delivery: false, shipped_at: "2026-02-27T14:00:00Z" }));
  assert.equal(c.state, "unconfirmed");
  const noDate = state(order({ confirms_delivery: false, shipped_at: "2026-02-25T14:00:00Z" }));
  assert.equal(noDate.state, "unconfirmed");
});

test("shipped with no date: on the way for 10 days, then attention", () => {
  assert.equal(state(order({ shipped_at: "2026-03-01T14:00:00Z" })).state, "arriving");     // 9 days
  const c = state(order({ shipped_at: "2026-02-28T14:00:00Z" }));                           // 10 days
  assert.equal(c.state, "attention");
  assert.match(c.reason, /Shipped Feb 28, 10 days ago/);
});

test("old open orders drop off after 30 days", () => {
  assert.equal(state(order({ shipped_at: "2026-02-01T14:00:00Z" })).state, "closed");
  assert.equal(state(order({ status: "ordered", shipped_at: null, ordered_at: "2026-01-10T14:00:00Z" })).state, "closed");
});

test("out for delivery for 2+ days without a delivery email needs attention", () => {
  const o = order({ status: "out_for_delivery", out_for_delivery_at: "2026-03-08T12:00:00Z" });
  assert.equal(state(o).state, "attention");
  assert.equal(state(order({ status: "out_for_delivery", out_for_delivery_at: "2026-03-10T12:00:00Z" })).reason, "Out for delivery");
});

test("a reported problem needs attention; a delay is shown as running late", () => {
  assert.equal(state(order({ issue: "exception" })).state, "attention");
  const d = state(order({ issue: "delayed", expected_date: "2026-03-12" }));
  assert.equal(d.state, "arriving");
  assert.match(d.reason, /^Running late\. Arriving Mar 12/);
});

test("ordered but not shipped: attention after 7 days only for stores that ship and with an order number", () => {
  const base = { status: "ordered", shipped_at: null, tracking: [] };
  assert.equal(state(order({ ...base, ordered_at: "2026-03-06T14:00:00Z" })).state, "processing");
  assert.equal(state(order({ ...base, ordered_at: "2026-03-02T14:00:00Z" })).state, "attention");
  assert.equal(state(order({ ...base, ordered_at: "2026-03-02T14:00:00Z", order_number: null })).state, "processing");
  assert.equal(state(order({ ...base, ordered_at: "2026-03-02T14:00:00Z", ships_physically: false })).state, "processing");
  assert.equal(state(order({ ...base, ordered_at: "2026-02-20T14:00:00Z", ships_physically: false })).state, "closed");
});

test("delivered and canceled are listed for 30 days", () => {
  assert.equal(state(order({ status: "delivered", delivered_at: "2026-03-09T20:00:00Z" })).state, "delivered");
  assert.equal(state(order({ status: "delivered", delivered_at: "2026-01-09T20:00:00Z" })).state, "closed");
  assert.equal(state(order({ status: "canceled", canceled_at: "2026-03-09T20:00:00Z" })).state, "canceled");
});

test("marks: Got it delivers, Hide closes, and a mark on any alias counts", () => {
  const o = order({ shipped_at: "2026-02-20T14:00:00Z" });
  assert.equal(state(o).state, "attention");
  const byTracking = { aliasKey: "t:1Z999AA10123456784", receivedAt: "2026-03-09T12:00:00Z", hidden: false, updatedAt: "2026-03-09T12:00:00Z" };
  const marks = new Map([[byTracking.aliasKey, byTracking]]);
  const c = state(o, L.markFor(o, marks));
  assert.equal(c.state, "delivered");
  assert.equal(c.markedReceived, true);
  assert.equal(state(o, { aliasKey: o.key, receivedAt: null, hidden: true, updatedAt: "x" }).state, "closed");
  // a delivery email beats a mark
  assert.equal(state(order({ status: "delivered", delivered_at: "2026-03-09T20:00:00Z" }), byTracking).markedReceived, false);
});

test("applyMark replaces marks on every alias and undo removes them", () => {
  const o = order();
  const old = [{ aliasKey: "t:1Z999AA10123456784", receivedAt: null, hidden: true, updatedAt: "a" }, { aliasKey: "o:other:1", receivedAt: null, hidden: true, updatedAt: "a" }];
  const got = L.applyMark(old, o, "received", "2026-03-10T00:00:00Z");
  assert.deepEqual(got.map((m) => m.aliasKey).sort(), ["o:other:1", "o:store.example:1001"]);
  assert.equal(got.find((m) => m.aliasKey === o.key).receivedAt, "2026-03-10T00:00:00Z");
  assert.deepEqual(L.applyMark(got, o, "undo", "x").map((m) => m.aliasKey), ["o:other:1"]);
});

test("groupOrders sorts each list and counts what arrives today", () => {
  const g = L.groupOrders([
    order({ order_key: "o:a:1", aliases: ["o:a:1"], expected_date: "2026-03-12", last_event_at: "2026-03-08T00:00:00Z" }),
    order({ order_key: "o:a:2", aliases: ["o:a:2"], expected_date: "2026-03-10", last_event_at: "2026-03-07T00:00:00Z" }),
    order({ order_key: "o:a:3", aliases: ["o:a:3"], status: "delivered", delivered_at: "2026-03-09T00:00:00Z" }),
    order({ order_key: "o:a:4", aliases: ["o:a:4"], shipped_at: "2026-02-25T00:00:00Z" }),
  ], [], NOW);
  assert.deepEqual(g.arriving.map((c) => c.order.key), ["o:a:2", "o:a:1"]);
  assert.equal(g.arrivingToday, 1);
  assert.deepEqual(g.attention.map((c) => c.order.key), ["o:a:4"]);
  assert.deepEqual(g.recent.map((c) => c.order.key), ["o:a:3"]);
});

test("ET calendar days: 11:30 PM ET is still the same day", () => {
  assert.equal(L.etDay("2026-03-11T03:30:00Z"), "2026-03-10");
  assert.equal(L.daysBetween("2026-02-28", "2026-03-02"), 2);
});

test("itemsLabel and tracking links", () => {
  assert.equal(L.itemsLabel(order({ items: ["Cup", "Plate"], item_count: 4 })), "Cup and 3 more");
  assert.equal(L.itemsLabel(order({ items: [] })), "Order 1001");
  assert.equal(L.trackingUrl({ number: "1Z999AA10123456784", carrier: "UPS" }), "https://www.ups.com/track?tracknum=1Z999AA10123456784");
  assert.equal(L.trackingUrl({ number: "TBA123456789012", carrier: "Amazon" }), "https://track.amazon.com/tracking/TBA123456789012");
  assert.match(L.trackingUrl({ number: "9400100000000000000000", carrier: "USPS" }), /^https:\/\/tools\.usps\.com\//);
  assert.match(L.trackingUrl({ number: "123456789012", carrier: "FedEx" }), /^https:\/\/www\.fedex\.com\//);
  assert.equal(L.trackingUrl({ number: "123456789012", carrier: null }), null);
  assert.equal(L.trackingUrl({ number: "javascript:alert(1)", carrier: "UPS" }), null);
});

test("PATCH checks: order key shape, exact body, same origin + JSON", () => {
  assert.equal(L.parseOrderKey(encodeURIComponent("o:store.example:1001")), "o:store.example:1001");
  assert.equal(L.parseOrderKey("t:TBA123"), "t:TBA123");
  for (const bad of ["", "x:1", "o:../../etc", "o:a b", "%E0%A4%A", "o:" + "a".repeat(250)]) assert.equal(L.parseOrderKey(bad), null, bad);
  assert.deepEqual(L.parseMarkBody({ action: "received" }), { ok: true, action: "received" });
  for (const bad of [null, [], {}, { action: "delete" }, { action: "hide", extra: 1 }, "hide"]) assert.equal(L.parseMarkBody(bad).ok, false);
  const h = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
  const ok = h({ origin: "https://onyx.example", host: "onyx.example", "content-type": "application/json", "content-length": "20" });
  assert.equal(L.checkMarkRequest(ok, "https://onyx.example/api/orders/x"), null);
  assert.equal(L.checkMarkRequest(h({ host: "onyx.example", "content-type": "application/json" }), "https://onyx.example").status, 403);
  assert.equal(L.checkMarkRequest(h({ origin: "https://evil.example", host: "onyx.example", "content-type": "application/json" }), "https://onyx.example").status, 403);
  assert.equal(L.checkMarkRequest(h({ origin: "https://onyx.example", host: "onyx.example", "content-type": "text/plain" }), "https://onyx.example").status, 415);
  assert.equal(L.checkMarkRequest(h({ origin: "https://onyx.example", host: "onyx.example", "content-type": "application/json", "content-length": "9999" }), "https://onyx.example").status, 413);
});

test("the orders routes are not in middleware's CI carve-out and the reader is server-only", () => {
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  // Only the Amazon import path is token-reachable; the page, summary and PATCH stay session-only.
  const orderPaths = [...new Set(mw.match(/\/api\/orders[^"']*/g) || [])];
  assert.deepEqual(orderPaths, ["/api/orders/amazon/import"]);
  assert.doesNotMatch(mw, /startsWith\("\/api\/orders/);
  const server = fs.readFileSync(path.join(SRC, "lib/online-orders-server.ts"), "utf8");
  assert.match(server, /^import "server-only";/);
  const page = fs.readFileSync(path.join(SRC, "app/orders/page.tsx"), "utf8");
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.doesNotMatch(page, /revalidate/);
});

// ─── 2026-11-12 review regressions ───────────────────────────────────────────

test("review 5: out for delivery beats an older, passed estimate", () => {
  const o = order({ status: "out_for_delivery", expected_date: "2026-03-04", out_for_delivery_at: "2026-03-10T12:00:00Z" });
  const c = state(o);
  assert.equal(c.state, "arriving");
  assert.equal(c.reason, "Out for delivery");
});

test("review 6: a delay before shipping stays under ordered, marked running late", () => {
  const c = state(order({ status: "ordered", issue: "delayed", shipped_at: null, tracking: [], ordered_at: "2026-03-08T14:00:00Z" }));
  assert.equal(c.state, "processing");
  assert.match(c.reason, /^Running late\. Ordered Mar 8/);
  assert.equal(state(order({ status: "ordered", issue: "exception", shipped_at: null, tracking: [] })).state, "attention");
});

test("review 12: a failed save restores only that order's marks", () => {
  const a = order({ order_key: "o:a:1", aliases: ["o:a:1"] });
  const b = order({ order_key: "o:b:2", aliases: ["o:b:2"] });
  let marks = [];
  const priorA = marks.filter((m) => a.aliases.includes(m.aliasKey));
  marks = L.applyMark(marks, a, "received", "t1");
  marks = L.applyMark(marks, b, "hide", "t2");
  // A's save fails: restore A only (what OrdersClient does)
  marks = [...marks.filter((m) => !a.aliases.includes(m.aliasKey)), ...priorA];
  assert.deepEqual(marks.map((m) => m.aliasKey), ["o:b:2"]);
});

test("review 9: the PATCH route finds an order by any alias and stores under its current key", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/orders/[key]/route.ts"), "utf8");
  assert.match(route, /\.contains\("aliases", \[key\]\)/);
  assert.match(route, /alias_key: current/);
});

// ─── personal Amazon orders (lib/amazon-orders.ts) ───────────────────────────

const A = loadTs("lib/amazon-orders.ts");
const amz = (over = {}) => ({ order_number: "111-1111111-1111111", ordered_on: "2026-11-10", status: "shipped", status_on: null,
  expected_on: "2026-11-21", delayed: false, items: ["Example Trash Bags"], ...over });

test("amazon import: validates orders and rejects amounts, bad numbers and dates", () => {
  const ok = A.parseAmazonImport({ orders: [amz({ items: ["Example Bags", "Thing $12.99", "x"] })], scanned: 3, unparsed: 1 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.orders[0].items, ["Example Bags"]);
  assert.equal(ok.unparsed, 1);
  for (const bad of [{}, { orders: "x" }, { orders: [amz({ order_number: "12345" })] }, { orders: [amz({ status: "lost" })] },
    { orders: [amz({ ordered_on: "2026-02-30" })] }, { orders: Array(61).fill(amz()) }]) assert.equal(A.parseAmazonImport(bad).ok, false);
  const err = A.parseAmazonImport({ error: "Amazon session expired" });
  assert.equal(err.kind, "error");
});

test("amazon import: events are keyed so the first-seen time sticks and a new date is a new event", () => {
  const e1 = A.eventsFor(amz(), "2026-11-12T03:00:00.000Z");
  assert.deepEqual(e1.map((e) => e.message_id), ["amazon-web:111-1111111-1111111:ordered", "amazon-web:111-1111111-1111111:shipped:2026-11-21"]);
  assert.equal(e1[0].merchant_key, "amazon.com");
  assert.equal(e1[1].expected_date, "2026-11-21");
  const late = A.eventsFor(amz({ delayed: true, expected_on: "2026-11-25" }), "2026-11-20T03:00:00.000Z");
  assert.ok(late.some((e) => e.status === "delayed" && e.message_id.endsWith(":delayed:2026-11-25")));
  const del = A.eventsFor(amz({ status: "delivered", status_on: "2026-11-11", expected_on: null }), "2026-11-12T03:00:00.000Z");
  assert.equal(del[1].received_at, "2026-11-11T21:00:00+00:00");
  for (const e of [...e1, ...late, ...del]) assert.ok(!("total" in e) && e.subject === null);
});

test("amazon import: an undated delivery (same-day) is dated to the order day, not the harvest", () => {
  const e = A.eventsFor(amz({ status: "delivered", status_on: null, expected_on: null, ordered_on: "2026-10-23" }), "2026-11-13T03:50:00.000Z");
  assert.equal(e[1].received_at, "2026-10-23T21:00:00+00:00");
});
