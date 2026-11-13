/**
 * Online orders (/orders): pure logic shared by the page, its API routes and the Today summary.
 *
 * pds.online_orders is rebuilt by orders_email_etl.py from shipping / delivery emails. Whether an
 * order is "overdue" is decided HERE, at read time, so the answer moves with the clock without a
 * new ETL run. Riley's one-tap answers (pds.online_order_marks: "Got it" = it arrived, "Hide")
 * match any of an order's aliases, so an order whose key changes when a later email links it to
 * another number keeps them.
 *
 * Rules, in plain words:
 * - Delivered by email, or marked "Got it": delivered (listed for 30 days).
 * - The carrier reported a problem: needs attention.
 * - Shipped with an expected date: on the way until 2 days after that date; then needs attention
 *   if this store (or Amazon / the carrier) usually emails on delivery, otherwise "no delivery
 *   email" (quiet, with a "Got it" button).
 * - Shipped, no date: on the way for 10 days, then the same split.
 * - Ordered, no shipping email: needs attention after 7 days, only for a store that has sent
 *   shipping emails before and only when the email had an order number.
 * - Anything older than 30 days after shipping (45 after ordering) drops off.
 *
 * No imports, so the offline tests load it directly.
 */

export type OrderStatus = "ordered" | "shipped" | "out_for_delivery" | "delivered" | "canceled";
export type OrderIssue = "delayed" | "exception";
export type OrderState = "attention" | "arriving" | "processing" | "unconfirmed" | "delivered" | "canceled" | "closed";

export interface TrackingNumber {
  number: string;
  carrier: string | null;
  delivered: boolean;
}

export interface OnlineOrder {
  key: string;
  aliases: string[];
  merchant: string;
  orderNumber: string | null;
  tracking: TrackingNumber[];
  items: string[];
  itemCount: number | null;
  status: OrderStatus;
  issue: OrderIssue | null;
  partiallyDelivered: boolean;
  orderedAt: string | null;
  shippedAt: string | null;
  outForDeliveryAt: string | null;
  deliveredAt: string | null;
  canceledAt: string | null;
  expectedDate: string | null;
  lastEventAt: string;
  confirmsDelivery: boolean;
  shipsPhysically: boolean;
}

export interface OrderMark {
  aliasKey: string;
  receivedAt: string | null;
  hidden: boolean;
  updatedAt: string;
}

export interface ClassifiedOrder {
  order: OnlineOrder;
  state: OrderState;
  reason: string;
  /** YYYY-MM-DD the package is due, when known. */
  due: string | null;
  /** Riley marked it arrived (as opposed to a delivery email). */
  markedReceived: boolean;
}

export interface OrderGroups {
  attention: ClassifiedOrder[];
  arriving: ClassifiedOrder[];
  processing: ClassifiedOrder[];
  unconfirmed: ClassifiedOrder[];
  recent: ClassifiedOrder[];
  arrivingToday: number;
}

export const ORDER_COLUMNS =
  "order_key,aliases,merchant_name,order_number,tracking,items,item_count,status,issue,partially_delivered," +
  "ordered_at,shipped_at,out_for_delivery_at,delivered_at,canceled_at,expected_date,last_event_at," +
  "confirms_delivery,ships_physically";
export const MARK_COLUMNS = "alias_key,received_at,hidden,updated_at";
/** How far back /orders reads (the longest window any rule below looks at, plus margin). */
export const ORDERS_WINDOW_DAYS = 120;

const DAY_MS = 86_400_000;
const STATUSES: OrderStatus[] = ["ordered", "shipped", "out_for_delivery", "delivered", "canceled"];
const ORDER_KEY_RE = /^[otm]:[A-Za-z0-9._:+@-]{1,200}$/;

// ─── parsing DB rows ─────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const iso = (v: unknown): string | null => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};
const day = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

