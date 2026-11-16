// Run: node --test tests/drink-session.test.cjs
// The Log Drinks session (src/lib/drink-session.ts): the request in flight is kept on the device BEFORE it is sent
// (normalized fields only, never the words), an unknown outcome is replayed exactly before anything new, a conflict
// stays a conflict (never an edit or an Undo with the freshly returned revision), and a reload only READS each kept
// drink by its key: a proven replay is acknowledged, a tombstone stays removed, a different version is shown, nothing
// found waits for an explicit retry. Offline and synthetic: a fake server and an in-memory storage.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

// One copy of lib/autosave.ts, passed to drink-session as "./autosave": loadTs has no module cache, and a second copy
// would give the session its own AutosaveRefused class, which `instanceof` here would not recognise.
const autosaveLib = loadTs("lib/autosave.ts");
const { AutosaveRefused } = autosaveLib;
const S = loadTs("lib/drink-session.ts", { "./autosave": autosaveLib });
const C = loadTs("lib/drink-capture.ts");
const WG = "gorilla-mind-energy-wild-grape-16oz";
const NY = "America/New_York";
const KEY = "0b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b";
// A recent instant (the device copy keeps an acknowledged drink for 36 h after its time).
const AT = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000).toISOString();

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), raw: m };
}

const save = (over = {}) => ({ client_key: KEY, product_id: WG, servings: 1, time: { mode: "now", at: AT, zone: NY }, overlap: "none", ...over });

function item(over = {}) {
  return {
    key: KEY, product_id: WG, said: "one wild grape gorilla mind", issue: null, servings: 1, timeMode: "now",
    capturedAt: Date.parse(AT), day: null, time: null, fold: null, zone: NY, whenIssue: null,
    overlap: null, recent: null, status: "open", saved: null, hold: null, note: null, pending: null, ...over,
  };
}

/** A fake drinks API with the route's semantics (replay, 409 changed / stale, 410, tombstones). */
function fakeServer() {
  const rows = new Map();
  const log = [];
  const ctl = { lose: 0, down: 0 };
  const record = (b, revision) => ({
    meal_id: 1, client_key: b.client_key, product_id: b.product_id, product_version: 1, name: "Gorilla Mind Energy Drink, Wild Grape",
    servings: b.servings, eaten_date: "2026-11-15", eaten_time: "14:05", eaten_at: b.time.at, time_zone: b.time.zone, time_source: "now",
    kcal: 5 * b.servings, protein_g: 0, carbs_g: b.servings, fat_g: 0, sugar_g: 0, sodium_mg: 25 * b.servings, caffeine_mg: 200 * b.servings,
    overlap: b.overlap, revision,
  });
  const same = (rec, b) => C.sameSave(C.saveFromRecord(rec), { client_key: b.client_key, product_id: b.product_id, servings: b.servings, time: b.time, overlap: b.overlap });
  const answer = (status, json) => ({ ok: status < 300, status, json });
  function apply(method, b) {
    const row = rows.get(b.client_key);
    if (method === "POST") {
      if (row?.deleted) return answer(410, { error: "This drink was removed.", code: "removed" });
      if (row) return same(row.rec, b) ? answer(200, { record: row.rec, replay: true }) : answer(409, { error: "x", code: "changed", record: row.rec });
      const rec = record(b, 1);
      rows.set(b.client_key, { rec, deleted: false });
      return answer(201, { record: rec });
    }
    if (!row) return answer(404, { error: "drink not found" });
    if (method === "PATCH") {
      if (row.deleted) return answer(410, { error: "This drink was removed.", code: "removed" });
      if (same(row.rec, b)) return answer(200, { record: row.rec, replay: true });
      if (row.rec.revision !== b.expected_revision) return answer(409, { error: "x", code: "stale", record: row.rec });
      row.rec = record(b, row.rec.revision + 1);
      return answer(200, { record: row.rec });
    }
    if (row.deleted) return answer(200, { removed: b.client_key });
    if (row.rec.revision !== b.expected_revision) return answer(409, { error: "x", code: "stale", record: row.rec });
    row.deleted = true;
    row.rec = { ...row.rec, revision: row.rec.revision + 1 };
    return answer(200, { removed: b.client_key });
  }
  const call = async (method, body) => {
    log.push({ method, body: JSON.parse(JSON.stringify(body)), stored: ctl.storage ? ctl.storage.getItem(S.DRINK_STORAGE_KEY) : null });
    if (ctl.down > 0) { ctl.down--; throw new TypeError("Failed to fetch"); }
    const a = apply(method, body);
    if (ctl.lose > 0) { ctl.lose--; throw new TypeError("Failed to fetch"); } // applied, answer lost
    return a;
  };
  /** Someone else (another screen) edits the stored drink. */
  const editElsewhere = (servings) => {
    const row = rows.get(KEY);
    row.rec = record({ ...C.saveFromRecord(row.rec), servings }, row.rec.revision + 1);
  };
  const read = (key) => {
    const row = rows.get(key);
    return !row ? { status: "none" } : row.deleted ? { status: "removed" } : { status: "found", record: row.rec };
  };
  return { call, log, ctl, rows, editElsewhere, read };
}

