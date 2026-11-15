// Run: node --test tests/cash-forecast-store.test.cjs
// Validation + row mapping for the cash forecast inputs (lib/cash-forecast-store.ts). SYNTHETIC DATA ONLY.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const S = loadTs("lib/cash-forecast-store.ts");

const hdrs = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });

test("same-origin JSON only, size capped", () => {
  const ok = hdrs({ origin: "https://onyx.example", host: "onyx.example", "content-type": "application/json", "content-length": "100" });
  assert.equal(S.checkJsonRequest(ok, "https://onyx.example"), null);
  assert.equal(S.checkJsonRequest(hdrs({ host: "onyx.example", "content-type": "application/json" }), "https://onyx.example").status, 403);
  assert.equal(S.checkJsonRequest(hdrs({ origin: "https://evil.example", host: "onyx.example", "content-type": "application/json" }), "https://onyx.example").status, 403);
  assert.equal(S.checkJsonRequest(hdrs({ origin: "https://onyx.example", host: "onyx.example", "content-type": "text/plain" }), "https://onyx.example").status, 415);
  assert.equal(S.checkJsonRequest(hdrs({ origin: "https://onyx.example", host: "onyx.example", "content-type": "application/json", "content-length": "99999" }), "https://onyx.example").status, 413);
});

test("planned item bodies", () => {
  const good = S.parseItemBody({ label: " Demo movers ", date: "2031-03-01", amountCents: -150000, certainty: "confirmed" });
  assert.equal(good.ok, true);
  assert.equal(good.item.label, "Demo movers");
  assert.equal(good.item.repeat_unit, null);
  const rep = S.parseItemBody({ label: "Demo rent", date: "2031-03-01", amountCents: -300000, repeatUnit: "month", repeatCount: 12 });
  assert.equal(rep.item.repeat_every, 1);
  assert.equal(rep.item.repeat_count, 12);
  for (const bad of [
    { label: "", date: "2031-03-01", amountCents: 1 },
    { label: "x", date: "03/01/2031", amountCents: 1 },
    { label: "x", date: "2031-03-01", amountCents: 0 },
    { label: "x", date: "2031-03-01", amountCents: 1.5 },
    { label: "x", date: "2031-03-01", amountCents: 1, certainty: "maybe" },
    { label: "x", date: "2031-03-01", amountCents: 1, repeatUnit: "year", repeatCount: 2 },
    { label: "x", date: "2031-03-01", amountCents: 1, extra: true },
  ]) assert.equal(S.parseItemBody(bad).ok, false, JSON.stringify(bad));
  assert.equal(S.isUuid("6f1d2c3e-1234-4abc-9def-0123456789ab"), true);
  assert.equal(S.isUuid("../etc"), false);
});

test("driver bodies: keys, accounts and value fields are checked", () => {
  const known = new Set(["acct1"]);
  assert.deepEqual(S.parseDriverBody({ key: "settings", value: { bufferCents: 100000 } }, known), { ok: true, key: "settings", value: { bufferCents: 100000 } });
  const c = S.parseDriverBody({ key: "card:acct1", value: { promoEnds: "2031-06-17", standardAprPct: 27.24, promoNote: " estimated " } }, known);
  assert.deepEqual(c.value, { promoEnds: "2031-06-17", standardAprPct: 27.24, promoNote: "estimated" });
  assert.equal(S.parseDriverBody({ key: "card:acct1", value: null }, known).value, null);
  assert.equal(S.parseDriverBody({ key: "card:other", value: {} }, known).ok, false);
  assert.equal(S.parseDriverBody({ key: "settings:x", value: {} }, known).ok, false);
  assert.equal(S.parseDriverBody({ key: "card:acct1", value: { aprPct: 99 } }, known).ok, false);
  assert.equal(S.parseDriverBody({ key: "card:acct1", value: { bufferCents: 1 } }, known).ok, false);
  assert.equal(S.parseDriverBody({ key: "growth:acct1", value: { returnPct: 6, contributionStarts: "2031-01-01" } }, known).ok, true);
});

test("rows map to engine inputs", () => {
  const p = S.itemRowToPlanned({ id: "i1", label: "Demo", item_date: "2031-01-29", amount_cents: "5000", certainty: "likely", repeat_unit: "month", repeat_every: 2, repeat_count: 3, note: null });
  assert.deepEqual(p, { id: "i1", label: "Demo", date: "2031-01-29", amountCents: 5000, certainty: "likely", repeat: { unit: "month", every: 2, count: 3 } });
  const d = S.driversToInputs([
    { key: "settings", value: { bufferCents: 50000 } },
    { key: "card:a", value: { promoEnds: "2031-06-17", promoNote: "estimated" } },
    { key: "growth:b", value: { returnPct: 4 } },
    { key: "junk", value: {} },
  ]);
  assert.equal(d.settings.bufferCents, 50000);
  assert.equal(d.cardTerms[0].promoEnds, "2031-06-17");
  assert.equal(d.cardTerms[0].promoNote, "estimated");
  assert.equal(d.growth[0].returnPct, 4);
});

test("stream adjustments and model settings are stored and mapped", () => {
  const known = new Set();
  assert.deepEqual(S.parseDriverBody({ key: "adjust:0123456789abcdef", value: { from: "2031-01-01", amountCents: -500000 } }, known).value, { from: "2031-01-01", amountCents: -500000 });
  assert.deepEqual(S.parseDriverBody({ key: "adjust:0123456789abcdef", value: { from: "2031-01-01", stop: true } }, known).value, { from: "2031-01-01", stop: true });
  assert.equal(S.parseDriverBody({ key: "adjust:nothex", value: { from: "2031-01-01", stop: true } }, known).ok, false);
  assert.equal(S.parseDriverBody({ key: "settings", value: { lookbackWeeks: 52, cardMonths: 3, lowPercentile: 25 } }, known).ok, true);
  const d = S.driversToInputs([{ key: "settings", value: { lookbackWeeks: 52, cardMonths: 3, lowPercentile: 25 } }, { key: "adjust:0123456789abcdef", value: { from: "2031-01-01", stop: true } }]);
  assert.equal(d.settings.lookbackWeeks, 52);
  assert.equal(d.settings.cardMonths, 3);
  assert.equal(d.settings.lowPercentile, 0.25);
  assert.deepEqual(d.adjustments[0], { streamId: "0123456789abcdef", from: "2031-01-01", stop: true, amountCents: undefined });
});
