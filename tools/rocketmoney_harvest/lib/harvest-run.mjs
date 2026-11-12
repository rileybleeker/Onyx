// Orchestration of one harvest run, with every side effect injected so tests can drive it with mocks:
//   capture()      -> opens the signed-in app and returns the app's own data (Playwright, in harvest.mjs):
//                     the Net Worth and account-list responses plus the transaction pages read from inside the page
//   runImporter()  -> runs import-balances.mjs on a file and returns its one-line JSON summary
//   getStore()     -> the data layer (transactions are ingested in-process; also used for failure heartbeats)
//   recycle()      -> sends a folder to the Windows Recycle Bin
// Two independent steps share one capture: balances (child importer, heartbeat rocketmoney|balances) and
// transactions (in-process, heartbeat rocketmoney|transactions). One failing does not stop the other.
// Exit codes: 0 ok (or skipped: lock held / ran < 20 h ago), 1 failed, 2 login required.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heartbeatRow } from "./cli.mjs";
import { acquireLock, buildBalanceEntries, MAX_KEPT_TMP, readJson, selectToPrune, shouldRun, tmpFolderName } from "./harvest-core.mjs";
import { safeError } from "./normalize.mjs";
import { DEFAULT_DAYS, ingestWebTransactions, webAccountRefs, windowStart } from "./web-transactions.mjs";

const LOGIN_REASON = "login required: sign in again in the Rocket Money harvester profile (see README)";

export async function runHarvest({ force = false, dryRun = false, days = DEFAULT_DAYS, now = new Date(), statePath, lockPath, tmpRoot, capture, runImporter, getStore, recycle, log = () => {} }) {
  const release = acquireLock(lockPath, { now: now.getTime() });
  if (!release) {
    log("another harvest run holds the lock; exiting without doing anything");
    return 0;
  }
  const state = readJson(statePath, {});
  const writeState = (patch) => {
    try { writeFileSync(statePath, JSON.stringify({ ...state, ...patch }, null, 1)); } catch { /* state is best effort */ }
  };

  async function beat(dataType, fields) {
    if (dryRun) return true;
    try {
      await (await getStore()).logHeartbeat(heartbeatRow({ dataType, startedAt: now, endedAt: new Date(), ...fields }));
      return true;
    } catch {
      log(`could not write the ${dataType} heartbeat`);
      return false;
    }
  }
  // A failure before either step ran (or in one step) is recorded for the data types it affects.
  async function fail(reason, code, types = ["balances", "transactions"]) {
    log(`FAILED: ${reason}`);
    for (const dataType of types) await beat(dataType, { status: "failed", records: 0, error: reason });
    return code;
  }

  async function balancesStep(cap) {
    const entries = buildBalanceEntries({ networth: cap.networth, accounts: cap.accounts, capturedAt: now.toISOString() });
    if (!entries.length) return await fail("the app's responses contained no accounts (response format may have changed)", 1, ["balances"]);
    log(`read ${entries.length} account balance(s) from the app`);

    mkdirSync(tmpRoot, { recursive: true });
    const folder = join(tmpRoot, tmpFolderName(now));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "balances.json");
    writeFileSync(file, JSON.stringify(entries));

    const summary = await runImporter(file, { dryRun });
    if (summary && summary.ok) {
      log(`import ok: ${JSON.stringify(Object.fromEntries(["rows", "accounts", "inserted", "skipped", "errors"].map((k) => [k, summary[k]])))}`);
      if (!(await recycle(folder))) log("could not move the scratch folder to the Recycle Bin; it was left in place");
      return 0;
    }
    // Keep the scratch file for diagnosis, but never more than MAX_KEPT_TMP folders.
    const kept = readdirSync(tmpRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const name of selectToPrune(kept, MAX_KEPT_TMP)) await recycle(join(tmpRoot, name));
    log(`import failed (${summary?.error ?? "no summary"}); kept the scratch folder for diagnosis`);
    // import-balances.mjs normally wrote its own failed heartbeat; when it could not (no summary, or the
    // heartbeat write itself failed) write one here so /status never misses the failure.
    if (!dryRun && summary?.heartbeat !== "ok") return await fail(`balance import failed: ${summary?.error ?? "the importer produced no summary"}`, 1, ["balances"]);
    return 1;
  }

  async function transactionsStep(cap) {
    const tx = cap.transactions;
    if (!tx) return await fail("the app's transactions were not read", 1, ["transactions"]);
    if (!tx.ok) return await fail(tx.login ? LOGIN_REASON : tx.error || "the app did not return transactions", tx.login ? 2 : 1, ["transactions"]);
    let result;
    try {
      result = await ingestWebTransactions({
        nodes: tx.rows ?? [],
        accountRefs: webAccountRefs(cap.accounts),
        store: await getStore(),
        dryRun,
        now,
        gteDate: windowStart(now, days),
      });
    } catch (e) {
      return await fail(`transaction import failed: ${safeError(e)}`, 1, ["transactions"]);
    }
    const { rejected_by_reason, date_min, date_max, ...counts } = result;
    log(`transactions ${dryRun ? "(dry run) " : ""}${JSON.stringify(counts)}`);
    if (!result.rows) {
      return await fail(`no readable transactions in the last ${days} days (fetched ${result.fetched}, pending ${result.pending_skipped}, rejected ${result.errors}; the response format may have changed)`, 1, ["transactions"]);
    }
    const problems = result.errors + result.ambiguous;
    const reasonText = Object.entries(rejected_by_reason).map(([k, v]) => `${k}=${v}`).join(", ");
    const ok = await beat("transactions", {
      status: problems ? "partial" : "success",
      records: result.inserted + result.updated + result.attached,
      error: problems ? `${result.errors} row(s) rejected, ${result.ambiguous} left alone as ambiguous: ${reasonText}` : null,
      dateMin: date_min,
      dateMax: date_max,
    });
    return ok ? 0 : 1;
  }

  try {
    const gate = shouldRun({ lastAttemptAt: state.lastAttemptAt, now, force });
    if (!gate.run) {
      log(`last run was ${gate.hoursSince} h ago (< 20 h); not running again (use --force to override)`);
      return 0;
    }
    if (!dryRun) writeState({ lastAttemptAt: now.toISOString() });

    let cap;
    try {
      cap = await capture({ gteDate: windowStart(now, days) });
    } catch (e) {
      return await fail(`could not read the app: ${safeError(e)}`, 1);
    }
    if (cap.status === "login_required") {
      // Not an attempt at the data: let the next run (after signing in) go ahead without --force.
      if (!dryRun) writeState({ lastAttemptAt: state.lastAttemptAt ?? null });
      return await fail(LOGIN_REASON, 2);
    }
    if (cap.status !== "ok") return await fail(cap.error || "the app did not return account data", 1);

    const balancesCode = await balancesStep(cap);
    const transactionsCode = await transactionsStep(cap);
    if (!dryRun && cap.transactions?.login) writeState({ lastAttemptAt: state.lastAttemptAt ?? null });
    if (balancesCode === 0 && transactionsCode === 0) {
      if (!dryRun) writeState({ lastAttemptAt: now.toISOString(), lastSuccessAt: new Date().toISOString() });
      return 0;
    }
    return Math.max(balancesCode, transactionsCode);
  } catch (e) {
    return await fail(`unexpected error: ${safeError(e)}`, 1);
  } finally {
    release();
  }
}
