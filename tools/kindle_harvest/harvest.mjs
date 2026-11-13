// Kindle → Onyx harvester. Runs on Riley's PC on a schedule (Task Scheduler), not in the cloud,
// the same way browse-proxy/local/harvest.mjs does for StreetEasy.
//
// v2 (2026-11-08): reads the Kindle for Web READER (read.amazon.com/?asin=…) instead of scraping
// the Notebook page. Opening a book in the signed-in Chrome profile makes the reader fetch, and
// this script intercept, everything Onyx needs to log reading automatically:
//   • getAnnotations JSON — every highlight + note with its Kindle position and a real timestamp
//   • the first renderer tar — toc.json (chapter → start position), location_map.json (print
//     page labels), metadata.json (book length)
//   • the page HTML — "mostRecentPositionRead" = the Whispersync reading position
// Onyx (`POST /api/reading/highlights/import`, CI-token auth) upserts the highlights (idempotent
// on passage), stores the chapter map + position, and derives source='kindle' sessions:
// a highlight on a chapter's last page completes the chapter, any new note makes a session for
// that day with the notes as recall. Nothing to type on /reading for Kindle reading.
//
// One-time:   node harvest.mjs --login      (headful; sign in to Amazon, then it exits)
// Scheduled:  node harvest.mjs              (window parked off-screen; see README.md)
// Preview:    node harvest.mjs --dry-run    (read only, print what would be posted)
// Debug:      node harvest.mjs --probe      (20 s look at the Notebook page + probe.png)
// Orders:     node harvest.mjs --orders-only (skip the books; only the Amazon order list)
//
// Every scheduled pass also reads the personal Amazon "Your Orders" list for Onyx /orders
// (amazon-orders.mjs -> POST /api/orders/amazon/import, its own amazon|orders heartbeat). A failure
// there is reported to Onyx and never fails the Kindle pass.
//
// Auth to Onyx: ONYX_CI_TOKEN env var or ~/.onyx_ci_token (same secret as the habits-sync
// GitHub Action / Vercel env). Never written to this folder.
import { chromium } from "playwright";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAmazonOrders } from "./amazon-orders.mjs";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const cfg = JSON.parse(readFileSync(join(HERE, "books.json"), "utf8"));
const ONYX = (process.env.ONYX_URL || cfg.onyx_url).replace(/\/$/, "");
const NOTEBOOK = "https://read.amazon.com/notebook";
const READER = "https://read.amazon.com/";
const TOKEN_FILE = join(homedir(), ".onyx_ci_token");
const PROFILE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Onyx", "kindle-harvest-profile");
const LOG = join(HERE, "harvest.log");
const STATE = join(HERE, "state.json");
const PROBE = process.argv.includes("--probe");
const LOGIN_MODE = process.argv.includes("--login") || PROBE;
const DRY = process.argv.includes("--dry-run");
const ORDERS_ONLY = process.argv.includes("--orders-only");

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
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Onyx import HTTP ${r.status}`);
  const result = JSON.parse(text);
  if (!body.error && (result.error || result.errors?.length)) {
    throw new Error("Onyx import reported incomplete results");
  }
  return `${r.status} ${text.slice(0, 400)}`;
}

async function postOrders(body) {
  if (DRY) return "dry-run";
  const r = await fetch(`${ONYX}/api/orders/amazon/import`, {
    method: "POST",
    headers: { "x-onyx-ci-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Onyx orders import HTTP ${r.status}`);
  return `${r.status} ${text.slice(0, 200)}`;
}

/** True when Amazon bounced us to a sign-in / MFA / captcha page. */
async function signedOut(page) {
  if (/\/ap\/(signin|mfa|cvf)|\/errors\/validateCaptcha/i.test(page.url())) return true;
  return await page.locator("#ap_email, #ap_password, input[name='email'], #auth-captcha-image").first().isVisible({ timeout: 1500 }).catch(() => false);
}

/* ------------------------------------------------------------------ */
/* Reader payload parsing                                               */
/* ------------------------------------------------------------------ */

