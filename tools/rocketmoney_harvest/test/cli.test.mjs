// Synthetic data only: this repository is public.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryStore, syntheticCsv } from "./memory-store.mjs";
import { rowsFromCsv } from "../lib/normalize.mjs";
import { heartbeatRow, runImportCli } from "../lib/cli.mjs";
import { importBalances, importTransactions } from "../lib/importer.mjs";

function harness(store) {
  const lines = [];
  return { lines, print: (l) => lines.push(l), storeFactory: async () => store };
}
const csvLoader = async (p) => {
  const { readFileSync } = await import("node:fs");
  return rowsFromCsv(readFileSync(p, "utf8")).rows;
};
function tmpFile(content) {
  const dir = mkdtempSync(join(tmpdir(), "rm-test-"));
  const path = join(dir, "x.csv");
  writeFileSync(path, content);
  return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = (argv, h, extra = {}) =>
  runImportCli({ argv, dataType: "transactions", usage: "u", load: csvLoader, execute: importTransactions, print: h.print, storeFactory: h.storeFactory, ...extra });

test("success: exit 0, ONE json line of counts, success heartbeat, no row content anywhere", async () => {
  const f = tmpFile(syntheticCsv());
  try {
    const store = memoryStore();
    const h = harness(store);
    const code = await run([f.path], h);
    assert.equal(code, 0);
    assert.equal(h.lines.length, 1);
    const out = JSON.parse(h.lines[0]);
    assert.deepEqual(out, { ok: true, dry_run: false, rows: 5, accounts: 3, inserted: 5, updated: 0, skipped: 0, errors: 0, heartbeat: "ok" });
    for (const secret of ["ACME", "WIDGETS", "PAYROLL", "Test Card", "2500", "1111"]) assert.equal(h.lines[0].includes(secret), false, secret);
    assert.equal(store.heartbeats.length, 1);
    const hb = store.heartbeats[0];
    assert.equal(hb.source, "rocketmoney");
    assert.equal(hb.data_type, "transactions");
    assert.equal(hb.status, "success");
    assert.equal(hb.records_synced, 5);
    assert.equal(hb.error_message, null);
    assert.equal(hb.date_range_start, "2026-01-05");
    assert.equal(hb.date_range_end, "2026-01-08");
    assert.ok(hb.sync_start && hb.sync_end && typeof hb.duration_seconds === "number");
    assert.equal(JSON.stringify(hb).includes("ACME"), false);
  } finally {
    f.done();
  }
});

test("dry run: exit 0, no heartbeat, nothing written", async () => {
  const f = tmpFile(syntheticCsv());
  try {
    const store = memoryStore();
    const h = harness(store);
    const code = await run([f.path, "--dry-run"], h);
    assert.equal(code, 0);
    const out = JSON.parse(h.lines[0]);
    assert.equal(out.dry_run, true);
    assert.equal(out.heartbeat, "skipped");
    assert.deepEqual(store.writes, { accounts: 0, transactions: 0, snapshots: 0, heartbeats: 0 });
  } finally {
    f.done();
  }
});

test("some rejected rows: still imports the rest, heartbeat is partial with reasons only", async () => {
  const f = tmpFile(syntheticCsv(["not-a-date,,Cash,Test Checking ...2222,2222,Test Credit Union,LEAKY MERCHANT,,1.00,,,,,,"]));
  try {
    const store = memoryStore();
    const h = harness(store);
    const code = await run([f.path], h);
    assert.equal(code, 0);
    const out = JSON.parse(h.lines[0]);
    assert.equal(out.errors, 1);
    assert.deepEqual(out.rejected_by_reason, { bad_date: 1 });
    assert.equal(store.heartbeats[0].status, "partial");
    assert.match(store.heartbeats[0].error_message, /1 row\(s\) rejected: bad_date=1/);
    assert.equal(JSON.stringify([h.lines, store.heartbeats]).includes("LEAKY"), false);
  } finally {
    f.done();
  }
});

test("failure: exit 1, sanitized error on stdout and in a failed heartbeat", async () => {
  const f = tmpFile(syntheticCsv());
  try {
    const store = memoryStore({ failOn: "upsertTransactions" });
    const h = harness(store);
    const code = await run([f.path], h);
    assert.equal(code, 1);
    assert.equal(h.lines.length, 1);
    const out = JSON.parse(h.lines[0]);
    assert.equal(out.ok, false);
    assert.equal(out.heartbeat, "ok");
    assert.equal(h.lines[0].includes("SENSITIVE-VALUE"), false);
    assert.equal(store.heartbeats.length, 1);
    assert.equal(store.heartbeats[0].status, "failed");
    assert.equal(store.heartbeats[0].records_synced, 0);
    assert.equal(JSON.stringify(store.heartbeats[0]).includes("SENSITIVE-VALUE"), false);
  } finally {
    f.done();
  }
});

test("failure to read the input still produces a failed heartbeat", async () => {
  const store = memoryStore();
  const h = harness(store);
  const code = await run(["C:/definitely/missing/file.csv"], h);
  assert.equal(code, 1);
  assert.equal(store.heartbeats.length, 1);
  assert.equal(store.heartbeats[0].status, "failed");
  assert.equal(store.heartbeats[0].data_type, "transactions");
});

test("a dry run that fails writes no heartbeat", async () => {
  const store = memoryStore();
  const h = harness(store);
  const code = await run(["C:/definitely/missing/file.csv", "--dry-run"], h);
  assert.equal(code, 1);
  assert.equal(store.heartbeats.length, 0);
});

test("a failing heartbeat write does not change the outcome, only the heartbeat field", async () => {
  const f = tmpFile(syntheticCsv());
  try {
    const store = memoryStore({ failOn: "logHeartbeat" });
    const h = harness(store);
    const code = await run([f.path], h);
    assert.equal(code, 0);
    assert.equal(JSON.parse(h.lines[0]).heartbeat, "failed");
  } finally {
    f.done();
  }
});

test("usage errors and empty input fail without touching the database", async () => {
  const store = memoryStore();
  const h = harness(store);
  assert.equal(await run([], h), 1);
  assert.equal(await run(["a", "b"], h), 1);
  assert.equal(await run(["a", "--wat"], h), 1);
  assert.equal(store.writes.heartbeats, 0);
  const f = tmpFile("Date,Account Type,Account Name,Institution Name,Name,Amount\n");
  try {
    assert.equal(await run([f.path], h), 1);
    assert.equal(store.heartbeats.at(-1).status, "failed");
  } finally {
    f.done();
  }
});

test("balances CLI writes a 'balances' heartbeat and prints counts only", async () => {
  const store = memoryStore();
  const h = harness(store);
  const f = tmpFile(JSON.stringify([{ institution: "Test Brokerage", account_name: "Hidden Acct Name", account_type: "Investment", mask: "9", balance_cents: 987654321, captured_at: "2026-11-12T15:00:00Z" }]));
  try {
    const code = await runImportCli({
      argv: [f.path],
      dataType: "balances",
      usage: "u",
      load: async (p) => JSON.parse((await import("node:fs")).readFileSync(p, "utf8")),
      execute: importBalances,
      print: h.print,
      storeFactory: h.storeFactory,
    });
    assert.equal(code, 0);
    assert.equal(h.lines[0].includes("987654321"), false);
    assert.equal(h.lines[0].includes("Hidden"), false);
    assert.equal(store.heartbeats[0].data_type, "balances");
    assert.equal(store.heartbeats[0].status, "success");
  } finally {
    f.done();
  }
});

test("heartbeatRow shape and error masking", () => {
  const a = new Date("2026-11-12T10:00:00Z");
  const b = new Date("2026-11-12T10:00:07Z");
  const row = heartbeatRow({ dataType: "transactions", status: "failed", records: 0, startedAt: a, endedAt: b, error: 'bad value "secret thing" 123456789' });
  assert.equal(row.duration_seconds, 7);
  assert.equal(row.error_message.includes("secret thing"), false);
  assert.equal(row.error_message.includes("123456789"), false);
  assert.equal("date_range_start" in row, false);
});