function fresh() {
  const storage = memStorage();
  S.drinkSession.reset({ storage });
  const srv = fakeServer();
  srv.ctl.storage = storage;
  return { storage, srv };
}

test("the request is stored on the device BEFORE it is sent; never the words", async () => {
  const { storage, srv } = fresh();
  S.drinkSession.adopt(item());
  await S.saveDrinkWith(srv.call, save());
  const atSend = JSON.parse(srv.log[0].stored);
  assert.equal(atSend.items[0].pending.op, "create", "pending create persisted before the POST");
  assert.equal(atSend.items[0].pending.body.client_key, KEY);
  const after = storage.getItem(S.DRINK_STORAGE_KEY);
  assert.ok(!after.includes("one wild grape"), "the said words are never stored");
  assert.equal(JSON.parse(after).items[0].pending, null, "cleared on a definite answer");
  assert.equal(JSON.parse(after).items[0].ack.revision, 1);
});

test("lost create answer + a later edit: the create is replayed exactly first, then the edit uses OUR revision", async () => {
  const { srv } = fresh();
  S.drinkSession.adopt(item());
  srv.ctl.lose = 1;
  await assert.rejects(S.saveDrinkWith(srv.call, save()), TypeError);
  assert.equal(S.drinkSession.get(KEY).pending.op, "create", "outcome unknown: kept");
  await S.saveDrinkWith(srv.call, save({ servings: 2 }));
  assert.deepEqual(srv.log.map((l) => [l.method, l.body.servings, l.body.expected_revision ?? null]), [["POST", 1, null], ["POST", 1, null], ["PATCH", 2, 1]]);
  assert.equal(srv.rows.get(KEY).rec.servings, 2);
  assert.equal(srv.rows.get(KEY).rec.revision, 2);
});

test("a delayed create that conflicts with a newer version stays a conflict (no PATCH with the returned revision)", async () => {
  const { srv } = fresh();
  S.drinkSession.adopt(item());
  srv.ctl.lose = 1;
  await assert.rejects(S.saveDrinkWith(srv.call, save()), TypeError);
  srv.editElsewhere(3); // revision 2 by another screen
  await assert.rejects(S.saveDrinkWith(srv.call, save({ servings: 2 })), (e) => e instanceof AutosaveRefused);
  assert.deepEqual(srv.log.map((l) => l.method), ["POST", "POST"], "no edit was sent over the newer version");
  assert.equal(srv.rows.get(KEY).rec.servings, 3, "the newer version survives");
  const it = S.drinkSession.get(KEY);
  assert.equal(it.hold, "conflict");
  assert.equal(it.servings, 3, "the server's version is shown");
  assert.equal(S.drinkSession.ack(KEY).revision, 2);
  // A NEW deliberate change replaces it, with the revision Riley has now seen.
  S.drinkSession.update(KEY, { hold: null, servings: 1 });
  await S.saveDrinkWith(srv.call, save({ servings: 1 }));
  assert.deepEqual(srv.log.at(-1), { method: "PATCH", body: { ...save({ servings: 1 }), expected_revision: 2 }, stored: srv.log.at(-1).stored });
});

