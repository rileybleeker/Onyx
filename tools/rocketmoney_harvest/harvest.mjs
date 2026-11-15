// Onyx Rocket Money harvester: runs on Riley's PC (Task Scheduler "Onyx Rocket Money Harvest", every 2 hours).
//
// What it does: opens app.rocketmoney.com in a dedicated, already signed-in Chrome profile and READS the
// responses the web app itself loads for the Net Worth and Settings > Accounts pages (account list, last
// four digits, type, balance, asset or debt). It turns them into pds.finance_balance_snapshots rows by
// running import-balances.mjs. It never types, never clicks, never submits anything: it navigates to two
// pages and listens (plus the read-only Transactions queries described below). As a belt-and-braces guard it
// aborts any GraphQL request that is a mutation, in every tab, attached before any page loads (Chrome is never
// asked to re-open old tabs; see lib/browser.mjs), so even something the app fires on its own while loading
// cannot change the account.
//
// Transactions: from the same signed-in page it also reads the Transactions list the way the app's own list
// does (the app's operation, one extra read-only GraphQL query per page of 200, last 60 days by default) and
// upserts it by Rocket Money's own transaction id (lib/web-transactions.mjs). Pending rows are skipped. The
// export CSV is not used: its file name is only ever sent by email, and this harvester never reads email.
//
// Keeping the sign-in: Rocket Money's web session is short and rolling (it lapses a few hours after the app
// was last used), so the task runs every 2 hours. A run imports once 20 hours have passed since the last
// import; the runs in between only open the app so its session is renewed, write nothing to the ledger, and
// leave a rocketmoney|keepalive heartbeat so /status sees a failing keep-alive. A silent renewal through the
// sign-in service is followed instead of being read as "signed out". See lib/session.mjs for what was found
// and lib/browser.mjs for the Chrome part.
//
// Sign-in is yours:         node harvest.mjs --login     (a normal Chrome window opens; you sign in and close
//                                                         it; the harvester then runs once and says what it saw)
// Scheduled run:            node harvest.mjs             (window parked far off-screen, no console)
// Check without writing:    node harvest.mjs --dry-run   (reads the app + the database, writes nothing)
// Watch a run:              node harvest.mjs --headed
// Import now (not only a keep-alive visit): node harvest.mjs --force
// Wider transaction window: node harvest.mjs --force --days 400     (default 60)
//
// The Supabase key is read from ~/.onyx_supabase_secret by the importer (never printed). The harvester never
// sees Rocket Money credentials: the session lives in the Chrome profile.
import { chromium } from "playwright";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeCandidates, createBrowser, plainChromeArgs, profileChangedAt, ROCKET_MONEY_SITE } from "./lib/browser.mjs";
import { acquireLock, parseSummaryLine } from "./lib/harvest-core.mjs";
import { runHarvest } from "./lib/harvest-run.mjs";
import { createSupabaseStore } from "./lib/store.mjs";
import { DEFAULT_DAYS } from "./lib/web-transactions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const PROFILE = join(LOCAL, "Onyx", "rocketmoney-harvest-profile");
const TMP_ROOT = join(LOCAL, "Onyx", "rocketmoney-harvest-tmp");
const STATE_PATH = join(HERE, "state.json");
const LOCK_PATH = join(HERE, "harvest.lock");
const LOG_PATH = join(HERE, "harvest.log");

const LOGIN_MODE = process.argv.includes("--login");
const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const VISIBLE = process.argv.includes("--headed");
const DAYS = (() => {
  const i = process.argv.indexOf("--days");
  const n = i >= 0 ? Number(process.argv[i + 1]) : DEFAULT_DAYS;
  return Number.isInteger(n) && n >= 1 && n <= 4000 ? n : DEFAULT_DAYS;
})();

// Counts and statuses only: never balances, account names, numbers or merchants.
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, line + "\n"); } catch { /* the log is best effort */ }
}

/**
 * Sign-in by hand: a plain Chrome window on the harvester's profile (not an automated one: on 2026-11-11 the
 * sign-in form was submitted three times in the automated window without getting in, then worked first time
 * in a plain one). Resolves when that window has been closed. Nothing is typed, clicked or read here.
 */
async function signInByHand() {
  const exe = chromeCandidates().find((p) => existsSync(p));
  if (!exe) {
    log("LOGIN: Chrome was not found in its usual folders; open it yourself with the command in the README");
    return false;
  }
  // Hold the run lock while the window is open, so a scheduled run does not trip over the open profile. A lock
  // older than 30 minutes counts as a crashed run, so its time is refreshed while the window stays open.
  const release = acquireLock(LOCK_PATH);
  if (!release) {
    log("LOGIN: a harvest run is in progress; try again in a minute");
    return false;
  }
  const keepLock = setInterval(() => {
    try { utimesSync(LOCK_PATH, new Date(), new Date()); } catch { /* best effort */ }
  }, 5 * 60 * 1000);
  try {
    mkdirSync(PROFILE, { recursive: true });
    log("LOGIN: a normal Chrome window is opening on the harvester profile. Sign in to Rocket Money yourself, wait until your accounts show, then CLOSE THE WINDOW. Nothing is typed for you.");
    return await new Promise((resolve) => {
      const child = spawn(exe, plainChromeArgs(PROFILE, ROCKET_MONEY_SITE.startUrl), { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", () => resolve(true));
    });
  } finally {
    clearInterval(keepLock);
    release();
  }
}

// import-balances.mjs in a child process: it prints one JSON line of counts and writes its own heartbeat.
function runImporter(file, { dryRun }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(HERE, "import-balances.mjs"), file, ...(dryRun ? ["--dry-run"] : [])],
      { timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true },
      (_err, stdout) => resolve(parseSummaryLine(stdout)),
    );
  });
}

// .NET Recycle Bin API (recoverable), never a permanent delete. The path travels in an environment variable.
function recycle(path) {
  return new Promise((resolve) => {
    const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:ONYX_RECYCLE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 60000, windowsHide: true, env: { ...process.env, ONYX_RECYCLE_PATH: path } },
      (err) => resolve(!err),
    );
  });
}

let exitCode = 0;
try {
  // While the profile is set to re-open its last tabs, those tabs go to the Recycle Bin before Chrome starts.
  const browser = createBrowser({ chromium, profile: PROFILE, visible: VISIBLE, log, clearSavedTabs: recycle });
  let ready = true;
  if (LOGIN_MODE) {
    ready = await signInByHand();
    if (ready) log("LOGIN: the window was closed; running once now to check the sign-in and import");
    else exitCode = 1;
  }
  if (ready) {
    exitCode = await runHarvest({
      force: FORCE || LOGIN_MODE,
      dryRun: DRY,
      days: DAYS,
      statePath: STATE_PATH,
      lockPath: LOCK_PATH,
      tmpRoot: TMP_ROOT,
      capture: browser.capture,
      profileChangedAt: () => profileChangedAt(PROFILE),
      runImporter,
      getStore: createSupabaseStore,
      recycle,
      log,
    });
    if (LOGIN_MODE) log(exitCode === 0 ? "LOGIN OK: signed in and imported. The scheduled task keeps the sign-in alive from here." : exitCode === 2 ? "LOGIN not seen: the profile is still signed out. Run --login again and close the window only after your accounts show." : "LOGIN: signed in or not, the run failed; see the line above.");
  }
} catch (e) {
  log(`FAILED: ${String(e?.message ?? e).slice(0, 200)}`);
  exitCode = 1;
}
// Let Playwright's handles drain before exiting (a hard exit trips a libuv assertion on Windows).
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 3000).unref();
