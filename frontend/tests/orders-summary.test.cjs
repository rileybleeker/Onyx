// Run: node --test tests/orders-summary.test.cjs
// The Today orders summary (app/api/orders/summary/route.ts) reads only the open orders (loadOrders scope "open").
// Pins the query shape, and that the summary's numbers are the same as when every order in the window is read.
// SYNTHETIC DATA ONLY: every merchant, item and date below is invented. No network, no database (the Supabase
// client is a recording stub).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const fakeNext = { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, body, headers: init.headers ?? {} }) } };

// A stand-in for the service client: every chain method is recorded, and awaiting a chain yields the table's rows.
function fakeSupabase(rowsByTable, calls) {
  const chain = (table, data) => {
    const b = {
      then: (ok, fail) => Promise.resolve({ data, error: null }).then(ok, fail),
    };
    for (const m of ["select", "gte", "in", "eq", "order", "limit"]) {
      b[m] = (...args) => {
        calls.push({ table, method: m, args });
        return b;
      };
    }
    return b;
  };
  return { from: (table) => chain(table, rowsByTable[table] ?? []) };
}

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
// A calendar day (America/New_York, as the orders code counts days) that many days from now.
const { etDay } = loadTs("lib/online-orders.ts");
const ahead = (days) => etDay(new Date(Date.now() + days * DAY));
const row = (over) => ({
  order_key: "o:demo-1", aliases: [], merchant_name: "Demo Shop", order_number: "D-1", tracking: [{ number: "1ZDEMO0000000000000", carrier: "UPS", delivered: false }],
  items: ["Demo item"], item_count: 1, status: "shipped", issue: null, partially_delivered: false,
  ordered_at: ago(5), shipped_at: ago(2), out_for_delivery_at: null, delivered_at: null, canceled_at: null,
  expected_date: ahead(1), last_event_at: ago(2), confirms_delivery: false, ships_physically: true, ...over,
});

test("the summary asks for the open orders only, with the summary's columns; the page keeps every column", async () => {
  const loadServer = (calls) => loadTs("lib/online-orders-server.ts", {
    "server-only": {},
    "@supabase/supabase-js": { createClient: () => fakeSupabase({ online_orders: [row({})] }, calls) },
  });

  const openCalls = [];
  await loadServer(openCalls).loadOrders(new Date(), "open");
  const openOrders = openCalls.filter((c) => c.table === "online_orders");
  assert.deepEqual(openOrders.map((c) => c.method), ["select", "gte", "in", "order", "order", "limit"]);
  const select = openOrders[0].args[0];
  assert.doesNotMatch(select, /tracking/);
  assert.match(select, /^order_key,aliases,merchant_name,order_number,items,item_count,status,/);
  assert.deepEqual(openOrders[2].args, ["status", ["ordered", "shipped", "out_for_delivery"]]);
  assert.deepEqual(openOrders[5].args, [1000]);

  const allCalls = [];
  await loadServer(allCalls).loadOrders(new Date());
  const allOrders = allCalls.filter((c) => c.table === "online_orders");
  assert.equal(allOrders.some((c) => c.method === "in"), false);
  assert.match(allOrders[0].args[0], /,tracking,/);
});

test("the summary's answer is the same whether the open orders or every order in the window is read", async () => {
  const everything = [
    row({ order_key: "o:late-1", status: "shipped", expected_date: ahead(-4), confirms_delivery: true, last_event_at: ago(9), shipped_at: ago(9) }),
    row({ order_key: "o:today-1", status: "shipped", expected_date: ahead(0), last_event_at: ago(3), shipped_at: ago(3) }),
    row({ order_key: "o:out-1", status: "out_for_delivery", out_for_delivery_at: ago(0), last_event_at: ago(0), shipped_at: ago(1) }),
    row({ order_key: "o:ordered-1", status: "ordered", order_number: "D-9", ordered_at: ago(8), last_event_at: ago(8), shipped_at: null, expected_date: null }),
    row({ order_key: "o:done-1", status: "delivered", delivered_at: ago(1), last_event_at: ago(1), expected_date: ahead(0) }),
    row({ order_key: "o:gone-1", status: "canceled", canceled_at: ago(1), last_event_at: ago(1), expected_date: ahead(0) }),
    row({ order_key: "o:hidden-1", status: "shipped", expected_date: ahead(0), last_event_at: ago(2), shipped_at: ago(2) }),
  ];
  const openOnly = everything.filter((r) => ["ordered", "shipped", "out_for_delivery"].includes(r.status));
  // The mark hides one open order (a mark can only close or mark arrived; it never adds a row).
  const marks = [{ alias_key: "o:hidden-1", received_at: null, hidden: true, updated_at: ago(1) }];

  const summaryFor = async (orderRows, scopeSeen) => {
    const route = loadTs("app/api/orders/summary/route.ts", {
      "next/server": fakeNext,
      "@/lib/online-orders-server": {
        loadOrders: async (now, scope) => {
          scopeSeen.push(scope);
          // The loader's own filter is what the query above does; here the rows are parsed the way the loader parses them.
          const P = loadTs("lib/online-orders.ts");
          return {
            state: "ready",
            orders: orderRows.map((r) => P.parseOrderRow(r)),
            marks: marks.map((m) => P.parseMarkRow(m)),
            lastSync: null,
          };
        },
      },
    });
    const res = await route.GET();
    return res.body;
  };

  const seen = [];
  const fromOpen = await summaryFor(openOnly, seen);
  const fromAll = await summaryFor(everything, []);
  assert.deepEqual(seen, ["open"]);
  assert.equal(fromOpen.status, "ready");
  assert.deepEqual(fromOpen, fromAll);
  assert.equal(fromOpen.attention, 2);
  // o:today-1 (expected today) and o:out-1 (out for delivery today) both arrive today.
  assert.equal(fromOpen.arrivingToday, 2);
  assert.equal(fromOpen.onTheWay, 2);
});

test("the summary route passes the open scope and no-store, and a not-connected or failed read answers as before", async () => {
  const seen = [];
  const route = loadTs("app/api/orders/summary/route.ts", {
    "next/server": fakeNext,
    "@/lib/online-orders-server": { loadOrders: async (now, scope) => { seen.push(scope); return { state: "error" }; } },
  });
  const failed = await route.GET();
  assert.deepEqual([failed.status, failed.headers["Cache-Control"]], [500, "no-store"]);
  assert.deepEqual(seen, ["open"]);
  const missing = loadTs("app/api/orders/summary/route.ts", {
    "next/server": fakeNext,
    "@/lib/online-orders-server": { loadOrders: async () => ({ state: "not_connected", lastSync: null }) },
  });
  assert.deepEqual((await missing.GET()).body, { status: "not_connected" });
});
