// Kindle notebook harvester → Onyx /reading. Runs on Riley's PC on a schedule (Task Scheduler),
// not in the cloud, the same way browse-proxy/local/harvest.mjs does for StreetEasy.
//
// Amazon has no highlights API and Kindle books are DRM-locked, so the only automatic path to
// your highlights + notes is the Kindle Notebook web app (read.amazon.com/notebook) — the page
// Readwise scrapes. This script opens it in a persistent, already-signed-in Chrome profile,
// selects each configured book, scrolls the annotation pane until it stops loading, and posts
// {passage, comment, location} rows to Onyx (`POST /api/reading/highlights/import`, CI-token
// auth). The import is idempotent on (book, passage), so every run re-posts everything it sees:
// new highlights are created (and mirrored to Notion), existing ones only pick up a new note.
//
// One-time:   node harvest.mjs --login      (headful; sign in to Amazon, then it exits)
// Scheduled:  node harvest.mjs              (window parked off-screen; see README.md)
// Preview:    node harvest.mjs --dry-run    (scrape only, print counts, post nothing)
//
// Auth to Onyx: ONYX_CI_TOKEN env var or ~/.onyx_ci_token (same secret as the habits-sync
// GitHub Action / Vercel env). Never written to this folder.
import { chromium } from "playwright";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const cfg = JSON.parse(readFileSync(join(HERE, "books.json"), "utf8"));
const ONYX = (process.env.ONYX_URL || cfg.onyx_url).replace(/\/$/, "");
const NOTEBOOK = "https://read.amazon.com/notebook";
const TOKEN_FILE = join(homedir(), ".onyx_ci_token");
const PROFILE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Onyx", "kindle-harvest-profile");
const LOG = join(HERE, "harvest.log");
const STATE = join(HERE, "state.json");
const PROBE = process.argv.includes("--probe"); // 20-second look at the page + screenshot, for debugging sign-in
const LOGIN_MODE = process.argv.includes("--login") || PROBE;
const DRY = process.argv.includes("--dry-run");

let state = { lastRun: null, books: {} };
try { state = { ...state, ...JSON.parse(readFileSync(STATE, "utf8")) }; } catch {}

function log(line) {
  const msg = `${new Date().toISOString()} ${line}`;
  console.log(msg);
  try { appendFileSync(LOG, msg + "\n"); } catch {}
}
function save() { writeFileSync(STATE, JSON.stringify(state, null, 2)); }

const TOKEN = process.env.ONYX_CI_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "");
if (!TOKEN && !DRY && !LOGIN_MODE) {
  log(`ERROR no Onyx token: set ONYX_CI_TOKEN or create ${TOKEN_FILE} (the ONYX_CI_TOKEN value).`);
  process.exit(3);
}

async function post(body) {
  if (DRY) return "dry-run";
  const r = await fetch(`${ONYX}/api/reading/highlights/import`, {
    method: "POST",
    headers: { "x-onyx-ci-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ harvest: true, source: "kindle", ...body }),
  });
  return `${r.status} ${(await r.text()).slice(0, 300)}`;
}

/** True when Amazon bounced us to a sign-in / MFA / captcha page. */
async function signedOut(page) {
  if (/\/ap\/(signin|mfa|cvf)|\/errors\/validateCaptcha/i.test(page.url())) return true;
  return await page.locator("#ap_email, #ap_password, input[name='email'], #auth-captcha-image").first().isVisible({ timeout: 1500 }).catch(() => false);
}

/** Scroll the annotation pane until the row count stops growing (Kindle lazy-loads pages of highlights). */
async function loadAllAnnotations(page) {
  const rows = page.locator("#kp-notebook-annotations .a-row.a-spacing-base");
  let prev = -1, stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    const n = await rows.count();
    stable = n === prev ? stable + 1 : 0;
    prev = n;
    await page.evaluate(() => {
      const pane = document.querySelector("#kp-notebook-annotations");
      const last = pane && pane.lastElementChild;
      if (last) last.scrollIntoView({ block: "end" });
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await page.waitForTimeout(900 + Math.random() * 600);
  }
  return prev;
}

async function extract(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#kp-notebook-annotations .a-row.a-spacing-base"));
    const out = [];
    for (const r of rows) {
      const q = (sel) => (r.querySelector(sel)?.innerText || "").trim();
      const highlight = q("#highlight");
      const note = q("#note");
      const header = q("#annotationHighlightHeader") || q("#annotationNoteHeader");
      const locInput = r.querySelector("#kp-annotation-location")?.value || "";
      if (!highlight && !note) continue;
      out.push({ highlight, note, header, locInput });
    }
    return out;
  });
}

function toItem(row) {
  const page = row.header.match(/Page:\s*([\w-]+)/i);
  const loc = row.header.match(/Location:\s*([\d,-]+)/i);
  const location = page ? `p. ${page[1]}` : loc ? `loc ${loc[1].replace(/,/g, "")}` : row.locInput ? `loc ${row.locInput}` : null;
  // A highlight with a note → passage + comment. A standalone note (no highlighted text) → the note is the passage.
  return row.highlight
    ? { passage: row.highlight, comment: row.note || null, location }
    : { passage: row.note, comment: null, location };
}