export function parseOrderRow(row: unknown): OnlineOrder | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const key = str(r.order_key);
  const lastEventAt = iso(r.last_event_at);
  const status = r.status as OrderStatus;
  if (!key || !lastEventAt || !STATUSES.includes(status)) return null;
  const tracking = Array.isArray(r.tracking)
    ? r.tracking.flatMap((t) => {
        if (!t || typeof t !== "object") return [];
        const o = t as Record<string, unknown>;
        const number = str(o.number);
        return number ? [{ number, carrier: str(o.carrier), delivered: o.delivered === true }] : [];
      })
    : [];
  const items = Array.isArray(r.items) ? r.items.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  const aliases = Array.isArray(r.aliases) ? r.aliases.filter((x): x is string => typeof x === "string") : [];
  const count = typeof r.item_count === "number" && Number.isFinite(r.item_count) && r.item_count > 0 ? r.item_count : null;
  return {
    key,
    aliases: aliases.includes(key) ? aliases : [key, ...aliases],
    merchant: str(r.merchant_name) ?? "Unknown store",
    orderNumber: str(r.order_number),
    tracking,
    items,
    itemCount: count,
    status,
    issue: r.issue === "delayed" || r.issue === "exception" ? r.issue : null,
    partiallyDelivered: r.partially_delivered === true,
    orderedAt: iso(r.ordered_at),
    shippedAt: iso(r.shipped_at),
    outForDeliveryAt: iso(r.out_for_delivery_at),
    deliveredAt: iso(r.delivered_at),
    canceledAt: iso(r.canceled_at),
    expectedDate: day(r.expected_date),
    lastEventAt,
    confirmsDelivery: r.confirms_delivery === true,
    shipsPhysically: r.ships_physically === true,
  };
}

export function parseMarkRow(row: unknown): OrderMark | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const aliasKey = str(r.alias_key);
  if (!aliasKey) return null;
  return { aliasKey, receivedAt: iso(r.received_at), hidden: r.hidden === true, updatedAt: iso(r.updated_at) ?? "" };
}

// ─── dates (America/New_York calendar days) ──────────────────────────────────

export function etDay(instant: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(typeof instant === "string" ? new Date(instant) : instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole days from a to b (YYYY-MM-DD each): b - a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
    Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / DAY_MS);
}

export function shortDate(ymd: string): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), 12));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function dueLabel(due: string, today: string): string {
  const d = daysBetween(today, due);
  if (d === 0) return "Arriving today";
  if (d === 1) return "Arriving tomorrow";
  if (d === -1) return "Was due yesterday";
  if (d < -1) return `Was due ${shortDate(due)}`;
  return `Arriving ${shortDate(due)}`;
}

// ─── classification ──────────────────────────────────────────────────────────

export function markFor(order: OnlineOrder, marks: Map<string, OrderMark>): OrderMark | null {
  let best: OrderMark | null = null;
  for (const a of order.aliases) {
    const m = marks.get(a);
    if (m && (!best || m.updatedAt > best.updatedAt)) best = m;
  }
  return best;
}

