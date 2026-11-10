// Onyx Uber Eats item harvester — runs on Riley's PC (Task Scheduler), headless.
//
// Receipt emails carry no line items, and Uber has no order-history API for customers.
// The signed-in web app does: POST https://www.ubereats.com/_p/api/getPastOrdersV1
// (header x-csrf-token: x, body {lastWorkflowUUID}) returns 10 orders a page with the
// store, exact completion time and every cart item. This script opens ubereats.com in
// a persistent Chrome profile, calls that endpoint from inside the page (so it rides
// the profile's own session cookies), and posts the orders to Onyx:
//
//   POST {ONYX}/api/delivery/items/import   { orders }      → pds.delivery_order_items
//                                           { estimate }    → kcal / macros per dish (looped)
//                                           { done, stats } → ubereats|items heartbeat
//
// Sign-in:    do it in a PLAIN Chrome window on this profile (README, "Signing in again"): that
//             is the route that worked on 2026-11-10. `--login` opens the automated window and
//             waits instead; whether Uber accepts a sign-in there has not been confirmed.
// Scheduled:  node harvest.mjs              (no visible window; stops paging at the first page it has seen)
// Backfill:   node harvest.mjs --full       (pages through the whole order history)
// Check:      node harvest.mjs --dry-run    (fetch + print, post nothing, write no heartbeat)
//             add --headed to watch a run in an on-screen window
//
// Auth to Onyx: ONYX_CI_TOKEN env var or ~/.onyx_ci_token (same secret as the Kindle harvester).
// The script never sees Uber credentials — the session lives in the Chrome profile.
import { chromium } from "playwright";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ONYX = (process.env.ONYX_BASE_URL || "https://frontend-six-alpha-69.vercel.app").replace(/\/$/, "");
const TOKEN_FILE = join(homedir(), ".onyx_ci_token");
const PROFILE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Onyx", "ubereats-harvest-profile");
const STATE_FILE = join(HERE, "state.json");
const LOG_FILE = join(HERE, "harvest.log");

const LOGIN_MODE = process.argv.includes("--login");
const DRY = process.argv.includes("--dry-run");
const FULL = process.argv.includes("--full");
// Uber's bot protection answers HEADLESS Chrome with a 403 "Just a moment…" challenge, and this
// script does not try to defeat it (no stealth flags, no fingerprint changes). So a scheduled run
// uses a normal Chrome window parked far off-screen — nothing appears on the desktop, and
// run-hidden.js keeps the console hidden too. --headed puts the window on screen; --headless is
// kept only to re-test whether Uber still blocks it.
const HEADLESS = process.argv.includes("--headless");
const VISIBLE = LOGIN_MODE || process.argv.includes("--headed");
const MAX_PAGES = 400; // safety cap only; reaching it counts as an incomplete run
const SIGN_IN_HINT = "Uber session missing or expired; sign in again on the PC (see tools/ubereats_harvest/README.md, 'Signing in again')";

const TOKEN = (process.env.ONYX_CI_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8") : "")).trim();

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* log file is best-effort */ }
}

// Without the token nothing can be stored and no heartbeat can be written, so do not fetch at all
// (an earlier version carried on, marked every order as seen and exited 0).
if (!TOKEN && !DRY && !LOGIN_MODE) {
  log("FAILED: no ONYX_CI_TOKEN and no ~/.onyx_ci_token — nothing can be posted to Onyx. Nothing was fetched.");
  process.exit(1);
}

