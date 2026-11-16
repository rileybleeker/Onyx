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

test("the safe-to-move driver: known accounts only, deduplicated, empty removes it, mapped to the engine", () => {
  const known = new Set(["acct1", "acct2"]);
  assert.deepEqual(S.parseDriverBody({ key: "safe-to-move", value: { leaveOut: ["acct1", "acct2", "acct1"] } }, known), { ok: true, key: "safe-to-move", value: { leaveOut: ["acct1", "acct2"] } });
  assert.deepEqual(S.parseDriverBody({ key: "safe-to-move", value: { leaveOut: [] } }, known), { ok: true, key: "safe-to-move", value: null }, "an empty list removes the driver");
  assert.deepEqual(S.parseDriverBody({ key: "safe-to-move", value: null }, known), { ok: true, key: "safe-to-move", value: null });
  assert.equal(S.parseDriverBody({ key: "safe-to-move", value: { leaveOut: ["other"] } }, known).ok, false, "an unknown account");
  assert.equal(S.parseDriverBody({ key: "safe-to-move", value: { leaveOut: [7] } }, known).ok, false);
  assert.equal(S.parseDriverBody({ key: "safe-to-move", value: { leaveOut: "acct1" } }, known).ok, false);
  assert.equal(S.parseDriverBody({ key: "safe-to-move", value: { leaveOut: ["acct1"], extra: 1 } }, known).ok, false);
  assert.equal(S.parseDriverBody({ key: "safe-to-move", value: { leaveOut: Array.from({ length: S.MAX_LEAVE_OUT + 1 }, () => "acct1") } }, known).ok, false);
  const d = S.driversToInputs([{ key: "settings", value: { bufferCents: 1000 } }, { key: "safe-to-move", value: { leaveOut: ["acct1", 5, "acct2"] } }]);
  assert.deepEqual(d.settings.safeToMoveLeaveOut, ["acct1", "acct2"]);
  assert.equal(d.settings.bufferCents, 1000, "the settings driver is untouched");
  assert.equal("safeToMoveLeaveOut" in S.driversToInputs([{ key: "safe-to-move", value: { leaveOut: [] } }]).settings, false);
});

test("leaving one account out (or counting it again) is merged with the saved list, never replacing it", () => {
  const known = new Set(["acct1", "acct2", "acct3"]);
  assert.deepEqual(S.parseLeaveOutChange({ key: "safe-to-move", account: "acct2", leaveOut: true }, known), { ok: true, account: "acct2", leaveOut: true });
  assert.equal(S.parseLeaveOutChange({ key: "safe-to-move", value: { leaveOut: ["acct1"] } }, known), null, "the whole-list body is parseDriverBody's");
  assert.equal(S.parseLeaveOutChange({ key: "settings", account: "acct1", leaveOut: true }, known), null);
  assert.equal(S.parseLeaveOutChange({ key: "safe-to-move", account: "other", leaveOut: true }, known).ok, false, "an unknown account");
  assert.equal(S.parseLeaveOutChange({ key: "safe-to-move", account: "acct1", leaveOut: "yes" }, known).ok, false);
  assert.equal(S.parseLeaveOutChange({ key: "safe-to-move", account: "acct1", leaveOut: true, value: null }, known).ok, false, "no extra fields");
  // The saved list keeps the other accounts (a page whose drivers read failed sends only its one change).
  assert.deepEqual(S.mergeLeaveOut({ leaveOut: ["acct1"] }, "acct2", true), { ok: true, value: { leaveOut: ["acct1", "acct2"] } });
  assert.deepEqual(S.mergeLeaveOut({ leaveOut: ["acct1", "acct2"] }, "acct1", false), { ok: true, value: { leaveOut: ["acct2"] } });
  assert.deepEqual(S.mergeLeaveOut({ leaveOut: ["acct1"] }, "acct1", true), { ok: true, value: { leaveOut: ["acct1"] } }, "already left out: unchanged");
  assert.deepEqual(S.mergeLeaveOut({ leaveOut: ["acct1"] }, "acct1", false), { ok: true, value: null }, "the last one counted again removes the driver");
  assert.deepEqual(S.mergeLeaveOut(null, "acct3", true), { ok: true, value: { leaveOut: ["acct3"] } }, "nothing saved yet");
  assert.deepEqual(S.mergeLeaveOut({ leaveOut: ["acct1", 7, "acct1"] }, "acct2", true), { ok: true, value: { leaveOut: ["acct1", "acct2"] } }, "junk and repeats are dropped");
  const full = { leaveOut: Array.from({ length: S.MAX_LEAVE_OUT }, (_, i) => `a${i}`) };
  assert.equal(S.mergeLeaveOut(full, "acct1", true).ok, false, "never past the limit");
  assert.equal(S.mergeLeaveOut(full, "a0", false).ok, true);
});

test("rows map to engine inputs", () => {
  const p = S.itemRowToPlanned({ id: "i1", label: "Demo", item_date: "2031-01-29", amount_cents: "5000", certainty: "likely", repeat_unit: "month", repeat_every: 2, repeat_count: 3, note: null });
  assert.deepEqual(p, { id: "i1", label: "Demo", date: "2031-01-29", amountCents: 5000, certainty: "likely", repeat: { unit: "month", every: 2, count: 3 }, account: undefined });
  assert.equal(S.itemRowToPlanned({ id: "i2", label: "To brokerage", item_date: "2031-02-01", amount_cents: -100, certainty: "confirmed", repeat_unit: null, repeat_every: null, repeat_count: null, note: null, account_key: "inv1" }).account, "inv1");
  assert.equal(S.parseItemBody({ label: "x", date: "2031-03-01", amountCents: -1, accountKey: "inv1" }).item.account_key, "inv1");
  assert.equal(S.parseItemBody({ label: "x", date: "2031-03-01", amountCents: -1, accountKey: "../x" }).ok, false);
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
