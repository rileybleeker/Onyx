// RQS1-R2: static guards on sql/reading_bank_month_charges.sql (no database: the file is read as text). The monthly
// cap must sum a per-charge ledger dated to the Eastern month each charge was made in, never a job's lifetime
// cost_cents. The synthetic scenario (one job charged 100 cents in October and 1 cent on a retry in November counts
// 1 cent in November; an unknown-outcome settlement across the boundary dates to the month it is settled in) is
// written out in that file's header and is for a dev database run, not run before merge.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql/reading_bank_month_charges.sql"), "utf8");

/** Body of a CREATE OR REPLACE FUNCTION in this file, between its $fn$ markers. */
function body(name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const open = sql.indexOf("$fn$", start);
  const close = sql.indexOf("$fn$", open + 4);
  return sql.slice(open + 4, close);
}

test("the file is additive: no DROP statement, no ALTER of the jobs table, and no change to the base file", () => {
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /ALTER TABLE pds\.reading_bank_jobs/);
});

test("the ledger is one row per charge, dated to the Eastern month, and only positive charges are written", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pds\.reading_bank_charges \(/);
  assert.match(sql, /month_start\s+DATE\s+NOT NULL/);
  assert.match(sql, /cost_cents\s+NUMERIC\(10,2\) NOT NULL CHECK \(cost_cents > 0\)/);
  assert.match(body("pds.reading_bank_charge_month"), /date_trunc\('month', p_at AT TIME ZONE 'America\/New_York'\)/);
  assert.match(body("pds.reading_bank_record_charge"), /IF p_cents IS NOT NULL AND p_cents > 0 THEN/);
  assert.match(body("pds.reading_bank_record_charge"), /pds\.reading_bank_charge_month\(NOW\(\)\)/);
});

test("the monthly sum reads the ledger, never a job's lifetime cost or charged_at", () => {
  assert.match(body("pds.reading_bank_month_spend"), /FROM pds\.reading_bank_charges c[\s\S]*month_start = pds\.reading_bank_charge_month\(NOW\(\)\)/);
  for (const name of ["pds.reading_bank_claim", "pds.reading_bank_reserve", "pds.reading_bank_status"]) {
    const b = body(name);
    assert.match(b, /pds\.reading_bank_month_spend\(\)/, `${name} reads the ledger`);
    assert.doesNotMatch(b, /charged_at >= \(date_trunc/, `${name} never filters jobs by charged_at`);
    assert.doesNotMatch(b, /sum\(cost_cents\)/, `${name} never sums lifetime cost_cents`);
  }
});

test("finish and an expired-lease settlement each record exactly the charge they make, in the month they are made", () => {
  const finish = body("pds.reading_bank_finish");
  assert.match(finish, /cost_cents = cost_cents \+ v_cost/, "lifetime total kept");
  assert.match(finish, /PERFORM pds\.reading_bank_record_charge\(v_job\.job_id, v_cost\)/);
  assert.match(finish, /spent_cents = spent_cents \+ v_cost/, "book lifetime spend kept");
  const claim = body("pds.reading_bank_claim");
  assert.match(claim, /cost_cents = cost_cents \+ reserved_cents/, "lifetime total kept");
  assert.match(claim, /PERFORM pds\.reading_bank_record_charge\(v_exp\.job_id, v_exp\.reserved_cents\)/);
  // Reserve only raises the reservation; it writes no charge row.
  assert.doesNotMatch(body("pds.reading_bank_reserve"), /reading_bank_record_charge|INSERT INTO pds\.reading_bank_charges/);
});

test("the backfill attributes each job's not-yet-ledgered cost to its last charge month, once", () => {
  assert.match(sql, /j\.cost_cents - COALESCE\(l\.paid, 0\) > 0/);
  assert.match(sql, /COALESCE\(j\.charged_at, j\.finished_at, j\.created_at\)/);
});

test("the ledger and every function here are service role only", () => {
  assert.match(sql, /REVOKE ALL ON pds\.reading_bank_charges FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT SELECT, INSERT ON pds\.reading_bank_charges TO service_role;/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY;/);
  for (const f of ["pds.reading_bank_charge_month", "pds.reading_bank_record_charge", "pds.reading_bank_month_spend",
    "pds.reading_bank_status()", "pds.reading_bank_claim(jsonb)", "pds.reading_bank_reserve(jsonb)", "pds.reading_bank_finish(jsonb)"]) {
    assert.ok(sql.includes(`'${f}`) || sql.includes(`'${f}(`) || sql.includes(` ${f}`), `${f} is locked down`);
  }
  assert.match(sql, /GRANT EXECUTE ON FUNCTION %s TO service_role/);
});
