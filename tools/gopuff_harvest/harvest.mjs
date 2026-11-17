// Onyx goPuff item harvester — runs on the collector PC (Task Scheduler), in an off-screen Chrome window.
//
// goPuff has no API and no export for a customer's own orders. The signed-in web app does: its
// orders page runs a GraphQL query named "OrdersByUserId" (found 2026-11-13). This script opens
// the orders page in a persistent Chrome profile, captures the page's OWN OrdersByUserId request
// (URL, headers, body), then replays it from inside the page (so it rides the profile's session)
// with the paging variable moved forward until the response says there is no next page.
// Orders are posted to Onyx as provider "gopuff":
//
//   POST {ONYX}/api/delivery/items/import   { provider, orders }    → pds.delivery_order_items (merchant_kind store)
//                                           { provider, estimate }  → kcal / macros per product (shared queue)
//                                           { provider, done }      → gopuff|items heartbeat
//
// Only an allow-list of fields is read (order id, time, status, product name, quantity, price): the
// delivery address, phone number, email and payment details in the response are never copied
// (lib.mjs mapOrder). Request headers and cookies are never logged.
//
// Sign-in (one time, Riley): a PLAIN Chrome window on this profile, phone number + SMS code (README).
// Scheduled:  node harvest.mjs              (stops at the first page it has already harvested)
// Backfill:   node harvest.mjs --full
// Check:      node harvest.mjs --dry-run    (fetch + print, post nothing)
// Probe:      node harvest.mjs --probe      (writes probe-shape.json: the response's key names and
//                                            value types, NO values; posts nothing)
//             add --headed to watch a run in an on-screen window
//
// No stealth flags, no fingerprint changes: if goPuff's bot check blocks the window, the run reports
// that and stops. Auth to Onyx: ONYX_CI_TOKEN env var or ~/.onyx_ci_token (same secret as the others).
import { chromium } from "playwright";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findOrders, findPagingSlot, mapOrder, nextVariables, pageInfoOf, shapeOf } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ONYX = (process.env.ONYX_BASE_URL || "https://frontend-six-alpha-69.vercel.app").replace(/\/$/, "");
const TOKEN_FILE = join(homedir(), ".onyx_ci_token");
const PROFILE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Onyx", "gopuff-harvest-profile");
const STATE_FILE = join(HERE, "state.json");
const LOG_FILE = join(HERE, "harvest.log");
const PROBE_FILE = join(HERE, "probe-shape.json");
const PROVIDER = "gopuff";

const DRY = process.argv.includes("--dry-run");
const PROBE = process.argv.includes("--probe");
const FULL = process.argv.includes("--full");
const VISIBLE = PROBE || process.argv.includes("--headed");
const MAX_PAGES = 200; // safety cap only; reaching it counts as an incomplete run
const OPERATION = "OrdersByUserId";
// The orders page address has not been confirmed; try these in order (override with GOPUFF_ORDERS_URL).
const ORDER_PAGES = process.env.GOPUFF_ORDERS_URL
  ? [process.env.GOPUFF_ORDERS_URL]
  : ["https://www.gopuff.com/orders", "https://www.gopuff.com/account/orders", "https://www.gopuff.com/account"];
const SIGN_IN_HINT = "goPuff session missing or expired, or the orders page did not request the order list; sign in again on the PC (see tools/gopuff_harvest/README.md, 'Signing in')";

const TOKEN = (process.env.ONYX_CI_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8") : "")).trim();

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* log file is best-effort */ }
}

if (!TOKEN && !DRY && !PROBE) {
  log("FAILED: no ONYX_CI_TOKEN and no ~/.onyx_ci_token — nothing can be posted to Onyx. Nothing was fetched.");
  process.exit(1);
}

