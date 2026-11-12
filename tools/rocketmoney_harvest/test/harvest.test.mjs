// Synthetic data only: this repository is public. No browser, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryStore } from "./memory-store.mjs";
import {
  accountTypeLabel,
  acquireLock,
  buildBalanceEntries,
  classifyResponse,
  isGraphqlUrl,
  isLoginUrl,
  isMutationRequest,
  parseSummaryLine,
  selectToPrune,
  shouldRun,
  tmpFolderName,
} from "../lib/harvest-core.mjs";
import { runHarvest } from "../lib/harvest-run.mjs";
import { importBalances } from "../lib/importer.mjs";

// --- fixtures shaped like the app's responses (fake names and numbers) ----------------------------------------
const gid = (type, n) => Buffer.from(`${type}:${n}`).toString("base64");
const NETWORTH = {
  data: {
    viewer: {
      netWorth: {
        cash: [{ id: "n1", name: "Test Checking", valueCents: 123456, type: "checking", accountNodeId: gid("Account", 1), institution: { name: "Test Bank" } }],
        savings: [{ id: "n2", name: "Test Savings", valueCents: 50000, accountNodeId: gid("Account", 2), institution: { name: "Test Bank" } }],
        investments: [{ id: "n3", name: "Test Brokerage", valueCents: 9000000, accountNodeId: gid("Account", 3), institution: { name: "Test Invest" } }],
        other: [{ id: "n4", name: "Test Car", valueCents: 1500000, assetNodeId: "x1", accountNodeId: null, institution: null }],
        assetsWithLoan: [],
        creditCardDebts: [{ id: "n5", name: "Test Card", balanceCents: 4200, accountNodeId: gid("Account", 4), institution: { name: "Test Bank" } }],
        longTermDebts: [],
        assetBackedLoans: [],
        otherDebts: [],
      },
    },
  },
};
const acct = (id, name, number, customType, displayedBalance, institution, extra = {}) => ({
  node: { id, name, number, customType, displayedBalance, enabled: true, applicable: true, isIssuedCard: false, ...extra },
  inst: institution,
});
function accountsResponse(list) {
  const byInst = new Map();
  for (const a of list) byInst.set(a.inst, [...(byInst.get(a.inst) ?? []), { node: a.node }]);
  return { data: { viewer: { masterAccounts: { edges: [...byInst].map(([name, accounts]) => ({ node: { institution: { name }, accounts: { edges: accounts } } })) } } } };
}
const ACCOUNTS = accountsResponse([
  acct(gid("Account", 1), "Test Checking", "1111", "checking", 123456, "Test Bank"),
  acct(gid("Account", 2), "Test Savings", "2222", "saving", 50000, "Test Bank"),
  acct(gid("Account", 3), "Test Brokerage", "3333", "investment", 9000000, "Test Invest"),
  acct(gid("Account", 4), "Test Card", "", "credit", 4200, "Test Bank"),
]);
const CAPTURED_AT = "2026-11-12T12:00:00.000Z";
const txNode = (id, over = {}) => ({
  id: gid("Transaction", id),
  shortName: "Test Shop",
  longName: "TEST SHOP #1",
  amount: 1250,
  date: "2026-11-10",
  note: null,
  taxDeductible: false,
  pending: false,
  ignoredFrom: null,
  category: { label: "Shopping" },
  account: { id: gid("Account", 4) },
  ...over,
});
const TRANSACTIONS = { ok: true, rows: [txNode(1), txNode(2, { amount: 300, account: { id: gid("Account", 1) } }), txNode(3, { pending: true })] };
const okCapture = (over = {}) => async () => ({ status: "ok", networth: NETWORTH, accounts: ACCOUNTS, transactions: TRANSACTIONS, ...over });

test("classifyResponse recognizes the two responses and nothing else", () => {
  assert.equal(classifyResponse(NETWORTH), "networth");
  assert.equal(classifyResponse(ACCOUNTS), "accounts");
  assert.equal(classifyResponse({ data: { viewer: { id: "x" } } }), null);
  assert.equal(classifyResponse({ data: { viewer: { masterAccounts: { edges: [{ node: { accounts: { edges: [{ node: { id: "1" } }] } } }] } } } }), null);
  assert.equal(classifyResponse({ errors: [] }), null);
  assert.equal(classifyResponse(null), null);
});

