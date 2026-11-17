// POST /api/supplements/log-product with an optional event_key (a UUID) is the chat tool's keyed single-product log:
// the same key twice writes one set of rows and answers replayed: true; another key is another log; a malformed key
// is refused with 400 before anything is written. The route itself needs Next's request objects, so its wiring is
// checked as a source fact and the write is run through logSupplementIntake on a synthetic fake database.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const { createFakePostgrest } = require("./helpers/fake-postgrest.cjs");
const { parseSource, collect } = require("./helpers/source-facts.cjs");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const intake = loadTs("lib/supplement-intake.ts");

const KEY = "66666666-6666-4666-8666-666666666666";
const OTHER_KEY = "77777777-7777-4777-8777-777777777777";

function db() {
  return createFakePostgrest({
    unique: { supplement_intake: [["client_event_key", "client_event_line"]] },
    defaults: { supplement_intake: (_now, seq) => ({ intake_id: seq, client_event_key: null, client_event_line: null }) },
    tables: {
      supplement_products: [
        { product_id: "p1", brand_name: "Acme", full_name: "Synthetic Calm", serving_size: 1, serving_unit: "capsule", ingredients: [], is_active: true },
      ],
    },
    rpc: { behavioral_today_now: "2030-01-01", tz_for_instant: "America/New_York" },
  });
}

// What the route passes through: the body's event_key becomes the write's event_key, with the route's own notes.
const logProduct = (d, eventKey) =>
  intake.logSupplementIntake(d, {
    product: "Synthetic Calm",
    product_id: "p1",
    amount: 2,
    unit: "capsule",
    times: ["08:30", "12:00"],
    date: "2030-01-01",
    notes: "Logged from /log",
    event_key: eventKey,
  });

test("the same event_key sent twice leaves one set of rows, and the repeat answers replayed: true", async () => {
  const d = db();
  const first = await logProduct(d, KEY);
  assert.equal(first.ok, true);
  assert.equal(first.replayed, undefined);
  const again = await logProduct(d, KEY.toUpperCase());
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.logged.map((r) => r.intake_id), first.logged.map((r) => r.intake_id));
  assert.equal(d.rows("supplement_intake").length, 2, "two clock times = two rows, written once");
});

test("different event_keys are two logs", async () => {
  const d = db();
  const a = await logProduct(d, KEY);
  const b = await logProduct(d, OTHER_KEY);
  assert.equal(a.replayed, undefined);
  assert.equal(b.replayed, undefined);
  assert.equal(b.logged.length, 2, "the second key's two times are both written, not skipped as duplicates");
  assert.equal(b.skipped_duplicates, undefined);
  assert.equal(d.rows("supplement_intake").length, 4);
});

test("a malformed event_key is refused and nothing is written", async () => {
  const d = db();
  const out = await logProduct(d, "not-a-uuid");
  assert.equal(out.ok, false);
  assert.equal(out.error, "event_key must be a UUID");
  assert.equal(d.rows("supplement_intake").length, 0);
});

test("the route validates event_key as a strict UUID, answers 400, and passes it to logSupplementIntake", () => {
  const file = path.join(__dirname, "..", "src", "app", "api", "supplements", "log-product", "route.ts");
  const sf = parseSource(fs.readFileSync(file, "utf8"), "route.ts");
  // The UUID check is the route's own regex, not a loose string check.
  const regexes = collect(sf, (n) => ts.isVariableDeclaration(n) && n.name.getText(sf) === "EVENT_KEY_RE").map((n) => n.initializer.getText(sf));
  assert.equal(regexes.length, 1);
  assert.match(regexes[0], /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
  // The refusal is a 400 response with the message, and the key reaches the intake call.
  const refusals = collect(sf, (n) => ts.isStringLiteral(n) && n.text === "event_key must be a UUID");
  assert.ok(refusals.length >= 1);
  const passed = collect(sf, (n) => ts.isPropertyAssignment(n) && n.name.getText(sf) === "event_key");
  assert.equal(passed.length, 1, "event_key is passed to logSupplementIntake");
  assert.match(passed[0].initializer.getText(sf), /eventKey/);
});