async function post(body) {
  if (DRY || PROBE) return "dry-run (not posted)";
  if (!TOKEN) throw new Error("no ONYX_CI_TOKEN / ~/.onyx_ci_token — cannot post");
  const r = await fetch(`${ONYX}/api/delivery/items/import`, {
    method: "POST",
    headers: { "x-onyx-ci-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ provider: PROVIDER, ...body }),
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

// Wait for the page's own OrdersByUserId request. Captured: URL, method, body, and the headers
// Playwright reports for it (never logged). Returns null when none appears in `ms`.
async function captureRequest(page, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { page.off("request", onReq); resolve(null); }, ms);
    function onReq(req) {
      if (req.method() !== "POST") return;
      const data = req.postData() || "";
      if (!data.includes(OPERATION)) return;
      let body;
      try { body = JSON.parse(data); } catch { return; }
      if (Array.isArray(body)) body = body.find((b) => b && b.operationName === OPERATION) || null; // batched operations
      if (!body || body.operationName !== OPERATION) return;
      clearTimeout(timer);
      page.off("request", onReq);
      const headers = { ...req.headers() };
      for (const h of ["content-length", "host", "cookie", ":authority", ":method", ":path", ":scheme"]) delete headers[h];
      resolve({ url: req.url(), headers, body });
    }
    page.on("request", onReq);
  });
}

// Runs INSIDE the page: same-origin-ish fetch with the profile's cookies, using the captured request.
async function replay(page, cap, variables) {
  return page.evaluate(async ({ url, headers, body, variables }) => {
    try {
      const r = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ ...body, variables }),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* HTML challenge / error page */ }
      return { status: r.status, json, head: json ? null : text.slice(0, 200) };
    } catch (e) {
      return { status: 0, json: null, head: String(e).slice(0, 200) };
    }
  }, { url: cap.url, headers: cap.headers, body: cap.body, variables });
}

function responseOk(res) {
  if (res.status !== 200 || !res.json || !isObject(res.json.data)) return false;
  const hasErrors = Array.isArray(res.json.errors) && res.json.errors.length > 0;
  return !hasErrors || findOrders(res.json).length > 0 || pageInfoOf(res.json).known;
}
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function failureMessage(res) {
  if (res.status === 401 || res.status === 403 || (res.json && Array.isArray(res.json.errors) && res.json.errors.some((e) => /unauth|forbidden|login|token/i.test(String(e && e.message))))) {
    return res.status === 403 && !res.json ? "goPuff's bot check blocked the request (HTTP 403 challenge page)" : SIGN_IN_HINT;
  }
  if (res.status === 0) return `network error reaching goPuff: ${res.head || "no response"}`;
  if (res.status === 429) return "goPuff rate-limited the request (HTTP 429)";
  if (res.status === 200) return "goPuff returned an answer without a usable order list (response format may have changed; run --probe)";
  return `goPuff order history returned HTTP ${res.status}`;
}