test("buildBalanceEntries: type labels, kinds, masks and manual assets", () => {
  const entries = buildBalanceEntries({ networth: NETWORTH, accounts: ACCOUNTS, capturedAt: CAPTURED_AT });
  assert.equal(entries.length, 5);
  const byName = Object.fromEntries(entries.map((e) => [e.account_name, e]));
  assert.deepEqual(byName["Test Checking"], { institution: "Test Bank", account_name: "Test Checking", account_type: "Cash", mask: "1111", balance_cents: 123456, currency: "USD", kind: "asset", captured_at: CAPTURED_AT });
  assert.equal(byName["Test Savings"].account_type, "Cash");
  assert.equal(byName["Test Brokerage"].account_type, "Investment");
  assert.equal(byName["Test Card"].kind, "liability");
  assert.equal(byName["Test Card"].mask, null); // blank number -> no mask
  assert.equal(byName["Test Card"].balance_cents, 4200); // owed amounts stay positive
  assert.equal(byName["Test Car"].institution, "Manual");
  assert.equal(byName["Test Car"].account_type, "Other asset");
  assert.equal(byName["Test Car"].kind, "asset");
});

test("buildBalanceEntries: skips disabled accounts and falls back to net-worth cents when the list has none", () => {
  const accounts = accountsResponse([
    acct(gid("Account", 1), "Test Checking", "1111", "checking", null, "Test Bank"),
    acct(gid("Account", 2), "Test Savings", "2222", "saving", 50000, "Test Bank", { enabled: false }),
  ]);
  const entries = buildBalanceEntries({ networth: NETWORTH, accounts, capturedAt: CAPTURED_AT });
  const checking = entries.find((e) => e.account_name === "Test Checking");
  assert.equal(checking.balance_cents, 123456);
  assert.equal(entries.some((e) => e.account_name === "Test Savings"), false);
});

test("buildBalanceEntries: an unknown account type is still labeled and classified by name", () => {
  assert.equal(accountTypeLabel("checking"), "Cash");
  assert.equal(accountTypeLabel("saving"), "Cash");
  assert.equal(accountTypeLabel("credit"), "Credit Card");
  assert.equal(accountTypeLabel("mortgage"), "Loan");
  assert.equal(accountTypeLabel("brokerage_thing"), "Brokerage_thing");
  assert.equal(accountTypeLabel(undefined), "Unknown");
  const entries = buildBalanceEntries({ networth: { data: { viewer: { netWorth: {} } } }, accounts: accountsResponse([acct("z", "Test Loan", "9999", "mortgage", 777, "Test Lender")]), capturedAt: CAPTURED_AT });
  assert.equal(entries[0].kind, "liability");
});

test("balance entries import cleanly and re-running is idempotent", async () => {
  const entries = buildBalanceEntries({ networth: NETWORTH, accounts: ACCOUNTS, capturedAt: CAPTURED_AT });
  const store = memoryStore();
  const first = await importBalances(entries, { store, now: new Date(CAPTURED_AT) });
  assert.equal(first.errors, 0);
  assert.equal(first.inserted, 5);
  const again = await importBalances(entries, { store, now: new Date(CAPTURED_AT) });
  assert.equal(again.inserted, 0);
  assert.equal(store.snaps.size, 5);
});

test("isMutationRequest blocks mutations (single and batched) and lets reads through", () => {
  assert.equal(isMutationRequest(JSON.stringify({ operationName: "A", query: "mutation A { x }" })), true);
  assert.equal(isMutationRequest(JSON.stringify({ query: "\n  mutation SyncAccounts { x }" })), true);
  assert.equal(isMutationRequest(JSON.stringify([{ query: "query A { x }" }, { query: "mutation B { y }" }])), true);
  assert.equal(isMutationRequest(JSON.stringify({ query: "# comment\nmutation C { x }" })), true);
  assert.equal(isMutationRequest(JSON.stringify({ query: "query NetWorthQuery { viewer { id } }" })), false);
  assert.equal(isMutationRequest(JSON.stringify({ operationName: "X", extensions: { persistedQuery: {} } })), false);
  assert.equal(isMutationRequest("not json"), false);
  assert.equal(isMutationRequest(null), false);
  assert.equal(isMutationRequest("mutation raw"), true);
});