/** Minimal ustar reader: the renderer answers with a tar of JSON members (toc.json, location_map.json, …). */
function tarMembers(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.subarray(off, off + 100).toString("utf8").split("\0")[0];
    if (!name) { off += 512; continue; }
    const size = parseInt(buf.subarray(off + 124, off + 136).toString("utf8").split("\0")[0].trim(), 8) || 0;
    out.push({ name: name.replace(/^\.\//, ""), size, data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
function tarJson(members, name) {
  // Skip the pax extended-header stubs (./PaxHeaders.X/<name>) that precede each real member.
  const m = members.find((x) => !/PaxHeaders/.test(x.name) && (x.name === name || x.name.endsWith("/" + name)));
  if (!m) return null;
  try { return JSON.parse(m.data.toString("utf8")); } catch { return null; }
}

/** The reader HTML inlines JSON with \x22-escaped quotes. */
function unescapeInline(html) {
  return html.split("\\x22").join('"').split("\\/").join("/");
}

/** position → print page number, from location_map.json's navigationUnit (sorted start positions with page labels). */
function pageLabeler(navigationUnit) {
  const units = (navigationUnit || [])
    .map((u) => ({ pos: Number(u.startPosition), label: String(u.label ?? "") }))
    .filter((u) => Number.isFinite(u.pos))
    .sort((a, b) => a.pos - b.pos);
  return (pos) => {
    if (pos == null || !units.length) return null;
    let label = null;
    for (const u of units) { if (u.pos <= pos) label = u.label; else break; }
    const n = label != null ? parseInt(label.replace(/\D/g, ""), 10) : NaN;
    return Number.isFinite(n) ? n : null;
  };
}

/** Numbered chapters from toc.json: "1", "Chapter 12", "12. Title" → chapter 12. Front/back matter is skipped. */
function buildChapters(toc, pageAt, lastPositionId) {
  const entries = (toc || [])
    .map((e) => ({ label: String(e.label ?? "").trim(), pos: Number(e.tocPositionId) }))
    .filter((e) => Number.isFinite(e.pos))
    .sort((a, b) => a.pos - b.pos);
  const out = [];
  const seen = new Set();
  entries.forEach((e, i) => {
    const m = e.label.match(/^(?:chapter\s*)?(\d{1,3})\b/i);
    if (!m) return;
    const chapter = Number(m[1]);
    if (seen.has(chapter)) return;
    seen.add(chapter);
    const next = entries[i + 1];
    const end = next ? next.pos - 1 : lastPositionId ?? null;
    out.push({ chapter, title: e.label, start_position: e.pos, end_position: end, start_page: pageAt(e.pos), end_page: end != null ? pageAt(end) : null });
  });
  return out;
}

const iso = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);

/** Pair notes with the highlight they sit on (a note's start lies inside the highlight's span); standalone notes become their own rows. */
function buildItems(annotations, pageAt) {
  const hs = (annotations || []).filter((a) => a.type === "kindle.highlight" && a.context && a.context.trim().length >= 3);
  const notes = (annotations || []).filter((a) => a.type === "kindle.note" && a.note && a.note.trim());
  const used = new Set();
  const items = [];
  for (const h of hs) {
    let note = null;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (!used.has(i) && n.start >= h.start && n.start <= h.end) { note = n; used.add(i); break; }
    }
    const page = pageAt(h.start);
    items.push({
      passage: h.context.trim(),
      comment: note ? note.note.trim() : null,
      position: h.start,
      position_end: h.end,
      page,
      location: page != null ? `p. ${page}` : `loc ${Math.floor(h.start / 150)}`,
      highlighted_at: iso(h.modifiedTimestamp),
      note_at: note ? iso(note.modifiedTimestamp) : null,
    });
  }
  notes.forEach((n, i) => {
    if (used.has(i)) return;
    const page = pageAt(n.start);
    items.push({
      passage: n.note.trim(),
      comment: null,
      position: n.start,
      position_end: n.end ?? n.start,
      page,
      location: page != null ? `p. ${page}` : `loc ${Math.floor(n.start / 150)}`,
      highlighted_at: null,
      note_at: iso(n.modifiedTimestamp),
    });
  });
  return items;
}

/* ------------------------------------------------------------------ */
/* Reader session                                                       */
/* ------------------------------------------------------------------ */

/** Open the book in the reader and intercept annotations + the first render tar + the position. */
async function readBook(page, asin) {
  const cap = { annotations: null, tar: null };
  const onResp = async (r) => {
    try {
      const u = r.url();
      if (/\/service\/mobile\/reader\/getAnnotations\?/.test(u)) cap.annotations = await r.json();
      else if (/\/renderer\/render\?/.test(u) && !cap.tar) cap.tar = await r.body();
    } catch {}
  };
  page.on("response", onResp);
  try {
    const resp = await page.goto(`${READER}?asin=${asin}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const html = resp ? await resp.text().catch(() => "") : "";
    const meta = unescapeInline(html);
    const lpr = Number(meta.match(/"mostRecentPositionRead":(\d+)/)?.[1]);
    const endPos = Number(meta.match(/"endReadingPosition":(\d+)/)?.[1]);

    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline && !(cap.annotations && cap.tar)) {
      const title = await page.title().catch(() => "");
      if (/\/checkpoint\//.test(page.url()) || /Temporarily Unavailable/i.test(title)) {
        throw new Error("Amazon served a checkpoint / 'Website Temporarily Unavailable' page");
      }
      if (await signedOut(page)) throw new Error("signed out");
      await page.waitForTimeout(1000);
    }
    if (!cap.annotations) throw new Error("reader loaded but no annotations response within 75 s");

    let toc = null, locmap = null, metadata = null;
    if (cap.tar) {
      const members = tarMembers(cap.tar);
      toc = tarJson(members, "toc.json");
      locmap = tarJson(members, "location_map.json");
      metadata = tarJson(members, "metadata.json");
    }
    const pageAt = pageLabeler(locmap?.navigationUnit);
    const totalPositions = metadata?.lastPositionId ?? (Number.isFinite(endPos) ? endPos : null);
    return {
      title: metadata?.bookTitle ?? null,
      lpr: Number.isFinite(lpr) ? lpr : null,
      totalPositions,
      chapters: buildChapters(toc, pageAt, totalPositions),
      items: buildItems(cap.annotations.annotations, pageAt),
      pageAt,
    };
  } finally {
    page.off("response", onResp);
  }
}

async function readBookWithRetry(page, asin) {
  try {
    return await readBook(page, asin);
  } catch (e) {
    if (/signed out/.test(e.message)) throw e;
    log(`  reader attempt 1 failed (${e.message}); retrying in 30 s`);
    await page.waitForTimeout(30_000);
    return await readBook(page, asin);
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

let ctx;
let exitCode = 0;
try {
  mkdirSync(PROFILE, { recursive: true });
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: false, // Amazon challenges headless Chrome; the window is parked off-screen on scheduled runs
    viewport: { width: 1280, height: 900 },
    args: LOGIN_MODE ? ["--window-size=1280,900"] : ["--window-position=-32000,-32000", "--window-size=1280,900"],
  });

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
      (await page.locator("[id^='kp-notebook'], [class*='kp-notebook']").count().catch(() => 0)) > 0;
    const deadline = Date.now() + (PROBE ? 20_000 : 10 * 60_000);
    let ok = false;
    while (Date.now() < deadline && !(ok = await signedIn())) await page.waitForTimeout(2000);
    const books = ok ? await page.locator(".kp-notebook-library-each-book").count() : 0;
    log(ok ? `LOGIN OK — profile saved; ${books} book(s) in the Kindle library; scheduled runs will reuse it.` : "LOGIN not completed; run --login again.");
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
    await postOrders({ error: "Amazon session expired; run tools/kindle_harvest/harvest.mjs --login on the PC" }).catch(() => {});
    exitCode = 2;
  } else {
    // The Notebook library lists every book with at least one annotation: ASIN (element id) + title.
    await page.waitForSelector("[id^='kp-notebook'], [class*='kp-notebook']", { state: "attached", timeout: 30000 });
    await page.waitForTimeout(2500);
    const library = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".kp-notebook-library-each-book")).map((e) => ({ asin: e.id, title: (e.querySelector("h2")?.innerText || "").trim() })),
    );

    for (const book of ORDERS_ONLY ? [] : cfg.books) {
      try {
        const re = new RegExp(book.titleMatch, "i");
        const hit = library.find((b) => re.test(b.title));
        const asin = book.asin || hit?.asin || state.books[book.slug]?.asin || null;
        if (!asin) {
          log(`${book.slug}: not in the Kindle library yet (titleMatch /${book.titleMatch}/i) and no asin in books.json`);
          log(`${book.slug}: heartbeat -> ${await post({ book: book.slug, items: [] })}`);
          continue;
        }
        const r = await readBookWithRetry(page, asin);
        const withNotes = r.items.filter((i) => i.comment).length;
        const lprCh = r.chapters.filter((c) => r.lpr != null && c.start_position <= r.lpr).pop();
        log(
          `${book.slug}: "${r.title ?? hit?.title ?? asin}" ${r.items.length} highlights (${withNotes} with notes), ${r.chapters.length} chapters mapped, position ${r.lpr ?? "?"}` +
            (lprCh ? ` (ch ${lprCh.chapter}, p. ${r.pageAt(r.lpr) ?? "?"})` : ""),
        );
        if (DRY) for (const i of r.items.slice(0, 8)) log(`  ${i.location ?? ""} @${i.position} “${i.passage.slice(0, 70)}”${i.comment ? ` — ${i.comment.slice(0, 50)}` : ""}`);
        const result = await post({
          book: book.slug,
          asin,
          last_position: r.lpr,
          total_positions: r.totalPositions,
          chapters: r.chapters,
          items: r.items,
        });
        log(`${book.slug}: push -> ${result}`);
        state.books[book.slug] = { asin, title: r.title ?? hit?.title ?? null, highlights: r.items.length, withNotes, lpr: r.lpr, chapters: r.chapters.length, at: new Date().toISOString(), result: result.slice(0, 160) };
      } catch (e) {
        log(`${book.slug}: ERROR ${e.message}`);
        if (/signed out/.test(e.message)) {
          log(`${book.slug}: heartbeat -> ${await post({ error: "Amazon session expired; run tools/kindle_harvest/harvest.mjs --login on the PC" })}`);
          exitCode = 2;
          break;
        }
        log(`${book.slug}: heartbeat -> ${await post({ book: book.slug, error: `harvest failed: ${e.message}`.slice(0, 500) })}`);
        exitCode = 1;
      }
    }
    // Personal Amazon orders for /orders: separate heartbeat, never fails the Kindle pass.
    if (exitCode !== 2) {
      try {
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
        const { orders, scanned, unparsed } = await readAmazonOrders(page, today, { log });
        if (DRY) for (const o of orders) log(`  amazon ${o.order_number.slice(0, 7)}… ${o.status} ${o.expected_on ?? o.status_on ?? ""} (${o.items.length} item(s))`);
        log(`amazon orders: push -> ${await postOrders({ orders, scanned, unparsed })}`);
        state.amazonOrders = { at: new Date().toISOString(), orders: orders.length, unparsed };
      } catch (e) {
        log(`amazon orders: ERROR ${e.message}`);
        await postOrders({ error: `Amazon order list failed: ${e.message}`.slice(0, 200) }).catch(() => log("amazon orders: could not report the error to Onyx"));
      }
    }
    state.lastRun = new Date().toISOString();
    save();
  }
} catch (e) {
  log(`FATAL ${e.message}`);
  exitCode = 1;
  if (!LOGIN_MODE && !DRY) {
    try {
      await post({ error: "Kindle harvest did not confirm completion; check the local harvester log" });
    } catch {
      log("Failed to report the harvest error to Onyx");
    }
  }
} finally {
  await ctx?.close().catch(() => {});
}
process.exit(exitCode);