let exitCode = 0;
let ctx;
try {
  mkdirSync(PROFILE, { recursive: true });
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: VISIBLE ? ["--window-size=1280,900"] : ["--window-position=-32000,-32000", "--window-size=1280,900"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // Open the orders page and let the app make its own request.
  let cap = null;
  for (const url of ORDER_PAGES) {
    const waiting = captureRequest(page, 25000);
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }); } catch (e) { log(`navigation to an orders page failed: ${String(e.message).slice(0, 120)}`); }
    cap = await waiting;
    if (cap) break;
  }

  if (!cap) {
    log(`NO ORDER REQUEST (final url path ${new URL(page.url()).pathname.slice(0, 60)}, title ${JSON.stringify((await page.title()).slice(0, 60))}): ${SIGN_IN_HINT}`);
    log(`heartbeat -> ${JSON.stringify(await post({ error: SIGN_IN_HINT }))}`);
    exitCode = 2;
  } else {
    const baseVars = cap.body.variables ?? {};
    const slot = findPagingSlot(baseVars);
    const state = loadState();
    const seen = new Set(state.seen || []);
    const orders = [];
    let pages = 0;
    let stop = "";
    let incomplete = false;
    let variables = baseVars;
    let shapeSaved = false;

    while (true) {
      const res = await replay(page, cap, variables);
      if (!responseOk(res)) {
        const msg = failureMessage(res);
        if (pages === 0) {
          log(`FIRST PAGE FAILED (status=${res.status} ${res.head ? "body=" + JSON.stringify(res.head) : ""}): ${msg}`);
          log(`heartbeat -> ${JSON.stringify(await post({ error: msg }))}`);
          exitCode = 2;
          stop = "first page failed";
          break;
        }
        stop = `page ${pages + 1} failed: ${msg}`;
        incomplete = true;
        break;
      }
      pages++;
      if (PROBE && !shapeSaved) {
        writeFileSync(PROBE_FILE, JSON.stringify({ variableKeys: shapeOf(baseVars), pagingSlot: slot, response: shapeOf(res.json) }, null, 1));
        log(`probe: wrote ${PROBE_FILE} (key names and value types only)`);
        shapeSaved = true;
      }
      const raw = findOrders(res.json);
      const info = pageInfoOf(res.json);
      const mapped = raw.map(mapOrder);
      orders.push(...mapped);
      const ids = mapped.map((o) => o.uuid).filter(Boolean);
      if (!raw.length) { stop = pages === 1 ? "no orders in the response" : "empty page"; break; }
      if (PROBE) { stop = "probe (first page only)"; break; }
      if (!info.hasNext) { stop = info.known ? "end of history" : "no pagination block in the response (first page only)"; break; }
      if (!FULL && ids.length && ids.every((id) => seen.has(id))) { stop = "reached orders already harvested"; break; }
      if (pages >= MAX_PAGES) { stop = `page cap ${MAX_PAGES} reached`; incomplete = true; break; }
      const next = nextVariables(variables, slot, info, raw.length, pages + 1);
      if (!next) { stop = "more pages exist but the paging variable was not recognised (run --probe)"; incomplete = true; break; }
      variables = next;
      await page.waitForTimeout(500 + Math.floor(Math.random() * 600));
    }

    if (exitCode === 0) {
      const usable = orders.filter((o) => o.uuid && o.items.length);
      const itemCount = usable.reduce((n, o) => n + o.items.length, 0);
      log(`fetched ${pages} page(s), ${orders.length} order(s) seen, ${usable.length} with items, ${itemCount} item line(s) — stopped: ${stop}`);
      if (usable.length) {
        const dates = usable.map((o) => o.completedAt).filter(Boolean).sort();
        if (dates.length) log(`  span ${dates[0].slice(0, 10)} → ${dates[dates.length - 1].slice(0, 10)}`);
      }
      // An order list that came back but mapped to nothing is a format problem, not an empty history.
      const unrecognised = orders.length > 0 && usable.length === 0;

      if (DRY || PROBE) {
        for (const o of usable.slice(0, 3)) {
          log(`  DRY ${o.completedAt?.slice(0, 16) ?? "no time"} — ${o.items.map((i) => `${i.quantity}x ${i.title}`).join("; ").slice(0, 160)}`);
        }
        if (unrecognised) log("  orders were found but none mapped to items: field names differ (see probe-shape.json)");
      } else if (unrecognised) {
        const msg = "orders found but no product lines could be read (response format differs; run --probe on the PC)";
        log(`heartbeat -> ${JSON.stringify(await post({ error: msg }))}`);
        exitCode = 3;
      } else {
        let imported = 0;
        for (let i = 0; i < usable.length; i += 40) {
          const r = await post({ orders: usable.slice(i, i + 40) });
          imported += (r && r.items) || 0;
        }
        log(`imported ${imported} item line(s)`);

        // Estimate nutrition for products that have none yet (the queue is shared with Uber Eats):
        // 25 per call; a failed batch is retried one at a time and a bad one is stepped past.
        let estimated = 0;
        let remaining = null;
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
        log(`estimated ${estimated} product(s); ${remaining === null ? "an unknown number" : remaining} left without an estimate`);

        if (incomplete) {
          // Keep what was imported (idempotent) but do NOT mark it seen: the next run pages through again.
          const msg = `stopped early: ${stop}; imported ${usable.length} order(s) from ${pages} page(s), older orders not reached`;
          log(`heartbeat -> ${JSON.stringify(await post({ error: msg.slice(0, 500) }))}`);
          exitCode = 3;
        } else {
          for (const o of usable) seen.add(o.uuid);
          writeFileSync(STATE_FILE, JSON.stringify({ seen: [...seen].slice(-5000), lastRun: new Date().toISOString() }, null, 1));
          const hb = await post({ done: true, stats: { orders: usable.length, items: itemCount, pages, estimated, estimateError } });
          log(`heartbeat -> ${JSON.stringify(hb)}`);
          if (remaining === null && estimateError) exitCode = 1;
        }
      }
    }
  }
} catch (e) {
  log(`FAILED: ${String(e.message).slice(0, 300)}`);
  if (!PROBE) {
    try { log(`heartbeat -> ${JSON.stringify(await post({ error: `harvest failed: ${e.message}`.slice(0, 500) }))}`); } catch { /* nothing more to do */ }
  }
  exitCode = 1;
} finally {
  try { await ctx?.close(); } catch { /* window already closed by hand */ }
}
// Let Playwright's handles drain before exiting (a hard exit here trips a libuv assertion on Windows).
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 3000).unref();