test("URL helpers", () => {
  assert.equal(isGraphqlUrl("https://client-api.rocketmoney.com/graphql"), true);
  assert.equal(isGraphqlUrl("https://client-api.rocketmoney.com/auth/canny/token"), false);
  assert.equal(isGraphqlUrl("https://evil.example/graphql"), false);
  assert.equal(isLoginUrl("https://auth.rocketaccount.com/login?x=1"), true);
  assert.equal(isLoginUrl("https://app.rocketmoney.com/login"), true);
  assert.equal(isLoginUrl("https://app.rocketmoney.com/net-worth"), false);
  assert.equal(isLoginUrl("not a url"), true);
});

test("the 20-hour rule", () => {
  const now = new Date("2026-11-12T20:00:00Z");
  assert.equal(shouldRun({ lastAttemptAt: "2026-11-12T10:00:00Z", now }).run, false);
  assert.equal(shouldRun({ lastAttemptAt: "2026-11-12T10:00:00Z", now }).hoursSince, 10);
  assert.equal(shouldRun({ lastAttemptAt: "2026-11-11T23:59:00Z", now }).run, true);
  assert.equal(shouldRun({ lastAttemptAt: "2026-11-12T10:00:00Z", now, force: true }).run, true);
  assert.equal(shouldRun({ lastAttemptAt: undefined, now }).run, true);
  assert.equal(shouldRun({ lastAttemptAt: "garbage", now }).run, true);
  assert.equal(shouldRun({ lastAttemptAt: "2026-11-13T10:00:00Z", now }).run, true); // clock moved backwards
});

