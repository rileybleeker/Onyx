// Onyx Rocket Money harvester: runs on Riley's PC (Task Scheduler "Onyx Rocket Money Harvest", daily).
//
// What it does: opens app.rocketmoney.com in a dedicated, already signed-in Chrome profile and READS the
// responses the web app itself loads for the Net Worth and Settings > Accounts pages (account list, last
// four digits, type, balance, asset or debt). It turns them into pds.finance_balance_snapshots rows by
// running import-balances.mjs. It never types, never clicks, never submits anything: it navigates to two
// pages and listens (plus the read-only Transactions queries described below). As a belt-and-braces guard it aborts any GraphQL request that is a mutation, so even
// something the app fires on its own while loading cannot change the account.
//
// Transactions: from the same signed-in page it also reads the Transactions list the way the app's own list
// does (the app's operation, one extra read-only GraphQL query per page of 200, last 60 days by default) and
// upserts it by Rocket Money's own transaction id (lib/web-transactions.mjs). Pending rows are skipped. The
// export CSV is not used: its file name is only ever sent by email, and this harvester never reads email.
//
// Sign-in is yours, once:   node harvest.mjs --login     (opens a window; you sign in; it only watches)
// Scheduled run:            node harvest.mjs             (window parked far off-screen, no console)
// Check without writing:    node harvest.mjs --dry-run   (reads the app + the database, writes nothing)
// Watch a run:              node harvest.mjs --headed
// Run again within 20 h:    node harvest.mjs --force
// Wider transaction window: node harvest.mjs --force --days 400     (default 60)
//
// The Supabase key is read from ~/.onyx_supabase_secret by the importer (never printed). The harvester never
// sees Rocket Money credentials: the session lives in the Chrome profile.
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyResponse, isGraphqlUrl, isLoginUrl, isMutationRequest, parseSummaryLine } from "./lib/harvest-core.mjs";
import { runHarvest } from "./lib/harvest-run.mjs";
import { createSupabaseStore } from "./lib/store.mjs";
import { DEFAULT_DAYS, GRAPHQL_ENDPOINT, MAX_PAGES, PAGE_SIZE, pageFetchTransactions, TRANSACTIONS_OPERATION, TRANSACTIONS_QUERY } from "./lib/web-transactions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const PROFILE = join(LOCAL, "Onyx", "rocketmoney-harvest-profile");
const TMP_ROOT = join(LOCAL, "Onyx", "rocketmoney-harvest-tmp");
const STATE_PATH = join(HERE, "state.json");
const LOCK_PATH = join(HERE, "harvest.lock");
const LOG_PATH = join(HERE, "harvest.log");
const START_URL = "https://app.rocketmoney.com/net-worth";
const ACCOUNTS_URL = "https://app.rocketmoney.com/settings/accounts";

const LOGIN_MODE = process.argv.includes("--login");
const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const VISIBLE = LOGIN_MODE || process.argv.includes("--headed");
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

function launchOptions() {
  return {
    channel: "chrome", // the installed Chrome, a normal headful window (no stealth flags, no fingerprint changes)
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: VISIBLE ? ["--window-size=1280,900"] : ["--window-position=-32000,-32000", "--window-size=1280,900"],
  };
}

/** Attaches the read-only guard and the response listener; returns the live capture object. */
async function attach(page) {
  const captured = { networth: null, accounts: null, blockedMutations: 0, version: null };
  // READ-ONLY GUARD: a GraphQL mutation never leaves the browser.
  await page.route((url) => isGraphqlUrl(url.href), async (route) => {
    const req = route.request();
    if (req.method() === "POST" && isMutationRequest(req.postData())) {
      captured.blockedMutations++;
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  // The app sends its web-client version with every request; the transaction reads repeat it like the app does.
  page.on("request", (req) => {
    if (!captured.version && isGraphqlUrl(req.url())) captured.version = req.headers()["x-truebill-web-client-version"] ?? null;
  });
  page.on("response", async (res) => {
    if (!isGraphqlUrl(res.url()) || res.request().method() !== "POST") return;
    let json;
    try { json = await res.json(); } catch { return; }
    for (const part of Array.isArray(json) ? json : [json]) {
      const kind = classifyResponse(part);
      if (kind) captured[kind] = part;
    }
  });
  return captured;
}

async function waitFor(page, predicate, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    if (isLoginUrl(page.url())) return false;
    await page.waitForTimeout(500);
  }
  return predicate();
}

async function goto(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500); // let a sign-in redirect happen before the URL is judged
}

async function withContext(fn) {
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, launchOptions());
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return await fn(page);
  } finally {
    try { await ctx.close(); } catch { /* the window was already closed by hand */ }
  }
}

async function capture({ gteDate }) {
  return withContext(async (page) => {
    const captured = await attach(page);
    await goto(page, START_URL);
    if (isLoginUrl(page.url())) return { status: "login_required" };
    if (!(await waitFor(page, () => captured.networth, 30000))) {
      return isLoginUrl(page.url()) ? { status: "login_required" } : { status: "failed", error: "the Net Worth data did not load within 30 s" };
    }
    await goto(page, ACCOUNTS_URL);
    if (isLoginUrl(page.url())) return { status: "login_required" };
    if (!(await waitFor(page, () => captured.accounts, 30000))) {
      return isLoginUrl(page.url()) ? { status: "login_required" } : { status: "failed", error: "the account list did not load within 30 s" };
    }
    // Transactions: read from inside the signed-in page, with its own session. Nothing is clicked or scrolled.
    const transactions = await page.evaluate(pageFetchTransactions, {
      endpoint: GRAPHQL_ENDPOINT,
      query: TRANSACTIONS_QUERY,
      operationName: TRANSACTIONS_OPERATION,
      gteDate,
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
      version: captured.version,
    });
    if (isLoginUrl(page.url())) transactions.login = true;
    if (captured.blockedMutations) log(`blocked ${captured.blockedMutations} mutation request(s) made by the page (read-only guard)`);
    return { status: "ok", networth: captured.networth, accounts: captured.accounts, transactions };
  });
}

async function loginMode() {
  return withContext(async (page) => {
    const captured = await attach(page);
    await goto(page, START_URL);
    log("LOGIN: sign in to Rocket Money in the window that just opened (waiting up to 30 minutes). Nothing is typed for you.");
    for (let i = 0; i < 360; i++) {
      if (!isLoginUrl(page.url())) {
        // Signed in (back on the app host): look at Net Worth once to prove the session can read data.
        if (!/\/net-worth/.test(page.url())) await goto(page, START_URL);
        if (await waitFor(page, () => captured.networth, 30000)) {
          log("LOGIN OK: the profile is signed in; scheduled runs will reuse it. This window closes itself.");
          return 0;
        }
      }
      await page.waitForTimeout(5000);
    }
    log("LOGIN not completed within 30 minutes; run --login again.");
    return 1;
  });
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
  if (LOGIN_MODE) {
    exitCode = await loginMode();
  } else {
    exitCode = await runHarvest({
      force: FORCE,
      dryRun: DRY,
      days: DAYS,
      statePath: STATE_PATH,
      lockPath: LOCK_PATH,
      tmpRoot: TMP_ROOT,
      capture,
      runImporter,
      getStore: createSupabaseStore,
      recycle,
      log,
    });
  }
} catch (e) {
  log(`FAILED: ${String(e?.message ?? e).slice(0, 200)}`);
  exitCode = 1;
}
// Let Playwright's handles drain before exiting (a hard exit trips a libuv assertion on Windows).
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 3000).unref();
