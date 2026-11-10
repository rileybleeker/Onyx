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
// One-time:   node harvest.mjs --login      (opens a visible window; sign in to Uber, it exits)
// Scheduled:  node harvest.mjs              (headless; stops paging at the first page it has seen)
// Backfill:   node harvest.mjs --full       (pages through the whole order history)
// Check:      node harvest.mjs --dry-run    (fetch + print, post nothing, write no heartbeat)
//             add --headed to watch a normal run in a visible window
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
const HEADED = LOGIN_MODE || process.argv.includes("--headed");
const MAX_PAGES = FULL ? 400 : 30;
const SIGN_IN_HINT = "Uber session missing or expired; run tools/ubereats_harvest/harvest.mjs --login on the PC";

const TOKEN = (process.env.ONYX_CI_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8") : "")).trim();

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* log file is best-effort */ }
}

async function post(body) {
  if (DRY) return "dry-run (not posted)";
  if (!TOKEN) return "no ONYX_CI_TOKEN / ~/.onyx_ci_token — cannot post";
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
        options: (c.childOptions || []).map((x) => `${x.quantity > 1 ? `${x.quantity}x ` : ""}${x.title || ""}`.trim()).filter(Boolean),
      })),
    })),
  };
}

function signedOut(page, res) {
  const url = page.url();
  if (/auth\.uber\.com|\/login/i.test(url)) return true;
  if (res.status === 401 || res.status === 403) return true;
  const d = res.json && res.json.data;
  return !d || !Array.isArray(d.orderUuids);
}

mkdirSync(PROFILE, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",
  headless: !HEADED,
  viewport: { width: 1280, height: 900 },
  args: ["--window-size=1280,900"],
});
let exitCode = 0;
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.ubereats.com/orders", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  if (LOGIN_MODE) {
    log("LOGIN: sign in to Uber Eats in the window that just opened (waiting up to 10 minutes)…");
    let ok = false;
    for (let i = 0; i < 120 && !ok; i++) {
      await page.waitForTimeout(5000);
      if (/ubereats\.com/i.test(page.url()) && !/\/login/i.test(page.url())) {
        const res = await fetchPage(page, "");
        ok = !signedOut(page, res);
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

    const first = await fetchPage(page, "");
    if (signedOut(page, first)) {
      log(`SIGNED OUT (url=${page.url().slice(0, 80)} status=${first.status} title=${JSON.stringify(await page.title())} ${first.head ? "body=" + JSON.stringify(first.head) : ""})`);
      log(`heartbeat -> ${JSON.stringify(await post({ error: SIGN_IN_HINT }))}`);
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
        if (pages >= MAX_PAGES) { stop = `page cap ${MAX_PAGES}`; break; }
        last = ids[ids.length - 1];
        await page.waitForTimeout(400 + Math.floor(Math.random() * 500));
        res = await fetchPage(page, last);
        if (signedOut(page, res)) { stop = `page ${pages + 1} failed (status ${res.status})`; break; }
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

        let estimated = 0;
        let remaining = -1;
        for (let i = 0; i < 120; i++) {
          let r;
          try { r = await post({ estimate: true }); } catch (e) { log(`estimate call failed: ${e.message}`); break; }
          estimated += r.estimated || 0;
          remaining = r.remaining ?? 0;
          if (!r.estimated || remaining === 0) break;
        }
        log(`estimated ${estimated} dish(es); ${Math.max(0, remaining)} left without an estimate`);

        for (const o of usable) seen.add(o.uuid);
        writeFileSync(STATE_FILE, JSON.stringify({ seen: [...seen].slice(-5000), lastRun: new Date().toISOString() }, null, 1));
        const hb = await post({
          done: true,
          stats: { orders: usable.length, items: itemCount, pages, estimated, unestimated: Math.max(0, remaining) },
        });
        log(`heartbeat -> ${JSON.stringify(hb)}`);
      }
    }
  }
} catch (e) {
  log(`FAILED: ${e.message}`);
  try { log(`heartbeat -> ${JSON.stringify(await post({ error: `harvest failed: ${e.message}`.slice(0, 500) }))}`); } catch { /* nothing more to do */ }
  exitCode = 1;
} finally {
  await ctx.close();
}
process.exit(exitCode);