async function post(body) {
  if (DRY) return "dry-run (not posted)";
  if (!TOKEN) throw new Error("no ONYX_CI_TOKEN / ~/.onyx_ci_token — cannot post");
  const r = await fetch(`${ONYX}/api/delivery/items/import`, {
    method: "POST",
    headers: { "x-onyx-ci-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!r.ok) throw new Error(`Onyx ${r.status}: ${text.slice(0, 300)}`);
  return json ?? text;
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { seen: [] }; }
}

// Runs INSIDE the page: same-origin fetch with the profile's cookies.
async function fetchPage(page, lastWorkflowUUID) {
  return page.evaluate(async (last) => {
    try {
      const r = await fetch("/_p/api/getPastOrdersV1", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "x" },
        body: JSON.stringify({ lastWorkflowUUID: last }),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* HTML challenge / error page */ }
      return { status: r.status, json, head: json ? null : text.slice(0, 200) };
    } catch (e) {
      return { status: 0, json: null, head: String(e).slice(0, 200) };
    }
  }, lastWorkflowUUID);
}

function mapOrder(o) {
  const b = o.baseEaterOrder || {};
  const items = (b.shoppingCart && b.shoppingCart.items) || [];
  return {
    uuid: b.uuid,
    store: (o.storeInfo && o.storeInfo.title) || null,
    completedAt: b.completedAt || b.lastStateChangeAt || null,
    isCancelled: !!b.isCancelled,
    currency: b.currencyCode || null,
    total: o.fareInfo && typeof o.fareInfo.totalPrice === "number" ? o.fareInfo.totalPrice : null,
    multiConsumer: new Set(items.map((i) => i.consumerUuid).filter(Boolean)).size > 1,
    items: items.map((i, idx) => ({
      key: i.shoppingCartItemUuid || `${i.uuid || "item"}:${idx}`,
      title: i.title,
      quantity: typeof i.quantity === "number" ? i.quantity : 1,
      price: typeof i.price === "number" ? i.price : null,
      customizations: (i.customizations || []).map((c) => ({
        title: c.title || null,
        // childOptions is { options: [...] } (seen 2026-11); tolerate a bare array too
        options: (Array.isArray(c.childOptions) ? c.childOptions : (c.childOptions && c.childOptions.options) || [])
          .map((x) => `${x.quantity > 1 ? `${x.quantity}x ` : ""}${x.title || ""}`.trim())
          .filter(Boolean),
      })),
    })),
  };
}

const onAuthPage = (page) => /auth\.uber\.com|\/login/i.test(page.url());

// A usable history page: JSON with an orderUuids array.
function pageOk(res) {
  const d = res.json && res.json.data;
  return !!d && Array.isArray(d.orderUuids);
}

// Say what actually went wrong. Only a redirect to the sign-in page or an auth status means
// "signed out"; a network drop, a rate limit or Uber's bot challenge are different problems.
function failureMessage(page, res) {
  if (onAuthPage(page) || res.status === 401 || (res.status === 403 && res.json)) return SIGN_IN_HINT;
  if (res.status === 403) return "Uber's bot check blocked the request (HTTP 403 challenge page)";
  if (res.status === 0) return `network error reaching Uber: ${res.head || "no response"}`;
  if (res.status === 429) return "Uber rate-limited the request (HTTP 429)";
  if (res.status === 200) return "Uber returned a page without an order list (response format may have changed)";
  return `Uber order history returned HTTP ${res.status}${res.head ? `: ${res.head.slice(0, 120)}` : ""}`;
}

let exitCode = 0;
let ctx;
try {
  // Inside the try so a launch failure (profile in use by another run, Chrome missing or
  // mid-update) is logged and reported as a failed heartbeat instead of vanishing.
  mkdirSync(PROFILE, { recursive: true });
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    args: VISIBLE || HEADLESS ? ["--window-size=1280,900"] : ["--window-position=-32000,-32000", "--window-size=1280,900"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.ubereats.com/orders", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  if (LOGIN_MODE) {
    log("LOGIN: sign in to Uber Eats in the window that just opened (waiting up to 30 minutes)…");
    let ok = false;
    for (let i = 0; i < 360 && !ok; i++) {
      await page.waitForTimeout(5000);
      if (/ubereats\.com/i.test(page.url()) && !onAuthPage(page)) {
        const res = await fetchPage(page, "");
        ok = pageOk(res) && !onAuthPage(page);
      }
    }
    log(ok ? "LOGIN OK — profile saved; scheduled runs will reuse it." : "LOGIN not completed; run --login again.");
    exitCode = ok ? 0 : 1;
  } else {
    const state = loadState();
    const seen = new Set(state.seen || []);
    const orders = [];
    let last = "";
    let pages = 0;
    let stop = "";
    // true = a later page failed (or the page cap was hit): older orders were not reached, so the
    // run must not be reported as a success and the fetched orders must not be marked as seen.
    let incomplete = false;

    const first = await fetchPage(page, "");
    if (!pageOk(first) || onAuthPage(page)) {
      const msg = failureMessage(page, first);
      log(`FIRST PAGE FAILED (url=${page.url().slice(0, 80)} status=${first.status} title=${JSON.stringify(await page.title())} ${first.head ? "body=" + JSON.stringify(first.head) : ""}): ${msg}`);
      log(`heartbeat -> ${JSON.stringify(await post({ error: msg }))}`);
      exitCode = 2;
    } else {
      let res = first;
      while (true) {
        pages++;
        const d = res.json.data;
        const ids = d.orderUuids || [];
        for (const id of ids) {
          const o = d.ordersMap && d.ordersMap[id];
          if (o) orders.push(mapOrder(o));
        }
        const allKnown = ids.length > 0 && ids.every((id) => seen.has(id));
        if (!ids.length) { stop = "empty page"; break; }
        if (!(d.meta && d.meta.hasMore)) { stop = "end of history"; break; }
        if (!FULL && allKnown) { stop = "reached orders already harvested"; break; }
        if (pages >= MAX_PAGES) { stop = `page cap ${MAX_PAGES} reached`; incomplete = true; break; }
        last = ids[ids.length - 1];
        await page.waitForTimeout(400 + Math.floor(Math.random() * 500));
        res = await fetchPage(page, last);
        if (!pageOk(res)) { stop = `page ${pages + 1} failed: ${failureMessage(page, res)}`; incomplete = true; break; }
      }
      const usable = orders.filter((o) => o.uuid && o.store);
      const itemCount = usable.reduce((n, o) => n + o.items.length, 0);
      log(`fetched ${pages} page(s), ${usable.length} order(s), ${itemCount} item line(s) — stopped: ${stop}`);
      if (usable.length) {
        const dates = usable.map((o) => o.completedAt).filter(Boolean).sort();
        log(`  span ${dates[0]?.slice(0, 10)} → ${dates[dates.length - 1]?.slice(0, 10)}`);
      }

      if (DRY) {
        for (const o of usable.slice(0, 3)) {
          log(`  DRY ${o.completedAt?.slice(0, 16)} ${o.store} — ${o.items.map((i) => `${i.quantity}x ${i.title}`).join("; ").slice(0, 160)}`);
        }
      } else {
        let imported = 0;
        for (let i = 0; i < usable.length; i += 40) {
          const r = await post({ orders: usable.slice(i, i + 40) });
          imported += (r && r.items) || 0;
        }
        log(`imported ${imported} item line(s)`);

        // Estimate nutrition for dishes that have none yet, 25 per call. When a batch fails it is
        // retried one dish at a time, and a dish that fails alone is stepped past (offset) so one
        // bad dish cannot block the queue. Five failures in a row = outage: stop.
        let estimated = 0;
        let remaining = null; // null = no estimate call has succeeded, so the count is unknown
        let estimateError = null;
        let skip = 0;
        let single = 0;
        let failedInRow = 0;
        for (let i = 0; i < 400; i++) {
          const limit = single > 0 ? 1 : 25;
          let r;
          try {
            r = await post({ estimate: true, limit, offset: skip });
          } catch (e) {
            estimateError = e.message;
            log(`estimate call failed (limit ${limit}, offset ${skip}): ${e.message}`);
            if (++failedInRow > 4) break;
            if (limit === 1) { skip++; single--; } else single = 25;
            continue;
          }
          failedInRow = 0;
          estimated += r.estimated || 0;
          remaining = r.remaining ?? 0;
          if (limit === 1) { single--; if (!r.estimated) skip++; } else if (!r.estimated) break;
          if (remaining <= skip) break;
        }
        log(`estimated ${estimated} dish(es); ${remaining === null ? "an unknown number" : remaining} left without an estimate`);

        if (incomplete) {
          // Keep what was imported (the upsert is idempotent) but do NOT mark it seen: the next run
          // must page through these orders again to reach the ones behind the failed page.
          const msg = `stopped early: ${stop}; imported ${usable.length} order(s) from ${pages} page(s), older orders not reached`;
          log(`heartbeat -> ${JSON.stringify(await post({ error: msg.slice(0, 500) }))}`);
          exitCode = 3;
        } else {
          for (const o of usable) seen.add(o.uuid);
          writeFileSync(STATE_FILE, JSON.stringify({ seen: [...seen].slice(-5000), lastRun: new Date().toISOString() }, null, 1));
          // The route counts the unestimated queue itself; the harvester only passes the reason.
          const hb = await post({
            done: true,
            stats: { orders: usable.length, items: itemCount, pages, estimated, estimateError },
          });
          log(`heartbeat -> ${JSON.stringify(hb)}`);
          if (remaining === null && estimateError) exitCode = 1;
        }
      }
    }
  }
} catch (e) {
  log(`FAILED: ${e.message}`);
  // A sign-in attempt is not a harvest run: closing the login window must not write a failed heartbeat.
  if (!LOGIN_MODE) {
    try { log(`heartbeat -> ${JSON.stringify(await post({ error: `harvest failed: ${e.message}`.slice(0, 500) }))}`); } catch { /* nothing more to do */ }
  }
  exitCode = 1;
} finally {
  try { await ctx?.close(); } catch { /* window already closed by hand */ }
}
// Let Playwright's handles drain before exiting (a hard exit here trips a libuv assertion on Windows).
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 3000).unref();