test("a stale edit stays a conflict", async () => {
  const { srv } = fresh();
  S.drinkSession.adopt(item());
  await S.saveDrinkWith(srv.call, save());
  srv.editElsewhere(3);
  await assert.rejects(S.saveDrinkWith(srv.call, save({ servings: 2 })), (e) => e instanceof AutosaveRefused);
  assert.equal(srv.log.filter((l) => l.method === "PATCH").length, 1, "never resent with the fresh revision");
  assert.equal(srv.rows.get(KEY).rec.servings, 3);
  assert.equal(S.drinkSession.get(KEY).hold, "conflict");
});

test("a stale Undo never removes the newer edit; it is not repeated with the fresh revision", async () => {
  const { srv } = fresh();
  S.drinkSession.adopt(item());
  await S.saveDrinkWith(srv.call, save());
  srv.editElsewhere(2);
  const r = await S.undoDrinkWith(srv.call, KEY);
  assert.equal(r.ok, false);
  assert.match(r.message, /Undo again/);
  assert.equal(srv.log.filter((l) => l.method === "DELETE").length, 1);
  assert.equal(srv.rows.get(KEY).deleted, false, "the newer edit survives");
  assert.equal(S.drinkSession.get(KEY).servings, 2, "and is shown");
  // A second, deliberate Undo with that version removes it.
  assert.equal((await S.undoDrinkWith(srv.call, KEY)).ok, true);
  assert.equal(srv.rows.get(KEY).deleted, true);
  assert.equal(S.drinkSession.get(KEY).status, "removed");
});

test("a removed drink is never resurrected by a late save", async () => {
  const { srv } = fresh();
  S.drinkSession.adopt(item());
  await S.saveDrinkWith(srv.call, save());
  await S.undoDrinkWith(srv.call, KEY);
  S.drinkSession.update(KEY, { status: "open" }); // even if the editor still holds it
  S.drinkSession.forget(KEY);
  await assert.rejects(S.saveDrinkWith(srv.call, save({ servings: 2 })), (e) => e instanceof AutosaveRefused && /removed/.test(e.message));
  assert.equal(srv.rows.get(KEY).deleted, true);
  assert.equal(S.drinkSession.get(KEY).status, "removed");
});

test("503 (not set up / turned off) is a definite refusal: not pending, shown, nothing saved", async () => {
  const { srv } = fresh();
  S.drinkSession.adopt(item());
  const call503 = async (m, b) => { srv.log.push({ method: m, body: b }); return { ok: false, status: 503, json: { error: "Drinks are not set up yet: the database migration is pending." } }; };
  await assert.rejects(S.saveDrinkWith(call503, save()), (e) => e instanceof AutosaveRefused && /migration is pending/.test(e.message));
  assert.equal(S.drinkSession.get(KEY).pending, null);
  assert.equal(S.drinkSession.ack(KEY), undefined, "never Saved");
});

function reload(storage) {
  // A full page load: memory gone, the device copy stays.
  S.drinkSession.reset({ storage });
  return S.drinkSession.restore();
}

test("reload after a lost create answer: read by key; a proven replay is acknowledged; nothing is sent", async () => {
  const { storage, srv } = fresh();
  S.drinkSession.adopt(item());
  srv.ctl.lose = 1;
  await assert.rejects(S.saveDrinkWith(srv.call, save()), TypeError);
  const keys = reload(storage);
  assert.deepEqual(keys, [KEY]);
  const it = S.drinkSession.get(KEY);
  assert.equal(it.hold, "recover", "held: nothing is sent on open");
  assert.equal(it.said, "", "the words were never stored");
  const sent = srv.log.length;
  S.drinkSession.reconcile(KEY, srv.read(KEY));
  assert.equal(srv.log.length, sent, "recovery only reads");
  assert.equal(S.drinkSession.get(KEY).hold, null);
  assert.equal(S.drinkSession.get(KEY).pending, null);
  assert.equal(S.drinkSession.ack(KEY).revision, 1);
});