async function harvestBook(page, book) {
  const entries = page.locator(".kp-notebook-library-each-book");
  const n = await entries.count();
  const re = new RegExp(book.titleMatch, "i");
  let target = null, title = "";
  for (let i = 0; i < n; i++) {
    const t = (await entries.nth(i).locator("h2").first().innerText().catch(() => "")).trim();
    if (re.test(t)) { target = entries.nth(i); title = t; break; }
  }
  if (!target) return { found: false, title: null, items: [] };
  await target.click();
  await page.waitForSelector("#kp-notebook-annotations", { timeout: 30000 });
  await page.waitForTimeout(1500);
  const rows = await loadAllAnnotations(page);
  const raw = await extract(page);
  return { found: true, title, rows, items: raw.map(toItem).filter((i) => i.passage && i.passage.length >= 3) };
}

mkdirSync(PROFILE, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",
  headless: false, // Amazon challenges headless Chrome; the window is parked off-screen on scheduled runs
  viewport: { width: 1280, height: 900 },
  args: LOGIN_MODE ? ["--window-size=1280,900"] : ["--window-position=-32000,-32000", "--window-size=1280,900"],
});

let exitCode = 0;
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(NOTEBOOK, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);

  if (LOGIN_MODE) {
    log("LOGIN: sign in to Amazon in the Chrome window. Waiting up to 10 minutes for the Notebook page…");
    // Signed in = back on /notebook, no sign-in form, and the Notebook app shell rendered. An EMPTY
    // library (nothing highlighted yet) is a valid signed-in state, so don't require a book entry.
    const signedIn = async () =>
      /read\.amazon\.com\/notebook/i.test(page.url()) &&
      !(await signedOut(page)) &&
      // count(), not isVisible(): the first kp-notebook-* match is often a hidden input.
      (await page.locator("[id^='kp-notebook'], [class*='kp-notebook']").count().catch(() => 0)) > 0;
    const deadline = Date.now() + (PROBE ? 20_000 : 10 * 60_000);
    let ok = false;
    while (Date.now() < deadline && !(ok = await signedIn())) await page.waitForTimeout(2000);
    const books = ok ? await page.locator(".kp-notebook-library-each-book").count() : 0;
    log(ok ? `LOGIN OK — profile saved; ${books} book(s) in the Kindle library; scheduled runs will reuse it.` : "LOGIN not completed; run --login again.");
    // Diagnostics for a failed/probe run: where did Chrome end up, and what does the page say?
    if (!ok || PROBE) {
      const title = await page.title().catch(() => "?");
      const kp = await page.locator("[id^='kp-notebook'], [class*='kp-notebook']").count().catch(() => -1);
      log(`DIAG url=${page.url()} title="${title}" signedOut=${await signedOut(page)} kpNotebookEls=${kp}`);
      await page.screenshot({ path: join(HERE, "probe.png"), fullPage: false }).catch((e) => log(`screenshot failed: ${e.message}`));
      log(`DIAG screenshot -> ${join(HERE, "probe.png")}`);
    }
    exitCode = ok ? 0 : 2;
  } else if (await signedOut(page)) {
    log("SIGNED OUT: Amazon wants a fresh sign-in. Run: node harvest.mjs --login");
    log(`heartbeat -> ${await post({ error: "Amazon session expired; run tools/kindle_harvest/harvest.mjs --login on the PC" })}`);
    exitCode = 2;
  } else {
    // Wait for the Notebook shell, not for a book: an empty library (nothing highlighted yet)
    // is normal and each book below reports "not in the library yet" with a heartbeat.
    await page.waitForSelector("[id^='kp-notebook'], [class*='kp-notebook']", { state: "attached", timeout: 30000 });
    await page.waitForTimeout(2500);
    for (const book of cfg.books) {
      try {
        const r = await harvestBook(page, book);
        if (!r.found) {
          log(`${book.slug}: not in the Kindle library yet (titleMatch /${book.titleMatch}/i)`);
          log(`${book.slug}: heartbeat -> ${await post({ book: book.slug, items: [] })}`);
          continue;
        }
        const withNotes = r.items.filter((i) => i.comment).length;
        log(`${book.slug}: "${r.title}" ${r.items.length} highlights (${withNotes} with notes) from ${r.rows} rows`);
        if (DRY) for (const i of r.items.slice(0, 5)) log(`  ${i.location ?? ""} “${i.passage.slice(0, 80)}”${i.comment ? ` — ${i.comment.slice(0, 60)}` : ""}`);
        const result = await post({ book: book.slug, items: r.items });
        log(`${book.slug}: push -> ${result}`);
        state.books[book.slug] = { title: r.title, highlights: r.items.length, withNotes, at: new Date().toISOString(), result: result.slice(0, 120) };
      } catch (e) {
        log(`${book.slug}: ERROR ${e.message}`);
        log(`${book.slug}: heartbeat -> ${await post({ book: book.slug, error: `harvest failed: ${e.message}`.slice(0, 500) })}`);
        exitCode = 1;
      }
    }
    state.lastRun = new Date().toISOString();
    save();
  }
} catch (e) {
  log(`FATAL ${e.message}`);
  exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
}
process.exit(exitCode);
