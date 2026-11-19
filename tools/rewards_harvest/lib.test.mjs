// Synthetic payloads only (no real balances, names or numbers). Run with: node --test lib.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { extractProgram, looksSignedOut, shapeOf, summarize, toIsoDate, toNumber } from "./lib.mjs";

test("balance, tier and progress come only from allow-listed keys", () => {
  const cap = [{ url: "https://x.test/api/skymiles/summary", json: {
    member: { firstName: "Demo", email: "demo@example.test", cardNumber: "4111111111111111" },
    loyalty: { mileBalance: "12,345", medallionStatus: "Gold Medallion", mqdTotal: 1500, mqdGoal: 5000 },
  } }];
  const r = extractProgram("delta_skymiles", cap, "");
  assert.deepEqual(r, { balance: 12345, unit: "miles", status_tier: "Gold Medallion", status_progress: { mqd: 1500, mqd_goal: 5000 }, expires_on: null });
  assert.ok(!JSON.stringify(r).includes("demo"));
});

test("responses whose address does not match the hint are ignored", () => {
  const cap = [{ url: "https://x.test/api/ads", json: { pointsBalance: 99 } }];
  assert.equal(extractProgram("hilton_honors", cap, ""), null);
});

test("text fallback reads a balance and tier from visible text", () => {
  const r = extractProgram("marriott_bonvoy", [], "Welcome back. 48,200 points  Gold Elite");
  assert.equal(r.balance, 48200);
  assert.equal(r.status_tier, "Gold");
});

test("free text in a tier field is not copied", () => {
  const cap = [{ url: "https://x.test/honors", json: { tierName: "call 404-555-0100 for Gold help", pointsBalance: 10 } }];
  assert.equal(extractProgram("hilton_honors", cap, "").status_tier, null);
});

test("hilton expiry date normalised", () => {
  const cap = [{ url: "https://x.test/honors", json: { pointsBalance: 5, pointsExpirationDate: "2027-03-01T00:00:00Z" } }];
  assert.equal(extractProgram("hilton_honors", cap, "").expires_on, "2027-03-01");
});

test("uber cash from text, uber one flag and renewal", () => {
  assert.equal(extractProgram("uber_cash", [], "Uber Cash $12.50").balance, 12.5);
  const one = extractProgram("uber_one", [{ url: "https://x.test/membership", json: { isUberOneMember: true, renewalDate: "Dec 5, 2026" } }], "");
  assert.deepEqual(one, { balance: 1, unit: "points", status_tier: "member", status_progress: null, expires_on: "2026-12-05" });
  assert.equal(extractProgram("uber_one", [{ url: "https://x.test/membership", json: { isMember: false } }], "").balance, 0);
});

test("sign-in address detection, number and date helpers", () => {
  assert.ok(looksSignedOut("delta_skymiles", "https://www.delta.com/login?x=1"));
  assert.ok(!looksSignedOut("delta_skymiles", "https://www.delta.com/myprofile/overview"));
  assert.equal(toNumber("$1,234.50"), 1234.5);
  assert.equal(toNumber("abc"), null);
  assert.equal(toIsoDate("3/4/2027"), "2027-03-04");
});

test("probe shape holds key names and types, never values", () => {
  const s = JSON.stringify(shapeOf({ pointsBalance: 123, name: "Demo Person", list: [{ a: 1 }] }));
  assert.ok(s.includes("pointsBalance") && s.includes("number"));
  assert.ok(!s.includes("Demo") && !s.includes("123"));
});

test("heartbeat summary names programs and causes only", () => {
  assert.deepEqual(summarize([{ program: "a", ok: true }, { program: "b", ok: true }]), { status: "success", records: 2, error: null });
  const s = summarize([{ program: "a", ok: true }, { program: "b", ok: false, cause: "not signed in" }]);
  assert.equal(s.status, "partial");
  assert.equal(s.records, 1);
  assert.equal(s.error, "b: not signed in");
});
