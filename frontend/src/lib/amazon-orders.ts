/**
 * POST /api/orders/amazon/import (tools/kindle_harvest/amazon-orders.mjs, Riley's PC, CI token):
 * the personal Amazon account's "Your Orders" list -> pds.online_order_events rows. Pure, no imports.
 *
 * Each order becomes insert-only events (message_id "amazon-web:<order>:<status>:<date>"), so the
 * FIRST time a status is seen fixes its time: "shipped" does not move forward on every harvest and
 * the overdue clock in lib/online-orders.ts works. A new expected date (a delay) is a new event.
 * orders_email_etl.py joins them into pds.online_orders on its next run, keyed by store amazon.com
 * + the order number. Never accepted: amounts, addresses, names (the payload has no such fields and
 * item text with a currency amount is dropped).
 */

export const AMAZON_STATUSES = ["ordered", "shipped", "out_for_delivery", "delivered", "canceled"] as const;
export type AmazonStatus = (typeof AMAZON_STATUSES)[number];

export interface AmazonOrder {
  order_number: string;
  ordered_on: string;
  status: AmazonStatus;
  status_on: string | null;
  expected_on: string | null;
  delayed: boolean;
  items: string[];
}

export const MAX_AMAZON_ORDERS = 60;
export const MAX_AMAZON_BODY_BYTES = 64_000;
const ORDER_NO = /^(\d{3}|D\d{2})-\d{7}-\d{7}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /[$€£]\s?\d|\b\d+\.\d{2}\s?(USD|EUR|GBP)\b/i;
export const AMAZON_PARSER_VERSION = 1;

function day(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !DAY.test(v)) throw new Error("bad date");
  const d = new Date(v + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new Error("bad date");
  return v;
}

export type ParsedImport =
  | { ok: true; kind: "orders"; orders: AmazonOrder[]; scanned: number; unparsed: number }
  | { ok: true; kind: "error"; error: string }
  | { ok: false; error: string };

export function parseAmazonImport(body: unknown): ParsedImport {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (typeof b.error === "string") {
    return { ok: true, kind: "error", error: b.error.replace(/\s+/g, " ").slice(0, 200) };
  }
  if (!Array.isArray(b.orders) || b.orders.length > MAX_AMAZON_ORDERS) return { ok: false, error: `orders must be an array of at most ${MAX_AMAZON_ORDERS}` };
  const orders: AmazonOrder[] = [];
  for (const raw of b.orders) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "each order must be an object" };
    const o = raw as Record<string, unknown>;
    if (typeof o.order_number !== "string" || !ORDER_NO.test(o.order_number)) return { ok: false, error: "bad order_number" };
    if (!AMAZON_STATUSES.includes(o.status as AmazonStatus)) return { ok: false, error: "bad status" };
    let ordered: string | null;
    let statusOn: string | null;
    let expectedOn: string | null;
    try {
      ordered = day(o.ordered_on);
      statusOn = day(o.status_on);
      expectedOn = day(o.expected_on);
    } catch {
      return { ok: false, error: "bad date" };
    }
    if (!ordered) return { ok: false, error: "ordered_on required" };
    const items = (Array.isArray(o.items) ? o.items : [])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.replace(/\s+/g, " ").trim().slice(0, 90))
      .filter((x) => x.length >= 3 && !AMOUNT.test(x))
      .slice(0, 5);
    orders.push({
      order_number: o.order_number.toUpperCase(),
      ordered_on: ordered,
      status: o.status as AmazonStatus,
      status_on: statusOn,
      expected_on: expectedOn,
      delayed: o.delayed === true,
      items,
    });
  }
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return { ok: true, kind: "orders", orders, scanned: n(b.scanned), unparsed: n(b.unparsed) };
}

/** Noon ET on a calendar day, as UTC (17:00Z in winter, 16:00Z in summer: either is the same ET day). */
function noonEt(ymd: string): string {
  return `${ymd}T17:00:00+00:00`;
}

export interface EventRow {
  message_id: string;
  account_fp: string;
  received_at: string;
  sender_address: string;
  sender_name: string | null;
  subject: null;
  parse_status: "parsed";
  note: null;
  kind: "merchant";
  merchant_key: "amazon.com";
  merchant_name: "Amazon";
  order_number: string;
  tracking: [];
  status: string;
  expected_date: string | null;
  items: string[];
  item_count: number | null;
  parser_version: number;
  synced_at: string;
}

/** Events for one order. Insert-only on message_id: an existing row keeps its first-seen time. */
export function eventsFor(o: AmazonOrder, nowIso: string): EventRow[] {
  const base = {
    account_fp: "amazon-web",
    sender_address: "amazon-web",
    sender_name: "Amazon",
    subject: null,
    parse_status: "parsed" as const,
    note: null,
    kind: "merchant" as const,
    merchant_key: "amazon.com" as const,
    merchant_name: "Amazon" as const,
    order_number: o.order_number,
    tracking: [] as [],
    items: o.items,
    item_count: o.items.length || null,
    parser_version: AMAZON_PARSER_VERSION,
    synced_at: nowIso,
  };
  const id = (s: string) => `amazon-web:${o.order_number}:${s}`;
  const rows: EventRow[] = [{ ...base, message_id: id("ordered"), received_at: noonEt(o.ordered_on), status: "ordered", expected_date: null }];
  // A status seen at harvest time is stamped "now"; never earlier than the order itself.
  const seen = nowIso < noonEt(o.ordered_on) ? noonEt(o.ordered_on) : nowIso;
  if (o.status === "delivered") {
    rows.push({ ...base, message_id: id(`delivered:${o.status_on ?? ""}`), received_at: o.status_on ? `${o.status_on}T21:00:00+00:00` : seen, status: "delivered", expected_date: null });
  } else if (o.status === "shipped" || o.status === "out_for_delivery") {
    rows.push({ ...base, message_id: id(`${o.status}:${o.expected_on ?? ""}`), received_at: seen, status: o.status, expected_date: o.expected_on });
    if (o.delayed) rows.push({ ...base, message_id: id(`delayed:${o.expected_on ?? ""}`), received_at: seen, status: "delayed", expected_date: o.expected_on });
  } else if (o.status === "canceled") {
    rows.push({ ...base, message_id: id("canceled"), received_at: seen, status: "canceled", expected_date: null });
  }
  return rows;
}
