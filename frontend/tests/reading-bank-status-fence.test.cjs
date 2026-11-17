// Reading question bank: the status read after an unanswered finish is bound to this claim's fence
// (job_id, attempts, claim_seq). Offline: a fake Supabase client with an in-memory jobs table that applies the
// .eq() filters it is given, so a row from another claim is never returned. Synthetic data only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

function FakeAnthropic() {}
const stubs = {
  "server-only": {},
  "@anthropic-ai/sdk": FakeAnthropic,
  "./reading-recall-server": {},
  "@/lib/reading-recall-server": {},
  "next/server": { NextResponse: { json: (body) => body }, after: () => {} },
  "@supabase/supabase-js": { createClient: () => ({}) },
};
const S = loadTs("lib/reading-bank-server.ts", stubs);

const JOB_ID = 9;

/** A fake client: rpc("reading_bank_finish") fails once (no answer), then answers not_running; the jobs table is a row list. */
function fakeSupabase(row) {
  const rows = row ? [row] : [];
  return {
    rpc: async () => ({ data: { ok: false, code: "not_running" }, error: null }),
    from(table) {
      assert.equal(table, "reading_bank_jobs");
      const filters = [];
      const builder = {
        select: () => builder,
        eq: (col, val) => {
          filters.push([col, val]);
          return builder;
        },
        limit: async () => {
          const data = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
          return { data, error: null };
        },
      };
      return builder;
    },
  };
}

/** Finish the claim once with the transport error first, so the status read runs. */
async function finishWith(supabase, job, outcome) {
  let calls = 0;
  supabase.rpc = async (name) => {
    calls += 1;
    if (calls === 1) return { data: null, error: { message: "network" } };
    return { data: { ok: false, code: "not_running" }, error: null };
  };
  const ctx = { client: {}, monthCapCents: 3000, now: () => 0, deadline: 1e12, stepScale: 1 };
  const run = new S.JobRun(supabase, job, ctx);
  return run.finish(outcome, null);
}

const claimed = { job_id: JOB_ID, step: "highlights", chapter: 2, attempts: 2, claim_seq: 5, status: "running" };

test("a status is returned when the row carries this claim's fence", async () => {
  const row = { job_id: JOB_ID, attempts: 2, claim_seq: 5, status: "done", error_code: null };
  const out = await finishWith(fakeSupabase(row), claimed, "done");
  assert.equal(out.outcome, "done");
  assert.equal(out.lost, undefined);
});

test("a row from a later claim (same job, higher claim_seq) is not taken as this run's status", async () => {
  const row = { job_id: JOB_ID, attempts: 2, claim_seq: 6, status: "done", error_code: null };
  const out = await finishWith(fakeSupabase(row), claimed, "done");
  assert.equal(out.lost, true);
  assert.equal(out.outcome, "retry");
  assert.equal(out.code, "not_running");
});

test("a row with a different attempts number is not taken as this run's status", async () => {
  const row = { job_id: JOB_ID, attempts: 3, claim_seq: 5, status: "done", error_code: null };
  const out = await finishWith(fakeSupabase(row), claimed, "done");
  assert.equal(out.lost, true);
  assert.equal(out.outcome, "retry");
});

test("the query itself filters on job_id, attempts and claim_seq", async () => {
  const seen = [];
  const sb = {
    rpc: async () => ({ data: null, error: { message: "network" } }),
    from() {
      const b = {
        select: () => b,
        eq: (col, val) => {
          seen.push([col, val]);
          return b;
        },
        limit: async () => ({ data: [], error: null }),
      };
      return b;
    },
  };
  await finishWith(sb, claimed, "done");
  assert.deepEqual(seen, [["job_id", JOB_ID], ["attempts", 2], ["claim_seq", 5]]);
});
