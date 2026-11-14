// Orchestration of one harvest run, with every side effect injected so tests can drive it with mocks:
//   capture()      -> opens the signed-in app and returns the app's own data (Playwright, lib/browser.mjs):
//                     the Net Worth and account-list responses plus the transaction pages read from inside the page;
//                     with { full: false } it only opens the app so its session is renewed (a keep-alive visit)
//   profileChangedAt() -> when the browser profile's cookie file last changed (to notice a sign-in by hand)
//   runImporter()  -> runs import-balances.mjs on a file and returns its one-line JSON summary
//   getStore()     -> the data layer (transactions are ingested in-process; also used for failure heartbeats)
//   recycle()      -> sends a folder to the Windows Recycle Bin
// Two independent steps share one capture: balances (child importer, heartbeat rocketmoney|balances) and
// transactions (in-process, heartbeat rocketmoney|transactions). One failing does not stop the other.
// The task runs every 2 hours. A run imports when 20 hours have passed since the last import (or with --force,
// or on the first signed-in look after being signed out); otherwise it is a keep-alive visit that writes
// nothing to the ledger tables. Losing the sign-in is reported at once, by any kind of run, as a failed
// heartbeat for both data types with what was seen (lib/session.mjs loginReason). Every keep-alive visit also
// writes a rocketmoney|keepalive heartbeat (success, or partial on the first failed visit in a row and failed
// from the second, since the app session outlives one missed visit but not two); the /status card reads it.
// Exit codes: 0 ok (import, keep-alive, or lock held), 1 failed, 2 login required.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heartbeatRow } from "./cli.mjs";
import { acquireLock, buildBalanceEntries, MAX_KEPT_TMP, readJson, selectToPrune, tmpFolderName } from "./harvest-core.mjs";
import { safeError } from "./normalize.mjs";
import { loginReason, scheduleWarning, sessionLine, signedInPatch, signedOutPatch, signInServiceNote, visitPlan } from "./session.mjs";
import { DEFAULT_DAYS, ingestWebTransactions, webAccountRefs, windowStart } from "./web-transactions.mjs";

export const LOGIN_REASON = "login required: run node harvest.mjs --login";

export async function runHarvest({ force = false, dryRun = false, days = DEFAULT_DAYS, now = new Date(), statePath, lockPath, tmpRoot, capture, runImporter, getStore, recycle, profileChangedAt = () => null, log = () => {} }) {
  const release = acquireLock(lockPath, { now: now.getTime() });
  if (!release) {
    log("another harvest run holds the lock; exiting without doing anything");
    return 0;
  }
  const state = readJson(statePath, {});
  const before = { ...state }; // what was known before this visit: the failure text is built from it
  const writeState = (patch) => {
    if (dryRun) return;
    Object.assign(state, patch);
    try { writeFileSync(statePath, JSON.stringify(state, null, 1)); } catch { /* state is best effort */ }
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
  // The sign-in is gone: say what was seen, remember since when, and make the first signed-in visit import.
  async function signedOut(seen) {
    if (seen?.path) log(`sign-in round trip: ${seen.path}`);
    writeState(signedOutPatch(before, { now, endedAt: new Date() }));
    return await fail(loginReason(LOGIN_REASON, { seen, state: before, now }), 2);
  }
  // A keep-alive visit that went wrong for a reason other than a lost sign-in: visible on /status.
  async function keepaliveFailed(reason) {
    const inARow = (Number(before.keepaliveFailures) || 0) + 1;
    writeState({ lastVisitEndedAt: new Date().toISOString(), keepaliveFailures: inARow });
    const text = `keep-alive visit failed (${inARow} in a row): ${reason}`;
    log(text);
    await beat("keepalive", { status: inARow >= 2 ? "failed" : "partial", records: 0, error: text });
    return 1;
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
    // A refusal here (401/403, UNAUTHENTICATED) came after a landing that proved the session alive, so it is
    // a failed transactions read, not a lost sign-in: entering the signed-out state would stop the keep-alive
    // visits for 20 hours and let a live session lapse. The next visit's landing decides about the sign-in.
    if (!tx.ok && tx.login) return await fail(`the transactions read was refused although the app was signed in (${tx.error || "no detail"}); the next visit checks the sign-in`, 1, ["transactions"]);
    if (!tx.ok) return await fail(tx.error || "the app did not return transactions", 1, ["transactions"]);
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
    const plan = visitPlan({ state: before, now, force, dryRun, profileChangedAt: profileChangedAt() });
    if (plan.mode === "skip") {
      log(`signed out since ${before.signedOutSince}; checked ${plan.hoursSince} h ago. Not opening the sign-in page again until someone signs in (node harvest.mjs --login) or 20 h have passed`);
      return 2;
    }
    const full = plan.mode === "full";
    if (full) writeState({ lastAttemptAt: now.toISOString() });

    let cap;
    try {
      cap = await capture({ gteDate: windowStart(now, days), full });
    } catch (e) {
      // A keep-alive that could not start is not an import failure, but it is reported (keepalive heartbeat).
      if (!full) return await keepaliveFailed(`could not read the app: ${safeError(e)}`);
      writeState({ lastVisitEndedAt: new Date().toISOString() });
      return await fail(`could not read the app: ${safeError(e)}`, 1);
    }
    if (cap.status === "login_required") return await signedOut(cap.seen);
    if (cap.status !== "ok") {
      if (!full) return await keepaliveFailed(cap.error || "the app did not return account data");
      writeState({ lastVisitEndedAt: new Date().toISOString() });
      return await fail(cap.error || "the app did not return account data", 1);
    }

    // Signed in. Record it (names and lifetimes of the session cookies only) before anything else can fail.
    const patch = signedInPatch(before, { now, endedAt: new Date(), session: cap.session ?? null, seen: cap.seen ?? null });
    writeState(patch);
    log(sessionLine(cap.session));
    for (const line of [scheduleWarning(cap.session), signInServiceNote(cap.session)]) if (line) log(line);
    if (cap.seen?.silentTried) log(`sign-in round trip: ${cap.seen.path}`);
    const renewal = cap.seen?.silentRenewed ? "the app session had lapsed and was renewed without a sign-in" : "the app session was still alive";
    log(`signed in: ${renewal} (visit ${patch.visitsSinceSignIn} since ${patch.signedInSince})`);
    if (!full) {
      log(`keep-alive visit ok; last import attempt ${plan.hoursSince} h ago (next import at 20 h)`);
      await beat("keepalive", { status: "success", records: 0, error: null });
      return 0;
    }

    const balancesCode = await balancesStep(cap);
    const transactionsCode = await transactionsStep(cap);
    if (balancesCode === 0 && transactionsCode === 0) {
      writeState({ lastAttemptAt: now.toISOString(), lastSuccessAt: new Date().toISOString() });
      return 0;
    }
    return Math.max(balancesCode, transactionsCode);
  } catch (e) {
    return await fail(`unexpected error: ${safeError(e)}`, 1);
  } finally {
    release();
  }
}