export function classifyOrder(order: OnlineOrder, mark: OrderMark | null, now: Date): ClassifiedOrder {
  const today = etDay(now);
  const out = (state: OrderState, reason: string, due: string | null = null, markedReceived = false): ClassifiedOrder =>
    ({ order, state, reason, due, markedReceived });
  if (mark?.hidden) return out("closed", "Hidden");
  if (order.status === "canceled") {
    const at = order.canceledAt ?? order.lastEventAt;
    return daysBetween(etDay(at), today) <= 30 ? out("canceled", `Canceled ${shortDate(etDay(at))}`) : out("closed", "Canceled");
  }
  if (order.status === "delivered") {
    const at = order.deliveredAt ?? order.lastEventAt;
    return daysBetween(etDay(at), today) <= 30 ? out("delivered", `Delivered ${shortDate(etDay(at))}`) : out("closed", "Delivered");
  }
  if (mark?.receivedAt) {
    return daysBetween(etDay(mark.receivedAt), today) <= 30
      ? out("delivered", `You marked it arrived ${shortDate(etDay(mark.receivedAt))}`, null, true)
      : out("closed", "Arrived");
  }
  const late = order.issue === "delayed" ? "Running late. " : "";
  const quiet = "This store doesn't usually email when a package arrives.";
  if (order.status === "shipped" || order.status === "out_for_delivery") {
    const shippedDay = etDay(order.shippedAt ?? order.lastEventAt);
    const age = daysBetween(shippedDay, today);
    if (age > 30) return out("closed", "No update for 30 days");
    if (order.issue === "exception") return out("attention", "The carrier or store reported a delivery problem.");
    // "Out for delivery" is newer news than any earlier estimate, so it is judged first.
    if (order.status === "out_for_delivery") {
      const od = etDay(order.outForDeliveryAt ?? order.lastEventAt);
      if (daysBetween(od, today) >= 2) {
        return order.confirmsDelivery
          ? out("attention", `Out for delivery since ${shortDate(od)}; no delivery email yet.`)
          : out("unconfirmed", `Out for delivery ${shortDate(od)}. ${quiet}`);
      }
      return out("arriving", `${late}Out for delivery`, od);
    }
    if (order.expectedDate) {
      const overdue = daysBetween(order.expectedDate, today);
      if (overdue >= 2) {
        return order.confirmsDelivery
          ? out("attention", `Was due ${shortDate(order.expectedDate)}; no delivery email yet.`, order.expectedDate)
          : out("unconfirmed", `Was due ${shortDate(order.expectedDate)}. ${quiet}`, order.expectedDate);
      }
      const prefix = order.partiallyDelivered ? "Part delivered. " : "";
      return out("arriving", `${prefix}${late}${dueLabel(order.expectedDate, today)}`, order.expectedDate);
    }
    if (age >= 10) {
      return order.confirmsDelivery
        ? out("attention", `Shipped ${shortDate(shippedDay)}, ${age} days ago; no delivery email yet.`)
        : out("unconfirmed", `Shipped ${shortDate(shippedDay)}. ${quiet}`);
    }
    return out("arriving", `${order.partiallyDelivered ? "Part delivered. " : ""}${late}Shipped ${shortDate(shippedDay)}`);
  }
  // ordered
  const orderedDay = etDay(order.orderedAt ?? order.lastEventAt);
  const age = daysBetween(orderedDay, today);
  if (!order.shipsPhysically) return age <= 14 ? out("processing", `Ordered ${shortDate(orderedDay)}`) : out("closed", "No shipping email");
  if (age > 45) return out("closed", "No shipping email");
  if (order.issue === "exception") return out("attention", `Ordered ${shortDate(orderedDay)}; the store reported a problem.`);
  if (age >= 7 && order.orderNumber) {
    return out("attention", `${late}Ordered ${shortDate(orderedDay)}, ${age} days ago; no shipping email yet.`);
  }
  return out("processing", `${late}Ordered ${shortDate(orderedDay)}`);
}

