// Orchestration of one harvest run, with every side effect injected so tests can drive it with mocks:
//   capture()      -> opens the signed-in app and returns the app's own GraphQL responses (Playwright, in harvest.mjs)
//   runImporter()  -> runs import-balances.mjs on a file and returns its one-line JSON summary
//   getStore()     -> the data layer used for failure heartbeats
//   recycle()      -> sends a folder to the Windows Recycle Bin
// Exit codes: 0 ok (or skipped: lock held / ran < 20 h ago), 1 failed, 2 login required.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heartbeatRow } from "./cli.mjs";
import { acquireLock, buildBalanceEntries, MAX_KEPT_TMP, readJson, selectToPrune, shouldRun, tmpFolderName } from "./harvest-core.mjs";
import { safeError } from "./normalize.mjs";

export async function runHarvest({ force = false, dryRun = false, now = new Date(), statePath, lockPath, tmpRoot, capture, runImporter, getStore, recycle, log = () => {} }) {
  const release = acquireLock(lockPath, { now: now.getTime() });
  if (!release) {
    log("another harvest run holds the lock; exiting without doing anything");
    return 0;
  }
  const state = readJson(statePath, {});
  const writeState = (patch) => {
    try { writeFileSync(statePath, JSON.stringify({ ...state, ...patch }, null, 1)); } catch { /* state is best effort */ }
  };

  async function fail(reason, code) {
    log(`FAILED: ${reason}`);
    if (!dryRun) {
      try {
        await (await getStore()).logHeartbeat(heartbeatRow({ dataType: "balances", status: "failed", records: 0, startedAt: now, endedAt: new Date(), error: reason }));
      } catch {
        log("could not write the failed heartbeat");
      }
    }
    return code;
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
      cap = await capture();
    } catch (e) {
      return await fail(`could not read the app: ${safeError(e)}`, 1);
    }
    if (cap.status === "login_required") {
      // Not an attempt at the data: let the next run (after signing in) go ahead without --force.
      if (!dryRun) writeState({ lastAttemptAt: state.lastAttemptAt ?? null });
      return await fail("login required: sign in again in the Rocket Money harvester profile (see README)", 2);
    }
    if (cap.status !== "ok") return await fail(cap.error || "the app did not return account data", 1);

    const entries = buildBalanceEntries({ networth: cap.networth, accounts: cap.accounts, capturedAt: now.toISOString() });
    if (!entries.length) return await fail("the app's responses contained no accounts (response format may have changed)", 1);
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
      if (!dryRun) writeState({ lastAttemptAt: now.toISOString(), lastSuccessAt: new Date().toISOString() });
      return 0;
    }
    // Keep the scratch file for diagnosis, but never more than MAX_KEPT_TMP folders.
    const kept = readdirSync(tmpRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const name of selectToPrune(kept, MAX_KEPT_TMP)) await recycle(join(tmpRoot, name));
    log(`import failed (${summary?.error ?? "no summary"}); kept the scratch folder for diagnosis`);
    // import-balances.mjs normally wrote its own failed heartbeat; when it could not (no summary, or the
    // heartbeat write itself failed) write one here so /status never misses the failure.
    if (!dryRun && summary?.heartbeat !== "ok") return await fail(`balance import failed: ${summary?.error ?? "the importer produced no summary"}`, 1);
    return 1;
  } catch (e) {
    return await fail(`unexpected error: ${safeError(e)}`, 1);
  } finally {
    release();
  }
}