test("reload: never committed -> explicit retry; removed -> stays removed; other version -> conflict; read failed -> check again", async () => {
  let { storage, srv } = fresh();
  S.drinkSession.adopt(item());
  srv.ctl.down = 1; // never reached the server
  await assert.rejects(S.saveDrinkWith(srv.call, save()), TypeError);
  reload(storage);
  S.drinkSession.reconcile(KEY, srv.read(KEY));
  assert.equal(S.drinkSession.get(KEY).hold, "retry", "not found: waits for Save it, never re-sent on open");
  assert.equal(S.drinkSession.get(KEY).status, "open", "the draft is not lost");

  ({ storage, srv } = fresh());
  S.drinkSession.adopt(item());
  await S.saveDrinkWith(srv.call, save());
  srv.ctl.lose = 1;
  assert.equal((await S.undoDrinkWith(srv.call, KEY)).ok, false);
  reload(storage);
  S.drinkSession.reconcile(KEY, srv.read(KEY));
  assert.equal(S.drinkSession.get(KEY).status, "removed", "the tombstone stays");

  ({ storage, srv } = fresh());
  S.drinkSession.adopt(item());
  await S.saveDrinkWith(srv.call, save());
  srv.ctl.lose = 1;
  await assert.rejects(S.saveDrinkWith(srv.call, save({ servings: 2 })), TypeError);
  srv.editElsewhere(3);
  reload(storage);
  S.drinkSession.reconcile(KEY, srv.read(KEY));
  assert.equal(S.drinkSession.get(KEY).hold, "conflict");
  assert.equal(S.drinkSession.get(KEY).servings, 3);

  ({ storage, srv } = fresh());
  S.drinkSession.adopt(item());
  srv.ctl.lose = 1;
  await assert.rejects(S.saveDrinkWith(srv.call, save()), TypeError);
  reload(storage);
  S.drinkSession.reconcile(KEY, "failed");
  assert.equal(S.drinkSession.get(KEY).hold, "recover");
  assert.ok(S.drinkSession.get(KEY).note);
  assert.equal(S.drinkSession.get(KEY).pending.op, "create", "still known; re-read on Check again");
});

test("restore runs once per page load and ignores malformed device copies", () => {
  const storage = memStorage();
  storage.setItem(S.DRINK_STORAGE_KEY, JSON.stringify({ v: 1, items: [{ key: "not-a-key" }, null, 7] }));
  S.drinkSession.reset({ storage });
  assert.deepEqual(S.drinkSession.restore(), []);
  storage.setItem(S.DRINK_STORAGE_KEY, "{broken");
  S.drinkSession.reset({ storage });
  assert.deepEqual(S.drinkSession.restore(), []);
  S.drinkSession.reset({ storage: null });
  assert.deepEqual(S.drinkSession.restore(), [], "no storage: memory only");
  assert.ok(S.DRINK_STORAGE_KEY.startsWith("onyx"), "wiped on sign-out with the app's other keys");
});

test("adopt keeps the existing item for the same key (a repeated Fill of frozen drafts adds nothing)", () => {
  fresh();
  assert.equal(S.drinkSession.adopt(item()), true);
  S.drinkSession.update(KEY, { servings: 2 });
  assert.equal(S.drinkSession.adopt(item()), false);
  assert.equal(S.drinkSession.get(KEY).servings, 2);
  assert.equal(S.drinkSession.items().length, 1);
});

test("unavailable or full storage blocks a mutation before any network request", async () => {
  for (const storage of [null, { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error("quota"); } }]) {
    S.drinkSession.reset({ storage });
    S.drinkSession.adopt(item());
    let sent = 0;
    const call = async () => { sent++; throw new Error("must not send"); };
    await assert.rejects(S.saveDrinkWith(call, save()), /Nothing was sent/);
    await assert.rejects(S.saveDrinkWith(call, save()), /Nothing was sent/);
    assert.equal(sent, 0, "first send and retries require durable identity");
    assert.equal(S.drinkSession.get(KEY).pending.body.client_key, KEY);
  }
});

test("more than 40 unresolved requests survive reload without losing an operation key", async () => {
  const { storage } = fresh();
  const keys = [];
  for (let i = 0; i < 45; i++) {
    const key = `0b8f2a6e-5d1c-4f3e-9a7b-${String(i).padStart(12, "0")}`;
    keys.push(key);
    S.drinkSession.adopt(item({ key }));
    await assert.rejects(S.saveDrinkWith(async () => { throw new TypeError("offline"); }, save({ client_key: key })), TypeError);
  }
  S.drinkSession.reset({ storage });
  assert.deepEqual(S.drinkSession.restore().sort(), keys.sort());
  assert.equal(S.drinkSession.items().filter((i) => i.pending).length, 45);
});
