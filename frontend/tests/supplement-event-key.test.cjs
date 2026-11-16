// Supplement intake event identity (SEC-04, sql/chat_operations.sql): logStackIntake and logSupplementIntake with an
// event_key write each event once, all of it in one insert, and give the stored rows back on a repeat, also when two
// calls race. Without a key they behave as before. Synthetic products and stacks only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const { createFakePostgrest } = require("./helpers/fake-postgrest.cjs");

const stacks = loadTs("lib/supplement-stacks.ts");
const intake = loadTs("lib/supplement-intake.ts");

const KEY = "44444444-4444-4444-8444-444444444444";
const OTHER_KEY = "55555555-5555-4555-8555-555555555555";

function db(extra = {}) {
  return createFakePostgrest({
    unique: { supplement_intake: [["client_event_key", "client_event_line"]] },
    defaults: { supplement_intake: (_now, seq) => ({ intake_id: seq, client_event_key: null, client_event_line: null }) },
    tables: {
      supplement_stack: [{ stack_id: 7, name: "Synthetic Morning", is_active: true }],
      supplement_stack_item: [
        { stack_id: 7, product_id: "p1", doses: 1, sort_order: 1 },
        { stack_id: 7, product_id: "p2", doses: 2, sort_order: 2 },
      ],
      supplement_products: [
        { product_id: "p1", brand_name: "Acme", full_name: "Synthetic Calm", serving_size: 1, serving_unit: "capsule", ingredients: [], is_active: true },
      ],
    },
    rpc: { behavioral_today_now: "2030-01-01", tz_for_instant: "America/New_York" },
    ...extra,
  });
}

const keyed = (rows, key) => rows.filter((r) => r.client_event_key === key);

test("a stack log with an event key writes one keyed row per item, in one insert", async () => {
  const d = db();
  const out = await stacks.logStackIntake(d, 7, { event_key: KEY });
  assert.equal(out.ok, true);
  assert.equal(out.replayed, undefined);
  const rows = d.rows("supplement_intake");
  assert.deepEqual(rows.map((r) => [r.product_id, r.client_event_key, r.client_event_line]), [["p1", KEY, 0], ["p2", KEY, 1]]);
  assert.equal(d.log.filter((c) => c.table === "supplement_intake" && c.op === "insert").length, 1);
});

test("the same stack event again returns the stored rows and writes nothing, even after the stack was archived", async () => {
  const d = db();
  const first = await stacks.logStackIntake(d, 7, { event_key: KEY });
  await d.from("supplement_stack").update({ is_active: false }).eq("stack_id", 7);
  const again = await stacks.logStackIntake(d, 7, { event_key: KEY.toUpperCase() });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.intake_ids, first.intake_ids);
  assert.equal(again.total_doses, 3);
  assert.equal(again.stack_name, "Synthetic Morning");
  assert.equal(d.rows("supplement_intake").length, 2);
});

test("two calls of one stack event at the same moment leave one set of rows", async () => {
  const d = db();
  const [a, b] = await Promise.all([stacks.logStackIntake(d, 7, { event_key: KEY }), stacks.logStackIntake(d, 7, { event_key: KEY })]);
  assert.equal(a.ok && b.ok, true);
  assert.equal([a, b].filter((r) => r.replayed === true).length, 1);
  assert.deepEqual(a.intake_ids, b.intake_ids);
  assert.equal(keyed(d.rows("supplement_intake"), KEY).length, 2);
});

test("another event key is another log, and no key keeps the old behaviour (a new set every call)", async () => {
  const d = db();
  await stacks.logStackIntake(d, 7, { event_key: KEY });
  await stacks.logStackIntake(d, 7, { event_key: OTHER_KEY });
  await stacks.logStackIntake(d, 7, {});
  await stacks.logStackIntake(d, 7, {});
  const rows = d.rows("supplement_intake");
  assert.equal(rows.length, 8);
  assert.equal(keyed(rows, null).length, 4);
  assert.ok(rows.filter((r) => r.client_event_key === null).every((r) => r.client_event_line === null));
});

test("a malformed key is ignored rather than stored", async () => {
  const d = db();
  await stacks.logStackIntake(d, 7, { event_key: "not-a-uuid" });
  assert.ok(d.rows("supplement_intake").every((r) => r.client_event_key === null));
});

test("before the key columns exist, a keyed stack log falls back to a plain insert", async () => {
  const d = db({
    fail: ({ table, op, payload }) =>
      table === "supplement_intake" && ((op === "insert" && Array.isArray(payload) && payload.some((r) => "client_event_key" in r)) || op === "select")
        ? { code: "PGRST204" }
        : null,
  });
  const out = await stacks.logStackIntake(d, 7, { event_key: KEY });
  assert.equal(out.ok, true);
  assert.equal(d.rows("supplement_intake").length, 2);
  assert.ok(d.rows("supplement_intake").every((r) => r.client_event_key === null));
});

test("a failed stack insert writes nothing and says so", async () => {
  const d = db({ fail: ({ table, op }) => (table === "supplement_intake" && op === "insert" ? { code: "23503", message: "synthetic failure" } : null) });
  const out = await stacks.logStackIntake(d, 7, { event_key: KEY });
  assert.equal(out.ok, false);
  assert.equal(out.incomplete, undefined, "a database refusal (it has a SQLSTATE) is a clean 'not logged'");
  assert.equal(d.rows("supplement_intake").length, 0);
});

// The insert commits and its answer is lost on the way (supabase-js reports a network failure as an error with no
// code, not a throw).
const loseFirstInsert = () => {
  let lost = false;
  return ({ table, op }) => {
    if (lost || table !== "supplement_intake" || op !== "insert") return null;
    lost = true;
    return { code: "", message: "TypeError: fetch failed (synthetic)" };
  };
};