test("lock: exclusive, released on request, and a stale lock is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-lock-"));
  try {
    const path = join(dir, "harvest.lock");
    const release = acquireLock(path, { now: Date.now() });
    assert.equal(typeof release, "function");
    assert.equal(acquireLock(path, { now: Date.now() }), null);
    release();
    assert.equal(existsSync(path), false);
    const second = acquireLock(path, { now: Date.now() });
    assert.equal(typeof second, "function");
    // a lock far older than the stale limit (clock 2 h ahead) is a crashed run
    const takeover = acquireLock(path, { now: Date.now() + 2 * 36e5 });
    assert.equal(typeof takeover, "function");
    takeover();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectToPrune keeps the three newest, tmpFolderName is a legal Windows name, parseSummaryLine reads the last JSON line", () => {
  assert.deepEqual(selectToPrune(["2026-01-01", "2026-01-02", "2026-01-03"]), []);
  assert.deepEqual(selectToPrune(["2026-01-05", "2026-01-01", "2026-01-04", "2026-01-02", "2026-01-03"]), ["2026-01-01", "2026-01-02"]);
  assert.equal(/[:*?"<>|]/.test(tmpFolderName(new Date("2026-11-12T03:22:06.436Z"))), false);
  assert.equal(tmpFolderName(new Date("2026-11-12T03:22:06.436Z")), "2026-11-12T03-22-06-436Z");
  assert.deepEqual(parseSummaryLine('noise\n{"ok":true,"rows":3}\n'), { ok: true, rows: 3 });
  assert.equal(parseSummaryLine("no json here"), null);
  assert.equal(parseSummaryLine(""), null);
});

// --- orchestration with mocks ---------------------------------------------------------------------------
function rig({ capture, importer, state, failStore = false, failOn = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rm-run-"));
  const store = memoryStore({ failOn: failStore ? "logHeartbeat" : failOn });
  const logs = [];
  const recycled = [];
  const paths = { statePath: join(dir, "state.json"), lockPath: join(dir, "harvest.lock"), tmpRoot: join(dir, "tmp") };
  if (state) writeFileSync(paths.statePath, JSON.stringify(state));
  const run = (opts = {}) =>
    runHarvest({
      ...paths,
      now: new Date("2026-11-12T12:00:00.000Z"),
      capture: capture ?? okCapture(),
      runImporter: importer ?? (async () => ({ ok: true, rows: 5, accounts: 5, inserted: 5, skipped: 0, errors: 0, heartbeat: "ok" })),
      getStore: async () => store,
      recycle: async (p) => { recycled.push(p); return true; },
      log: (l) => logs.push(l),
      ...opts,
    });
  return { dir, store, logs, recycled, paths, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("run: success writes balances.json to a fresh scratch folder, recycles it, records the attempt; the only heartbeat written here is the transactions one", async () => {
  let seenFile = null;
  const r = rig({
    importer: async (file) => {
      seenFile = file;
      const data = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(data.length, 5);
      return { ok: true, rows: 5, accounts: 5, inserted: 5, skipped: 0, errors: 0, heartbeat: "ok" };
    },
  });
  try {
    assert.equal(await r.run(), 0);
    assert.match(seenFile, /rm-run-.*[\\/]tmp[\\/]2026-11-12T12-00-00-000Z[\\/]balances\.json$/);
    assert.equal(r.recycled.length, 1);
    const state = JSON.parse(readFileSync(r.paths.statePath, "utf8"));
    assert.equal(state.lastAttemptAt, "2026-11-12T12:00:00.000Z");
    assert.ok(state.lastSuccessAt);
    // the balances importer wrote its own heartbeat; the in-process transactions step wrote exactly one
    assert.equal(r.store.heartbeats.length, 1);
    assert.equal(r.store.heartbeats[0].data_type, "transactions");
    assert.equal(r.store.heartbeats[0].status, "success");
    assert.equal(r.store.heartbeats[0].records_synced, 2); // the pending row is skipped
    assert.equal(r.logs.join("\n").includes("Test Shop"), false);
    assert.equal(existsSync(r.paths.lockPath), false);
    assert.equal(r.logs.join("\n").includes("Test Checking"), false);
  } finally {
    r.done();
  }
});

test("run: refuses a second run within 20 hours unless forced", async () => {
  const r = rig({ state: { lastAttemptAt: "2026-11-12T03:00:00.000Z" } });
  try {
    let called = 0;
    const capture = async () => { called++; return { status: "ok", networth: NETWORTH, accounts: ACCOUNTS, transactions: TRANSACTIONS }; };
    assert.equal(await r.run({ capture }), 0);
    assert.equal(called, 0);
    assert.equal(r.store.heartbeats.length, 0);
    assert.equal(await r.run({ capture, force: true }), 0);
    assert.equal(called, 1);
  } finally {
    r.done();
  }
});

test("run: not signed in -> failed 'login required' heartbeat, exit 2, and the next run is not blocked by the 20-hour rule", async () => {
  const r = rig({ capture: async () => ({ status: "login_required" }), state: { lastAttemptAt: "2026-11-10T00:00:00.000Z" } });
  try {
    assert.equal(await r.run(), 2);
    assert.deepEqual(r.store.heartbeats.map((h) => h.data_type).sort(), ["balances", "transactions"]);
    for (const hb of r.store.heartbeats) {
      assert.equal(hb.source, "rocketmoney");
      assert.equal(hb.status, "failed");
      assert.match(hb.error_message, /^login required/);
    }
    assert.equal(JSON.parse(readFileSync(r.paths.statePath, "utf8")).lastAttemptAt, "2026-11-10T00:00:00.000Z");
  } finally {
    r.done();
  }
});

test("run: capture errors and empty/odd responses write a failed heartbeat with a short reason", async () => {
  for (const [capture, expected] of [
    [async () => { throw new Error('launch failed near "C:\\Users\\someone\\profile" 123456789'); }, /could not read the app/],
    [async () => ({ status: "failed", error: "the Net Worth data did not load within 30 s" }), /did not load/],
    [async () => ({ status: "ok", networth: { data: { viewer: { netWorth: {} } } }, accounts: accountsResponse([]), transactions: TRANSACTIONS }), /no accounts/],
  ]) {
    const r = rig({ capture });
    try {
      assert.equal(await r.run(), 1);
      const failed = r.store.heartbeats.filter((h) => h.status === "failed" && expected.test(h.error_message));
      assert.ok(failed.length >= 1);
      for (const hb of r.store.heartbeats) assert.equal(/someone|123456789/.test(hb.error_message ?? ""), false);
    } finally {
      r.done();
    }
  }
});

test("run: a failed import keeps the scratch folder (max 3 kept) and does not double-heartbeat", async () => {
  const r = rig({ importer: async () => ({ ok: false, error: "write finance_balance_snapshots failed", heartbeat: "ok" }) });
  try {
    mkdirSync(r.paths.tmpRoot, { recursive: true });
    for (const n of ["2026-11-01T00-00-00-000Z", "2026-11-02T00-00-00-000Z", "2026-11-03T00-00-00-000Z"]) mkdirSync(join(r.paths.tmpRoot, n));
    assert.equal(await r.run(), 1);
    assert.deepEqual(r.store.heartbeats.map((h) => h.data_type), ["transactions"]); // the importer already wrote its failed balances heartbeat
    const left = readdirSync(r.paths.tmpRoot);
    assert.ok(left.includes("2026-11-12T12-00-00-000Z"));
    assert.equal(r.recycled.length, 1); // the oldest of four was pruned (mock recycle does not delete)
    assert.match(r.recycled[0], /2026-11-01T00-00-00-000Z$/);
  } finally {
    r.done();
  }
});

test("run: when the importer left no heartbeat the harvester writes the failed one", async () => {
  const r = rig({ importer: async () => null });
  try {
    assert.equal(await r.run(), 1);
    const balances = r.store.heartbeats.filter((h) => h.data_type === "balances");
    assert.equal(balances.length, 1);
    assert.equal(balances[0].status, "failed");
  } finally {
    r.done();
  }
});

test("run: a failing heartbeat write cannot crash the run", async () => {
  const r = rig({ capture: async () => ({ status: "login_required" }), failStore: true });
  try {
    assert.equal(await r.run(), 2);
    assert.ok(r.logs.some((l) => /could not write the (balances|transactions) heartbeat/.test(l)));
  } finally {
    r.done();
  }
});

test("run: dry run writes no heartbeat and no state, and still cleans up", async () => {
  const seen = [];
  const r = rig({ importer: async (file, opts) => { seen.push(opts.dryRun); return { ok: true, rows: 5, accounts: 5, inserted: 5, skipped: 0, errors: 0 }; } });
  try {
    assert.equal(await r.run({ dryRun: true }), 0);
    assert.deepEqual(seen, [true]);
    assert.equal(existsSync(r.paths.statePath), false);
    assert.equal(r.store.heartbeats.length, 0);
    assert.equal(r.recycled.length, 1);
    // dry run reads the database for the transactions step but writes nothing
    assert.deepEqual(r.store.writes, { accounts: 0, transactions: 0, snapshots: 0, heartbeats: 0 });
    assert.equal(r.store.txns.size, 0);
    assert.ok(r.logs.some((l) => /transactions \(dry run\) .*"inserted":2/.test(l)));
  } finally {
    r.done();
  }
});

test("run: another live run holding the lock makes this one exit quietly", async () => {
  const r = rig();
  try {
    // the lock's age is judged against the file's real modification time, so use the real clock for both sides
    const now = new Date();
    const release = acquireLock(r.paths.lockPath, { now: now.getTime() });
    let captured = 0;
    assert.equal(await r.run({ now, capture: async () => { captured++; return { status: "login_required" }; } }), 0);
    assert.equal(captured, 0, "a run that does not hold the lock must not touch the app");
    assert.equal(r.store.heartbeats.length, 0);
    release();
  } finally {
    r.done();
  }
});

// --- the transactions step -------------------------------------------------------------------------------------
test("run: the transactions window starts 60 days back (New York calendar) unless --days says otherwise", async () => {
  const seen = [];
  const capture = async (opts) => { seen.push(opts.gteDate); return { status: "ok", networth: NETWORTH, accounts: ACCOUNTS, transactions: TRANSACTIONS }; };
  const r = rig({ capture });
  try {
    assert.equal(await r.run(), 0);
    assert.equal(await r.run({ force: true, days: 400 }), 0);
    assert.deepEqual(seen, ["2026-09-13", "2025-10-08"]);
  } finally {
    r.done();
  }
});

test("run: running twice writes the transactions once (second run: all unchanged, no new rows)", async () => {
  const r = rig();
  try {
    assert.equal(await r.run(), 0);
    const keys = [...r.store.txns.keys()].sort();
    assert.equal(keys.length, 2);
    assert.equal(await r.run({ force: true, now: new Date("2026-11-13T12:00:00.000Z") }), 0);
    assert.deepEqual([...r.store.txns.keys()].sort(), keys);
    assert.deepEqual(r.store.heartbeats.map((h) => [h.data_type, h.status, h.records_synced]), [["transactions", "success", 2], ["transactions", "success", 0]]);
  } finally {
    r.done();
  }
});

test("run: a failed transactions read fails only the transactions heartbeat; balances still import", async () => {
  let imported = 0;
  const r = rig({
    capture: okCapture({ transactions: { ok: false, error: "the transactions request returned HTTP 500" } }),
    importer: async () => { imported++; return { ok: true, rows: 5, accounts: 5, inserted: 5, skipped: 0, errors: 0, heartbeat: "ok" }; },
  });
  try {
    assert.equal(await r.run(), 1);
    assert.equal(imported, 1);
    assert.deepEqual(r.store.heartbeats.map((h) => [h.data_type, h.status]), [["transactions", "failed"]]);
    assert.match(r.store.heartbeats[0].error_message, /HTTP 500/);
    assert.equal(r.store.txns.size, 0);
  } finally {
    r.done();
  }
});

test("run: the session expiring during the transactions read is 'login required' (exit 2) and the next run is not held back", async () => {
  const r = rig({ capture: okCapture({ transactions: { ok: false, error: "the transactions request was refused", login: true } }), state: { lastAttemptAt: "2026-11-10T00:00:00.000Z" } });
  try {
    assert.equal(await r.run(), 2);
    assert.match(r.store.heartbeats[0].error_message, /^login required/);
    assert.equal(JSON.parse(readFileSync(r.paths.statePath, "utf8")).lastAttemptAt, "2026-11-10T00:00:00.000Z");
  } finally {
    r.done();
  }
});

test("run: a balances failure does not stop the transactions step", async () => {
  const r = rig({ importer: async () => ({ ok: false, error: "write finance_balance_snapshots failed", heartbeat: "ok" }) });
  try {
    assert.equal(await r.run(), 1);
    assert.equal(r.store.txns.size, 2);
    assert.deepEqual(r.store.heartbeats.map((h) => [h.data_type, h.status]), [["transactions", "success"]]);
  } finally {
    r.done();
  }
});

test("run: a database failure while writing transactions is a failed heartbeat with a masked reason", async () => {
  const r = rig({ failOn: "upsertTransactions" });
  try {
    assert.equal(await r.run(), 1);
    const hb = r.store.heartbeats.find((h) => h.data_type === "transactions");
    assert.equal(hb.status, "failed");
    assert.match(hb.error_message, /transaction import failed/);
    assert.equal(hb.error_message.includes("SENSITIVE-VALUE"), false);
  } finally {
    r.done();
  }
});

test("run: unreadable or ambiguous transactions make the heartbeat 'partial' with counts, not a failure", async () => {
  const rows = [txNode(1), txNode(2, { date: "someday" }), txNode(3, { account: { id: gid("Account", 99) } })];
  const r = rig({ capture: okCapture({ transactions: { ok: true, rows } }) });
  try {
    assert.equal(await r.run(), 0);
    const hb = r.store.heartbeats[0];
    assert.equal(hb.status, "partial");
    assert.match(hb.error_message, /2 row\(s\) rejected/);
    assert.equal(hb.records_synced, 1);
    assert.equal(r.store.txns.size, 1);
  } finally {
    r.done();
  }
});

test("run: a window with no readable transactions at all is a failure (the format may have changed)", async () => {
  for (const rows of [[], [txNode(1, { date: "someday" })]]) {
    const r = rig({ capture: okCapture({ transactions: { ok: true, rows } }) });
    try {
      assert.equal(await r.run(), 1);
      const hb = r.store.heartbeats.find((h) => h.data_type === "transactions");
      assert.equal(hb.status, "failed");
      assert.match(hb.error_message, /no readable transactions/);
    } finally {
      r.done();
    }
  }
});

test("run: a capture that returns no transactions result at all is a failure, not a silent skip", async () => {
  const r = rig({ capture: async () => ({ status: "ok", networth: NETWORTH, accounts: ACCOUNTS }) });
  try {
    assert.equal(await r.run(), 1);
    assert.match(r.store.heartbeats.find((h) => h.data_type === "transactions").error_message, /were not read/);
  } finally {
    r.done();
  }
});
