// Run: node --test tests/rewards-settings-save.test.cjs   (written, not run before merge: AGENTS.md testing policy)
// Rewards settings save (lib/rewards-server.ts saveSettings): the merge is one database statement, so overlapping
// saves of different fields never drop each other. SYNTHETIC DATA ONLY.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

function load(rpc) {
  return loadTs("lib/rewards-server.ts", {
    "server-only": {},
    "@/lib/finance-service-client": { serviceClient: () => ({ rpc }) },
  });
}

test("two overlapping saves to different fields both persist and each returns the stored row", async () => {
  const rows = new Map([
    ["valuations", { demo_a: 1.0 }],
    ["credits", { demo_credit: 100, demo_other: 7 }],
  ]);
  let release;
  const gate = new Promise((r) => (release = r));
  // Mirrors pds.rewards_settings_merge: read + merge + write is one synchronous step once the call arrives.
  const rpc = async (name, args) => {
    assert.equal(name, "rewards_settings_merge");
    if (args.p_key === "valuations") await gate; // lands after the credit save has already been applied
    const prev = rows.get(args.p_key);
    const value = args.p_merge && prev ? { ...prev, ...args.p_patch } : args.p_patch;
    rows.set(args.p_key, value);
    return { data: value, error: null };
  };
  const S = load(rpc);
  const a = S.saveSettings({ key: "valuations", value: { demo_b: 2.0 } });
  const b = S.saveSettings({ key: "credits", value: { demo_credit: 50 } });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(rows.get("valuations"), { demo_a: 1.0, demo_b: 2.0 });
  assert.deepEqual(rows.get("credits"), { demo_credit: 50, demo_other: 7 });
  assert.deepEqual(ra, { ok: true, value: { demo_a: 1.0, demo_b: 2.0 } });
  assert.deepEqual(rb, { ok: true, value: { demo_credit: 50, demo_other: 7 } });
});

test("two saves to the same row, different credit fields, both persist", async () => {
  let stored = { demo_x: 1 };
  const rpc = async (_n, args) => {
    await Promise.resolve();
    stored = { ...stored, ...args.p_patch };
    return { data: stored, error: null };
  };
  const S = load(rpc);
  await Promise.all([S.saveSettings({ key: "credits", value: { demo_y: 2 } }), S.saveSettings({ key: "credits", value: { demo_z: 3 } })]);
  assert.deepEqual(stored, { demo_x: 1, demo_y: 2, demo_z: 3 });
});

test("non-merge keys replace; a database error (e.g. serialization failure) is a failure, never success", async () => {
  const seen = [];
  const S = load(async (_n, args) => {
    seen.push(args.p_merge);
    return args.p_key === "apple_boosted" ? { data: args.p_patch, error: null } : { data: null, error: { code: "40001" } };
  });
  assert.deepEqual(await S.saveSettings({ key: "apple_boosted", value: ["demo shop"] }), { ok: true, value: ["demo shop"] });
  assert.deepEqual(await S.saveSettings({ key: "credits", value: { demo_credit: 1 } }), { ok: false, code: "40001" });
  assert.deepEqual(seen, [false, true]);
});

test("the migration merges with jsonb concatenation in one statement and drops nothing", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "rewards_settings_merge.sql"), "utf8");
  assert.match(sql, /s\.value \|\| excluded\.value/);
  assert.match(sql, /on conflict \(key\) do update/);
  assert.doesNotMatch(sql, /\bdrop\b/i);
});
