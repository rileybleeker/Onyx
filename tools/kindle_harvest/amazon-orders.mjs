// Amazon "Your Orders" -> Onyx /orders (2026-11-12). Runs inside the Kindle harvester's scheduled
// pass (same signed-in Chrome profile = Riley's PERSONAL Amazon account), because personal
// Amazon.com orders send no email to either Gmail account, so orders_email_etl.py cannot see them.
//
// Read-only: it opens the order-history list (past 3 months, up to 3 pages) and reads each order
// card's text. Nothing is clicked except "Next" pagination links; nothing is bought or changed.
// Sent to Onyx (POST /api/orders/amazon/import, CI token): order number, order date, status,
// the status date / expected date, up to five item names. NEVER the order total, the address or
// the recipient: those lines are skipped here and the route rejects anything that looks like an
// amount. The route turns each order into pds.online_order_events rows; the next
// orders_email_etl.py run (every 3 h) joins them into pds.online_orders like any other store.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\.?";
const ORDER_NO_RE = /ORDER\s*#\s*((?:\d{3}|D\d{2})-\d{7}-\d{7})/i;
const ITEM_END_RE = /^(Buy it again|Return or replace items|Return items|Return window closed|Replace item|Eligible for|View your item|Track package)\b/i;
const NOT_ITEM_RE = /^(ORDER PLACED|TOTAL|SHIP TO|ORDER #|View order details|View invoice|Ask Alexa|Arriving|Delivered|Now arriving|Running late|Out for delivery|Shipped|Not yet shipped|Preparing|Order received|Cancelled|Canceled|Refunded|Return|Replacement|Your package|Package was|It was handed|Amazon Now|Get product support|Write a product review|Share gift receipt|More options|Ask Product Question|View or edit order|Track Package|Problem with order|Leave seller feedback|Leave delivery feedback|Archive order|\d{1,3}$|\$)/i;

/** "November 17" near `anchor` (the order date): the next occurrence on or after it, within ~5 months. */
export function resolveDay(text, anchor) {
  const m = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, "i").exec(text || "");
  if (!m) return null;
  const mi = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
  if (mi < 0) return null;
  const day = Number(m[2]);
  let year = m[3] ? Number(m[3]) : anchor.getUTCFullYear();
  let d = new Date(Date.UTC(year, mi, day));
  if (!m[3]) {
    // Status dates carry no year; they fall after the order date (and never long before it).
    if (d.getTime() < anchor.getTime() - 3 * 86400_000) d = new Date(Date.UTC(year + 1, mi, day));
  }
  if (d.getUTCMonth() !== mi || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

function relativeDay(word, today) {
  const t = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)));
  if (/today/i.test(word)) return t.toISOString().slice(0, 10);
  if (/tomorrow|overnight/i.test(word)) return new Date(t.getTime() + 86400_000).toISOString().slice(0, 10);
  if (/yesterday/i.test(word)) return new Date(t.getTime() - 86400_000).toISOString().slice(0, 10);
  return null;
}

function cleanItem(line) {
  let s = line.replace(/\s+/g, " ").trim();
  s = s.split(" | ")[0];
  if (s.length > 90) s = s.slice(0, 90).replace(/[ ,;:-]+\S*$/, "");
  return s.replace(/[\s,;:-]+$/, "");
}

/**
 * One order card's text -> {order_number, ordered_on, status, status_on, expected_on, delayed, items} or null.
 * `today` = YYYY-MM-DD (ET) for "Arriving tomorrow".
 */
