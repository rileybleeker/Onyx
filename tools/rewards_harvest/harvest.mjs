// Onyx rewards harvester: runs on the collector PC (Task Scheduler, every 12 h).
// Reads loyalty balances from a persistent, signed-in Chrome profile and upserts pds.rewards_balances
// (one row per program per run), then writes ONE sync_log heartbeat (rewards|balances).
//
//   node harvest.mjs                    scheduled run
//   node harvest.mjs --dry-run          read everything, print counts + which programs are signed in, write nothing
//   node harvest.mjs --probe            also write key NAMES and types (never values) of captured JSON to
//                                       %LOCALAPPDATA%\Onyx\rewards-harvest\probe.json, so adapters can be fixed
//   node harvest.mjs --login <program>  open a PLAIN visible Chrome window on that site's sign-in page; Riley signs in
//   node harvest.mjs --only <program>   run one program only
//   add --headed to watch a run on screen
//
// Privacy: only allow-listed fields are read (lib.mjs): a balance, a tier word, progress numbers, an expiry/renewal date.
// Never a member number, name, email, address, phone or card number. Logs and heartbeats carry program ids and causes only.
// Credentials are never typed by this script; sessions live in the Chrome profile. No stealth flags, no bot-check evasion.
import { chromium } from "playwright";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROGRAMS, PROGRAM_IDS, extractProgram, looksSignedOut, shapeOf, summarize } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const PROFILE = join(LOCAL, "Onyx", "rewards-harvest-profile");
const DATA_DIR = join(LOCAL, "Onyx", "rewards-harvest");
const LOG_FILE = join(DATA_DIR, "harvest.log");
const KEY_FILE = process.env.ONYX_SUPABASE_SECRET_FILE || join(homedir(), ".onyx_supabase_secret");
const SUPABASE_URL = (process.env.ONYX_SUPABASE_URL || "https://fewweioupmsnbccqtxdl.supabase.co").replace(/\/$/, "");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const PROBE = args.includes("--probe");
const HEADED = args.includes("--headed");
const loginIdx = args.indexOf("--login");
const LOGIN = loginIdx >= 0 ? args[loginIdx + 1] : null;
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

mkdirSync(DATA_DIR, { recursive: true });
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* best-effort */ }
}

if (args.includes("--login") && !PROGRAMS[LOGIN]) {
  console.error(`usage: node harvest.mjs --login <${PROGRAM_IDS.join("|")}>`);
  process.exit(2);
}
if (ONLY && !PROGRAMS[ONLY]) { console.error(`unknown program: ${ONLY}`); process.exit(2); }