export function groupOrders(orders: OnlineOrder[], marks: OrderMark[], now: Date): OrderGroups {
  const byAlias = new Map(marks.map((m) => [m.aliasKey, m]));
  const today = etDay(now);
  const g: OrderGroups = { attention: [], arriving: [], processing: [], unconfirmed: [], recent: [], arrivingToday: 0 };
  for (const o of orders) {
    const c = classifyOrder(o, markFor(o, byAlias), now);
    if (c.state === "attention") g.attention.push(c);
    else if (c.state === "arriving") g.arriving.push(c);
    else if (c.state === "processing") g.processing.push(c);
    else if (c.state === "unconfirmed") g.unconfirmed.push(c);
    else if (c.state === "delivered" || c.state === "canceled") g.recent.push(c);
    if (c.state === "arriving" && c.due === today) g.arrivingToday += 1;
  }
  const byDue = (a: ClassifiedOrder, b: ClassifiedOrder) =>
    (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.order.lastEventAt.localeCompare(a.order.lastEventAt) || a.order.key.localeCompare(b.order.key);
  const byLatest = (a: ClassifiedOrder, b: ClassifiedOrder) =>
    b.order.lastEventAt.localeCompare(a.order.lastEventAt) || a.order.key.localeCompare(b.order.key);
  g.attention.sort(byLatest);
  g.arriving.sort(byDue);
  g.processing.sort(byLatest);
  g.unconfirmed.sort(byLatest);
  g.recent.sort(byLatest);
  return g;
}

// ─── display helpers ─────────────────────────────────────────────────────────

export function itemsLabel(order: OnlineOrder): string {
  if (order.items.length) {
    const more = Math.max((order.itemCount ?? order.items.length) - 1, order.items.length - 1);
    return more > 0 ? `${order.items[0]} and ${more} more` : order.items[0];
  }
  return order.orderNumber ? `Order ${order.orderNumber}` : "Order";
}

/** A carrier tracking page for a number of the right shape, else null (never a link built from free text). */
export function trackingUrl(t: Pick<TrackingNumber, "number" | "carrier">): string | null {
  const n = t.number.trim().toUpperCase();
  const c = (t.carrier ?? "").toLowerCase();
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return `https://www.ups.com/track?tracknum=${n}`;
  if (/^TBA\d{9,15}$/.test(n)) return `https://track.amazon.com/tracking/${n}`;
  if (/^9[1-5]\d{18,20}$/.test(n)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (c === "fedex" && /^(\d{12}|\d{15})$/.test(n)) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (c === "dhl" && /^\d{10}$/.test(n)) return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=${n}`;
  return null;
}

// ─── PATCH /api/orders/[key] request checks ──────────────────────────────────

export const MAX_MARK_BODY_BYTES = 256;
export type MarkAction = "received" | "hide" | "undo";

export function parseOrderKey(raw: string): string | null {
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return ORDER_KEY_RE.test(key) ? key : null;
}

export function parseMarkBody(body: unknown): { ok: true; action: MarkAction } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "action") return { ok: false, error: "body must be exactly {action}" };
  const action = (body as { action: unknown }).action;
  if (action !== "received" && action !== "hide" && action !== "undo") return { ok: false, error: "action must be received, hide or undo" };
  return { ok: true, action };
}

type HeaderGetter = { get(name: string): string | null };

/** CSRF + shape checks: same-origin Origin, JSON content type, small body. */
export function checkMarkRequest(headers: HeaderGetter, requestOrigin: string): { status: number; error: string } | null {
  const origin = headers.get("origin");
  if (!origin) return { status: 403, error: "missing Origin" };
  let o: URL;
  let r: URL;
  try {
    o = new URL(origin);
    r = new URL(requestOrigin);
  } catch {
    return { status: 403, error: "bad Origin" };
  }
  const hosts = [headers.get("x-forwarded-host"), headers.get("host"), r.host].filter(Boolean);
  if (!hosts.includes(o.host)) return { status: 403, error: "cross-origin request refused" };
  const type = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Content-Type must be application/json" };
  const len = headers.get("content-length");
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > MAX_MARK_BODY_BYTES)) return { status: 413, error: "body too large" };
  return null;
}

/** Marks after an action, applied locally by the page (the server applies the same rows). */
export function applyMark(marks: OrderMark[], order: OnlineOrder, action: MarkAction, nowIso: string): OrderMark[] {
  const rest = marks.filter((m) => !order.aliases.includes(m.aliasKey));
  if (action === "undo") return rest;
  return [...rest, { aliasKey: order.key, receivedAt: action === "received" ? nowIso : null, hidden: action === "hide", updatedAt: nowIso }];
}