export function parseOrderCard(text, today) {
  const lines = String(text || "").split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const num = ORDER_NO_RE.exec(lines.join("\n"));
  if (!num) return null;
  const placedIdx = lines.findIndex((l) => /^ORDER PLACED$/i.test(l));
  const placedText = placedIdx >= 0 ? lines[placedIdx + 1] : null;
  const anchorDay = resolveDay(placedText || "", new Date(Date.UTC(+today.slice(0, 4), 0, 1)));
  if (!anchorDay) return null;
  const anchor = new Date(anchorDay + "T00:00:00Z");

  let status = null;
  let statusOn = null;
  let expectedOn = null;
  let delayed = false;
  for (const l of lines) {
    let m;
    if ((m = /^Delivered\b(.*)$/i.exec(l))) {
      status = "delivered";
      statusOn = relativeDay(m[1], today) || resolveDay(m[1], anchor);
      break;
    }
    if (/^(Now arriving|Running late|Delayed)\b/i.test(l)) {
      status = "shipped";
      delayed = true;
      const dates = l.match(new RegExp(`${MONTH_RE}\\s+\\d{1,2}`, "gi")) || [];
      expectedOn = dates.length ? resolveDay(dates[dates.length - 1], anchor) : relativeDay(l, today);
      break;
    }
    if ((m = /^Arriving\b(.*)$/i.exec(l))) {
      status = "shipped";
      const dates = m[1].match(new RegExp(`${MONTH_RE}\\s+\\d{1,2}`, "gi")) || [];
      expectedOn = dates.length ? resolveDay(dates[dates.length - 1], anchor) : relativeDay(m[1], today);
      break;
    }
    if (/^Out for delivery\b/i.test(l)) {
      status = "out_for_delivery";
      expectedOn = today;
      break;
    }
    if (/^Shipped\b/i.test(l)) {
      status = "shipped";
      break;
    }
    if (/^(Not yet shipped|Preparing for shipment|Order received)\b/i.test(l)) {
      status = "ordered";
      break;
    }
    if (/^(Cancell?ed|Refunded)\b/i.test(l)) {
      status = "canceled";
      break;
    }
    if (/^(Return (started|complete|received|in transit)|Replacement (ordered|complete))\b/i.test(l)) {
      status = "delivered";
      break;
    }
    if (/^(Your package was left|Package was left|It was handed|Your package was delivered)\b/i.test(l)) {
      status = "delivered";
      break;
    }
  }
  if (!status) return null;

  const items = [];
  for (let i = 1; i < lines.length; i++) {
    if (!ITEM_END_RE.test(lines[i])) continue;
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      const cand = lines[j];
      if (ITEM_END_RE.test(cand) || NOT_ITEM_RE.test(cand) || /\$\s?\d/.test(cand)) continue;
      const name = cleanItem(cand);
      if (name.length >= 3 && /[A-Za-z]{2}/.test(name) && !items.includes(name)) items.push(name);
      break;
    }
  }
  return {
    order_number: num[1].toUpperCase(),
    ordered_on: anchorDay,
    status,
    status_on: statusOn,
    expected_on: expectedOn,
    delayed,
    items: items.slice(0, 5),
  };
}

const LIST_URL = "https://www.amazon.com/your-orders/orders?timeFilter=months-3";

/** Read up to `maxPages` pages of order cards. Returns {orders, scanned, unparsed}. */
export async function readAmazonOrders(page, today, { maxPages = 3, log = () => {} } = {}) {
  await page.goto(LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/\/ap\/signin|\/ax\/claim/i.test(page.url())) throw new Error("Amazon signed out");
  const orders = [];
  let scanned = 0;
  let unparsed = 0;
  for (let p = 1; p <= maxPages; p++) {
    const texts = await page.$$eval(".js-order-card, .order-card", (els) => {
      const top = els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
      return top.map((e) => e.innerText);
    });
    for (const t of texts) {
      scanned++;
      const o = parseOrderCard(t, today);
      if (o) {
        if (!orders.some((x) => x.order_number === o.order_number)) orders.push(o);
      } else unparsed++;
    }
    const next = page.locator("ul.a-pagination li.a-last:not(.a-disabled) a");
    if (p === maxPages || (await next.count()) === 0) break;
    await Promise.all([page.waitForLoadState("domcontentloaded"), next.first().click()]);
    await page.waitForTimeout(2500);
  }
  log(`amazon orders: ${orders.length} order(s) read from ${scanned} card(s), ${unparsed} unparsed`);
  return { orders, scanned, unparsed };
}