// ---- Supabase (PostgREST, service key from the dotfile; never printed) ----
let KEY = "";
try { KEY = readFileSync(KEY_FILE, "utf8").trim(); } catch { /* handled below */ }
function headers(extra = {}) {
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Content-Profile": "pds", ...extra };
}
async function rest(path, rows, prefer) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "POST", headers: headers({ Prefer: prefer }), body: JSON.stringify(rows) });
  if (!r.ok) throw new Error(`Supabase ${path.split("?")[0]} HTTP ${r.status}`); // never the response body
}
async function tableExists() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rewards_balances?select=program&limit=1`, { headers: { ...headers(), "Accept-Profile": "pds" } });
  return r.ok;
}
async function heartbeat(started, status, records, error) {
  if (DRY || !KEY) return;
  const end = new Date();
  const row = {
    source: "rewards", data_type: "balances", status, records_synced: records,
    duration_seconds: Math.max(0, Math.round((end - started) / 1000)),
    error_message: error, sync_start: started.toISOString(), sync_end: end.toISOString(),
  };
  try { await rest("sync_log", [row], "return=minimal"); log(`heartbeat ${status} (${records} program(s))${error ? ": " + error : ""}`); }
  catch (e) { log(`heartbeat write failed: ${e.message}`); }
}

// ---- one program ----
async function readProgram(ctx, id, probeOut) {
  const cfg = PROGRAMS[id];
  const captured = [];
  const page = await ctx.newPage();
  page.on("response", async (res) => {
    try {
      const type = res.headers()["content-type"] || "";
      if (!/json/i.test(type) || res.status() !== 200) return;
      const json = await res.json();
      captured.push({ url: res.url(), json });
      if (probeOut) probeOut.push({ program: id, url: res.url().split("?")[0], shape: shapeOf(json) });
    } catch { /* body not readable: skip */ }
  });
  let signedOut = false;
  let text = "";
  let loaded = 0;
  try {
    for (const url of cfg.pages) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(6000); // the account SPA fetches its data after load
        loaded++;
      } catch { continue; }
      if (looksSignedOut(id, page.url())) { signedOut = true; break; }
      try { text += "\n" + (await page.innerText("body", { timeout: 5000 })).slice(0, 20000); } catch { /* no body text */ }
    }
  } finally {
    await page.close().catch(() => {});
  }
  if (signedOut) return { program: id, ok: false, cause: "not signed in (session missing or expired)" };
  if (!loaded) return { program: id, ok: false, cause: "page could not be loaded" };
  const row = extractProgram(id, captured, text);
  if (!row && !/(log ?out|sign ?out)/i.test(text) && /(log ?in|sign ?in)/i.test(text)) {
    return { program: id, ok: false, cause: "not signed in (page shows a sign-in prompt)" };
  }
  if (!row) return { program: id, ok: false, cause: "page loaded but balance could not be read (page format may have changed; run --probe)" };
  return { program: id, ok: true, row };
}

// ---- main ----
const started = new Date();
let exitCode = 0;
let ctx;
try {
  mkdirSync(PROFILE, { recursive: true });
  const visible = !!LOGIN || HEADED;
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: false, // sites' bot checks reject headless; the window is parked off-screen instead
    viewport: { width: 1280, height: 900 },
    args: visible ? ["--window-size=1280,900"] : ["--window-position=-32000,-32000", "--window-size=1280,900"],
  });

  if (LOGIN) {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(PROGRAMS[LOGIN].loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    log(`LOGIN ${LOGIN}: sign in yourself in the window that opened, then CLOSE the window (waiting up to 30 minutes).`);
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 30 * 60 * 1000);
      ctx.on("close", () => { clearTimeout(t); resolve(); });
    });
    log(`LOGIN ${LOGIN}: window closed; the session is saved in the profile.`);
  } else {
    if (!KEY) {
      log(`FAILED: no service key at ${KEY_FILE}; nothing can be written.`);
      exitCode = 1;
    } else {
      if (!DRY && !(await tableExists())) {
        const msg = "pds.rewards_balances is missing or not readable; apply the rewards SQL first";
        log(`FAILED: ${msg}`);
        await heartbeat(started, "failed", 0, msg);
        exitCode = 1;
      } else {
        const ids = ONLY ? [ONLY] : PROGRAM_IDS;
        const probeOut = PROBE ? [] : null;
        const results = [];
        for (const id of ids) {
          try { results.push(await readProgram(ctx, id, probeOut)); }
          catch (e) { results.push({ program: id, ok: false, cause: `unexpected error (${e.name || "Error"})` }); }
        }
        // uber_cash and uber_one share a session; they are read independently above.
        for (const r of results) log(`${r.program}: ${r.ok ? "read" : r.cause}`);
        if (PROBE) { writeFileSync(join(DATA_DIR, "probe.json"), JSON.stringify(probeOut, null, 1)); log(`probe: wrote ${probeOut.length} response shape(s) (key names and types only) to ${join(DATA_DIR, "probe.json")}`); }

        const captured_at = new Date().toISOString();
        const rows = results.filter((r) => r.ok).map((r) => ({ program: r.program, captured_at, ...r.row, source: "harvest" }));
        if (DRY) {
          log(`dry run: ${rows.length} of ${results.length} program(s) readable; signed in: ${results.filter((r) => r.ok || !/not signed in/.test(r.cause)).map((r) => r.program).join(", ") || "none"}; nothing written`);
        } else {
          if (rows.length) await rest("rewards_balances?on_conflict=program,captured_at", rows, "resolution=merge-duplicates,return=minimal");
          const s = summarize(results);
          log(`upserted ${rows.length} row(s)`);
          await heartbeat(started, s.status, s.records, s.error);
        }
      }
    }
  }
} catch (e) {
  log(`FAILED: ${e.name || "Error"}`);
  if (!LOGIN) await heartbeat(started, "failed", 0, `harvest crashed (${e.name || "Error"}); see harvest.log on the PC`);
  exitCode = 1;
} finally {
  try { await ctx?.close(); } catch { /* already closed */ }
}
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 3000).unref();