test("a keyed stack insert that committed but lost its answer is found under its key: success, one set of rows", async () => {
  const d = db({ lose: loseFirstInsert() });
  const out = await stacks.logStackIntake(d, 7, { event_key: KEY });
  assert.equal(out.ok, true);
  assert.equal(out.replayed, true);
  assert.equal(out.count, 2);
  // The model calls it again, or the message is retried: still one set.
  const again = await stacks.logStackIntake(d, 7, { event_key: KEY });
  assert.equal(again.replayed, true);
  assert.equal(d.rows("supplement_intake").length, 2);
});

test("a lost answer that cannot be read back is 'may be logged' (incomplete), never 'not logged'", async () => {
  const d = db({ lose: loseFirstInsert() });
  // The read-back after the lost answer fails too (still offline).
  d.setFailure(({ table, op }) => (table === "supplement_intake" && op === "select" ? { code: "" } : null));
  const keyedOut = await stacks.logStackIntake(d, 7, { event_key: KEY });
  assert.equal(keyedOut.ok, false);
  assert.equal(keyedOut.incomplete, true);
  assert.equal(keyedOut.error, stacks.STACK_MAYBE_LOGGED);
  assert.doesNotMatch(keyedOut.error, /synthetic/, "the transport text is not passed on");
  d.setFailure(null);
  // Without a key (the /supplements page) a lost answer is also "may be logged".
  const d2 = db({ lose: loseFirstInsert() });
  const plainOut = await stacks.logStackIntake(d2, 7, {});
  assert.equal(plainOut.incomplete, true);
  assert.equal(d2.rows("supplement_intake").length, 2, "it was written");
});

test("a keyed single-product insert that committed but lost its answer: found under its key, written once", async () => {
  const d = db({ lose: loseFirstInsert() });
  const out = await intake.logSupplementIntake(d, { product: "Synthetic Calm", event_key: KEY });
  assert.equal(out.ok, true);
  assert.equal(out.replayed, true);
  const again = await intake.logSupplementIntake(d, { product: "Synthetic Calm", event_key: KEY });
  assert.equal(again.replayed, true);
  assert.equal(d.rows("supplement_intake").length, 1);
  // Unkeyed and lost: "may be logged".
  const d2 = db({ lose: loseFirstInsert() });
  const plainOut = await intake.logSupplementIntake(d2, { product: "Synthetic Calm" });
  assert.equal(plainOut.ok, false);
  assert.equal(plainOut.incomplete, true);
  assert.equal(plainOut.error, intake.INTAKE_MAYBE_LOGGED);
});

test("an untimed single-product log with an event key is written once; the repeat returns the stored row", async () => {
  const d = db();
  const first = await intake.logSupplementIntake(d, { product: "Synthetic Calm", event_key: KEY });
  assert.equal(first.ok, true);
  assert.equal(first.logged.length, 1);
  const again = await intake.logSupplementIntake(d, { product: "Synthetic Calm", event_key: KEY });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.logged.map((l) => l.intake_id), first.logged.map((l) => l.intake_id));
  assert.equal(again.product, "Acme Synthetic Calm");
  assert.equal(again.intake_date, "2030-01-01");
  assert.equal(d.rows("supplement_intake").length, 1);
  assert.deepEqual(d.rows("supplement_intake").map((r) => [r.client_event_key, r.client_event_line]), [[KEY, 0]]);
});

test("without a key an untimed single-product log still writes each time (unchanged)", async () => {
  const d = db();
  await intake.logSupplementIntake(d, { product: "Synthetic Calm" });
  await intake.logSupplementIntake(d, { product: "Synthetic Calm" });
  assert.equal(d.rows("supplement_intake").length, 2);
});

test("a timed single-product log with a key stores every time under the one event", async () => {
  const d = db();
  const out = await intake.logSupplementIntake(d, { product: "Synthetic Calm", times: ["08:30", "12:00"], event_key: KEY });
  assert.equal(out.ok, true);
  assert.deepEqual(d.rows("supplement_intake").map((r) => r.client_event_line), [0, 1]);
  const again = await intake.logSupplementIntake(d, { product: "Synthetic Calm", times: ["08:30", "12:00"], event_key: KEY });
  assert.equal(again.replayed, true);
  assert.equal(again.logged.length, 2);
  assert.equal(d.rows("supplement_intake").length, 2);
});

test("a stack event is found by its key alone, for the stack its rows belong to, before any name is resolved", async () => {
  const d = db();
  assert.equal(await stacks.stackEventReplay(d, KEY), null, "nothing written under the key yet");
  assert.equal(await stacks.stackEventReplay(d, "not-a-uuid"), null);
  const first = await stacks.logStackIntake(d, 7, { event_key: KEY });
  // Renamed and archived since, and another stack now has the old name: the replay still names stack 7.
  await d.from("supplement_stack").update({ name: "Synthetic Dawn", is_active: false }).eq("stack_id", 7);
  d.seed("supplement_stack", [{ stack_id: 8, name: "Synthetic Morning", is_active: true }]);
  const replay = await stacks.stackEventReplay(d, KEY);
  assert.equal(replay.replayed, true);
  assert.equal(replay.stack_id, 7);
  assert.equal(replay.stack_name, "Synthetic Dawn");
  assert.deepEqual(replay.intake_ids, first.intake_ids);
  // logStackIntake called with another stack id still reports the stack that was logged.
  const again = await stacks.logStackIntake(d, 8, { event_key: KEY });
  assert.equal(again.stack_id, 7);
  assert.equal(d.rows("supplement_intake").length, 2);
});
