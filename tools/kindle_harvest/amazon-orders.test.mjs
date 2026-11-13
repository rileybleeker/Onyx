// node --test tools/kindle_harvest/amazon-orders.test.mjs
// Synthetic order cards only: invented order numbers, items and dates (the repo is public).
import assert from "node:assert/strict";
import test from "node:test";
import { parseOrderCard, resolveDay } from "./amazon-orders.mjs";

const card = (...lines) => lines.join("\n");
const HEAD = (date, num) => ["ORDER PLACED", date, "TOTAL", "$12.34", "SHIP TO", "Pat Example", `ORDER # ${num}`, "View order details  View invoice"];

test("arriving range uses the last date as the expected day", () => {
  const o = parseOrderCard(card(...HEAD("November 10, 2026", "111-1111111-1111111"), "Arriving November 17 - November 21",
    "Example Trash Bags, 40ct | Tall Kitchen Bags", "Buy it again", "Track package"), "2026-11-12");
  assert.deepEqual(o, { order_number: "111-1111111-1111111", ordered_on: "2026-11-10", status: "shipped", status_on: null,
    expected_on: "2026-11-21", delayed: false, items: ["Example Trash Bags, 40ct"] });
});

test("delivered with a date; several items; quantity badges and prices skipped", () => {
  const o = parseOrderCard(card(...HEAD("October 20, 2026", "111-2222222-2222222"), "Delivered October 21",
    "Your package was left near the front door or porch.", "2", "Example Mouthwash Twin Pack", "Return or replace items: Eligible through November 20, 2026",
    "Buy it again", "Example Body Scrub, 30 oz", "Return or replace items: Eligible through November 20, 2026", "Buy it again"), "2026-11-12");
  assert.equal(o.status, "delivered");
  assert.equal(o.status_on, "2026-10-21");
  assert.deepEqual(o.items, ["Example Mouthwash Twin Pack", "Example Body Scrub, 30 oz"]);
});

test("delivered without a date (same-day delivery) still counts as delivered", () => {
  const o = parseOrderCard(card(...HEAD("October 23, 2026", "111-3333333-3333333"), "Amazon Now Delivery",
    "Your package was left near the front door or porch.", "6", "Track Package"), "2026-11-12");
  assert.equal(o.status, "delivered");
  assert.equal(o.status_on, null);
});

test("running late / now arriving marks a delay with the new date", () => {
  const o = parseOrderCard(card(...HEAD("November 1, 2026", "111-4444444-4444444"), "Now arriving November 9",
    "Example Widget", "Buy it again"), "2026-11-05");
  assert.equal(o.delayed, true);
  assert.equal(o.expected_on, "2026-11-09");
});

test("arriving tomorrow, out for delivery, not yet shipped, cancelled", () => {
  const p = (s) => parseOrderCard(card(...HEAD("November 11, 2026", "111-5555555-5555555"), s, "Example Thing", "Buy it again"), "2026-11-12");
  assert.equal(p("Arriving tomorrow").expected_on, "2026-11-13");
  assert.equal(p("Out for delivery").status, "out_for_delivery");
  assert.equal(p("Not yet shipped").status, "ordered");
  assert.equal(p("Cancelled").status, "canceled");
});

test("a status date in January after a December order rolls into the next year", () => {
  assert.equal(resolveDay("January 3", new Date("2026-12-28T00:00:00Z")), "2027-01-03");
  const o = parseOrderCard(card(...HEAD("December 28, 2026", "111-6666666-6666666"), "Arriving January 3", "Example", "Buy it again"), "2026-12-29");
  assert.equal(o.expected_on, "2027-01-03");
});

test("never returns the total, the recipient or an address line as an item", () => {
  const o = parseOrderCard(card(...HEAD("November 10, 2026", "111-7777777-7777777"), "Delivered November 11", "$19.99", "Buy it again"), "2026-11-12");
  assert.deepEqual(o.items, []);
  assert.ok(!JSON.stringify(o).includes("Pat Example"));
  assert.ok(!JSON.stringify(o).includes("12.34"));
});

test("cards without an order number or a known status are skipped", () => {
  assert.equal(parseOrderCard("Recommended for you\nBuy it again", "2026-11-12"), null);
  assert.equal(parseOrderCard(card(...HEAD("November 10, 2026", "111-8888888-8888888"), "Something new"), "2026-11-12"), null);
});

test("long titles are cut at the first ' | ' and to 90 characters", () => {
  const long = "Example " + "Very Long Product Name ".repeat(8);
  const o = parseOrderCard(card(...HEAD("November 10, 2026", "111-9999999-9999999"), "Delivered November 11", long, "Buy it again"), "2026-11-12");
  assert.ok(o.items[0].length <= 90);
});
