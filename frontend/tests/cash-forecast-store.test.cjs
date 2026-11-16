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

test("the safe-to-move driver: never written as a whole list (that would bypass the compare-and-swap), mapped to the engine", () => {
  const known = new Set(["acct1", "acct2"]);
  for (const value of [{ leaveOut: ["acct1", "acct2"] }, { leaveOut: [] }, null]) {
    assert.equal(S.parseDriverBody({ key: "safe-to-move", value }, known).ok, false, `whole list ${JSON.stringify(value)} refused`);
    assert.equal(S.parseLeaveOutChange({ key: "safe-to-move", value }, known).ok, false, "and refused by the per-account parser too");
  }
  const d = S.driversToInputs([{ key: "settings", value: { bufferCents: 1000 } }, { key: "safe-to-move", value: { leaveOut: ["acct1", 5, "acct2"] } }]);
  assert.deepEqual(d.settings.safeToMoveLeaveOut, ["acct1", "acct2"]);
  assert.equal(d.settings.bufferCents, 1000, "the settings driver is untouched");
  assert.equal("safeToMoveLeaveOut" in S.driversToInputs([{ key: "safe-to-move", value: { leaveOut: [] } }]).settings, false);
});

test("leaving one account out (or counting it again) is merged with the saved list, never replacing it", () => {
  const known = new Set(["acct1", "acct2", "acct3"]);
  assert.deepEqual(S.parseLeaveOutChange({ key: "safe-to-move", account: "acct2", leaveOut: true }, known), { ok: true, account: "acct2", leaveOut: true });
  assert.equal(S.parseLeaveOutChange({ key: "safe-to-move", value: { leaveOut: ["acct1"] } }, known).ok, false, "the whole-list body is refused, not passed on");
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

// ─── the compare-and-swap (applyLeaveOut) against an in-memory row with a version ──────────────────
/**
 * One "safe-to-move" row with a version, as the server store keeps it: every write names the version it read and
 * fails ("conflict") when the row has moved on. Each function in `hooks` runs once, just before the next write lands
 * (another tab committing in between), so a race is staged deterministically.
 */
function memoryStore(initial = null) {
  const box = { row: initial ? { value: initial, version: "v0" } : null, n: 0, reads: 0, writes: 0, failRead: false, failWrite: false };
  const hooks = [];
  const bump = (value) => {
    box.n += 1;
    box.row = value === null ? null : { value: JSON.parse(JSON.stringify(value)), version: `v${box.n}` };
  };
  const beforeWrite = async () => {
    box.writes += 1;
    const h = hooks.shift();
    if (h) await h();
  };
  const store = {
    async read() {
      box.reads += 1;
      if (box.failRead) return { ok: false };
      return { ok: true, row: box.row ? { value: JSON.parse(JSON.stringify(box.row.value)), version: box.row.version } : null };
    },
    async insert(value) {
      await beforeWrite();
      if (box.failWrite) return "error";
      if (box.row) return "conflict";
      bump(value);
      return "ok";
    },
    async update(version, value) {
      await beforeWrite();
      if (box.failWrite) return "error";
      if (!box.row || box.row.version !== version) return "conflict";
      bump(value);
      return "ok";
    },
    async remove(version) {
      await beforeWrite();
      if (box.failWrite) return "error";
      if (!box.row || box.row.version !== version) return "conflict";
      bump(null);
      return "ok";
    },
  };
  return { store, box, hooks, saved: () => (box.row ? box.row.value.leaveOut : []) };
}

test("leave out: one account's change is written only while the saved row is still the version read", async () => {
  const m = memoryStore({ leaveOut: ["acct1"] });
  assert.deepEqual(await S.applyLeaveOut(m.store, "acct2", true), { ok: true });
  assert.deepEqual(m.saved(), ["acct1", "acct2"]);
  assert.deepEqual(await S.applyLeaveOut(m.store, "acct1", false), { ok: true });
  assert.deepEqual(m.saved(), ["acct2"]);
  assert.deepEqual(await S.applyLeaveOut(m.store, "acct2", false), { ok: true });
  assert.equal(m.box.row, null, "the last one counted again removes the row");
  const writes = m.box.writes;
  assert.deepEqual(await S.applyLeaveOut(m.store, "acct3", false), { ok: true }, "counting again with nothing saved");
  assert.equal(m.box.writes, writes, "writes nothing");
  assert.deepEqual(await S.applyLeaveOut(m.store, "acct3", true), { ok: true });
  assert.deepEqual(m.saved(), ["acct3"], "inserted when nothing was saved");
  const before = m.box.writes;
  assert.deepEqual(await S.applyLeaveOut(m.store, "acct3", true), { ok: true });
  assert.equal(m.box.writes, before, "already the saved list: nothing written");
});

test("leave out: two tabs changing DIFFERENT accounts at the same moment both keep their change", async () => {
  // Tab A reads ["acct1"]; tab B leaves acct3 out and commits before A writes. A's write conflicts, A reads again
  // and re-applies its one change on top of B's, so both survive.
  const m = memoryStore({ leaveOut: ["acct1"] });
  m.hooks.push(async () => assert.deepEqual(await S.applyLeaveOut(m.store, "acct3", true), { ok: true }, "tab B"));
  assert.deepEqual(await S.applyLeaveOut(m.store, "acct2", true), { ok: true }, "tab A");
  assert.equal(m.hooks.length, 0, "tab B ran between A's read and A's write");
  assert.deepEqual([...m.saved()].sort(), ["acct1", "acct2", "acct3"]);
  // Counting one again while another tab leaves a different one out: both stand.
  const r = memoryStore({ leaveOut: ["acct1", "acct2"] });
  r.hooks.push(async () => assert.deepEqual(await S.applyLeaveOut(r.store, "acct3", true), { ok: true }));
  assert.deepEqual(await S.applyLeaveOut(r.store, "acct1", false), { ok: true });
  assert.equal(r.hooks.length, 0, "the other tab ran");
  assert.deepEqual([...r.saved()].sort(), ["acct2", "acct3"], "acct1 counted again, acct3 left out, acct2 untouched");
  // Both tabs creating the first row: the second insert conflicts and is re-applied as an update.
  const e = memoryStore(null);
  e.hooks.push(async () => assert.deepEqual(await S.applyLeaveOut(e.store, "acct1", true), { ok: true }));
  assert.deepEqual(await S.applyLeaveOut(e.store, "acct2", true), { ok: true });
  assert.equal(e.hooks.length, 0, "the other tab ran");
  assert.deepEqual([...e.saved()].sort(), ["acct1", "acct2"]);
  // Counting the last one again while another tab leaves one out: the removal conflicts, the addition is kept.
  const d = memoryStore({ leaveOut: ["acct1"] });
  d.hooks.push(async () => assert.deepEqual(await S.applyLeaveOut(d.store, "acct2", true), { ok: true }));
  assert.deepEqual(await S.applyLeaveOut(d.store, "acct1", false), { ok: true });
  assert.equal(d.hooks.length, 0, "the other tab ran");
  assert.deepEqual(d.saved(), ["acct2"]);
});

test("leave out: two changes to the SAME account apply in turn, and the one committing last decides", async () => {
  // A reads ["acct1", "acct2"] and counts acct2 again (a real change, so A writes). Between A's read and A's write,
  // tab B commits three changes: counts acct2 again, leaves acct3 out, leaves acct2 out again. A's write conflicts;
  // A reads again and re-applies its one change to the list as B left it, so acct2 ends counted (A committed last)
  // and B's acct3 is kept. A blind write of A's first merge would have saved ["acct1"] and lost acct3.
  const m = memoryStore({ leaveOut: ["acct1", "acct2"] });
  let ran = false;
  m.hooks.push(async () => {
    assert.deepEqual(await S.applyLeaveOut(m.store, "acct2", false), { ok: true }, "B counts acct2 again");
    assert.deepEqual(m.saved(), ["acct1"], "B's first change was written");
    assert.deepEqual(await S.applyLeaveOut(m.store, "acct3", true), { ok: true }, "B leaves acct3 out");
    assert.deepEqual(await S.applyLeaveOut(m.store, "acct2", true), { ok: true }, "B leaves acct2 out again");
    assert.deepEqual([...m.saved()].sort(), ["acct1", "acct2", "acct3"], "B's last change was written");
    ran = true;
  });
  assert.deepEqual(await S.applyLeaveOut(m.store, "acct2", false), { ok: true }, "A commits last");
  assert.equal(ran, true, "the competing tab ran between A's read and A's write");
  assert.equal(m.hooks.length, 0);
  assert.deepEqual([...m.saved()].sort(), ["acct1", "acct3"], "A's change decides acct2, applied on top of B's, never on a stale copy");
  assert.equal(m.box.reads, 5, "A read twice (again after the conflict), B three times");
  assert.equal(m.box.writes, 5, "B wrote three times, A twice (its first write conflicted)");
});

test("leave out: bounded retry, then 409 with nothing of this change saved; a failed read or write saves nothing", async () => {
  const m = memoryStore({ leaveOut: ["acct1"] });
  // Another change lands before every one of this request's writes.
  for (let i = 0; i < S.LEAVE_OUT_ATTEMPTS; i++) {
    m.hooks.push(async () => {
      m.box.row = { ...m.box.row, version: `other${i}` };
    });
  }
  const out = await S.applyLeaveOut(m.store, "acct2", true);
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.deepEqual(m.saved(), ["acct1"], "acct2 was not left out");
  assert.equal(m.box.writes, S.LEAVE_OUT_ATTEMPTS, "exactly the bounded number of tries");
  const fr = memoryStore({ leaveOut: ["acct1"] });
  fr.box.failRead = true;
  assert.deepEqual(await S.applyLeaveOut(fr.store, "acct2", true), { ok: false, status: 500, error: "could not save" });
  assert.equal(fr.box.writes, 0, "a failed read writes nothing");
  const fw = memoryStore({ leaveOut: ["acct1"] });
  fw.box.failWrite = true;
  assert.equal((await S.applyLeaveOut(fw.store, "acct2", true)).status, 500);
  assert.deepEqual(fw.saved(), ["acct1"]);
  const full = memoryStore({ leaveOut: Array.from({ length: S.MAX_LEAVE_OUT }, (_, i) => `a${i}`) });
  assert.equal((await S.applyLeaveOut(full.store, "acct1", true)).status, 400, "never past the limit");
});

test("leave out: every write's version is new, also within one millisecond and past stored microseconds", () => {
  const now = Date.parse("2030-06-15T16:00:00.000Z");
  assert.equal(S.nextLeaveOutVersion(null, now), "2030-06-15T16:00:00.000Z");
  assert.equal(S.nextLeaveOutVersion("2030-06-15T15:00:00+00:00", now), "2030-06-15T16:00:00.000Z");
  assert.equal(S.nextLeaveOutVersion("2030-06-15T16:00:00.000+00:00", now), "2030-06-15T16:00:00.001Z", "same millisecond: one later");
  assert.equal(S.nextLeaveOutVersion("2030-06-15T16:00:00.000456+00:00", now), "2030-06-15T16:00:00.001Z", "after a stored time with microseconds");
  assert.equal(S.nextLeaveOutVersion("2030-06-15T17:00:00+00:00", now), "2030-06-15T17:00:00.001Z", "a stored time ahead of this clock");
  assert.equal(S.nextLeaveOutVersion("junk", now), "2030-06-15T16:00:00.000Z");
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
