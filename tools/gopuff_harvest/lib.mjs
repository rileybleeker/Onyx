// Pure helpers for the goPuff harvester (no Playwright, no network): shape probing, order
// mapping and paging. Kept separate so the logic can be read without a browser.
//
// The goPuff web app answers its own GraphQL query "OrdersByUserId" (found 2026-11-13). The exact
// response shape has NOT been verified against a signed-in session yet, so everything here is
// tolerant: it looks for the order list and the fields it needs under several likely names, only
// ever copies a short allow-list of fields (never an address, phone number or email), and the
// harvester has a --probe mode that prints the response's shape (key names and value types, never
// values) so the field names can be pinned down after the first signed-in run.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Key paths + value types of a JSON value, no values. Arrays show their first element only. */
export function shapeOf(v, depth = 0, maxDepth = 8) {
  if (v === null) return "null";
  if (Array.isArray(v)) return depth >= maxDepth ? "array" : [`array(${v.length})`, v.length ? shapeOf(v[0], depth + 1, maxDepth) : null];
  if (isObj(v)) {
    if (depth >= maxDepth) return "object";
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = shapeOf(v[k], depth + 1, maxDepth);
    return out;
  }
  return typeof v;
}

const pick = (o, names) => {
  if (!isObj(o)) return undefined;
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n];
  return undefined;
};

const ITEM_LISTS = ["items", "products", "lineItems", "orderItems", "cartItems"];

/** Find the array of orders: the first array of objects under data whose elements look like orders. */
export function findOrders(json) {
  let found = null;
  const looksLikeOrder = (o) => isObj(o) && (pick(o, ITEM_LISTS) !== undefined || /order/i.test(String(o.__typename || "")));
  const walk = (v, depth) => {
    if (found || depth > 8) return;
    if (Array.isArray(v)) {
      if (v.length && v.every(isObj) && v.some(looksLikeOrder)) { found = v; return; }
      for (const x of v) walk(x, depth + 1);
    } else if (isObj(v)) {
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    }
  };
  walk(json && json.data, 0);
  return found || [];
}

/** { hasNext, cursor, known } from whatever pagination block the response carries. */
export function pageInfoOf(json) {
  let info = null;
  const walk = (v, depth) => {
    if (info || depth > 8) return;
    if (isObj(v)) {
      if ("hasNext" in v || "hasNextPage" in v || "hasMore" in v) { info = v; return; }
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    } else if (Array.isArray(v)) {
      for (const x of v.slice(0, 3)) walk(x, depth + 1);
    }
  };
  walk(json && json.data, 0);
  if (!info) return { hasNext: false, cursor: null, known: false };
  const hasNext = !!(info.hasNext ?? info.hasNextPage ?? info.hasMore);
  const cursor = pick(info, ["endCursor", "nextCursor", "cursor", "next", "nextToken"]);
  return { hasNext, cursor: typeof cursor === "string" ? cursor : null, known: true };
}

const PAGING_KEYS = /^(after|cursor|nextcursor|offset|skip|page|pagenumber|pageindex|nexttoken)$/i;

/** Where the paging value lives in the GraphQL variables: { path, key } or null. */
export function findPagingSlot(variables) {
  if (!isObj(variables)) return null;
  for (const k of Object.keys(variables)) if (PAGING_KEYS.test(k)) return { path: [], key: k };
  for (const k of Object.keys(variables)) {
    if (isObj(variables[k])) for (const k2 of Object.keys(variables[k])) if (PAGING_KEYS.test(k2)) return { path: [k], key: k2 };
  }
  return null;
}

/** A copy of the variables set for the next page, or null when the next value cannot be worked out. */
export function nextVariables(variables, slot, pageInfo, ordersOnPage, pageNo) {
  if (!slot) return null;
  const copy = JSON.parse(JSON.stringify(variables));
  let holder = copy;
  for (const p of slot.path) holder = holder[p];
  const cur = holder[slot.key];
  if (pageInfo.cursor) {
    holder[slot.key] = pageInfo.cursor;
  } else if (typeof cur === "number" || cur === undefined || cur === null) {
    if (/^(offset|skip)$/i.test(slot.key)) holder[slot.key] = (Number(cur) || 0) + ordersOnPage;
    else if (/^(page|pagenumber|pageindex)$/i.test(slot.key)) holder[slot.key] = (Number(cur) || (pageNo - 1)) + 1;
    else return null;
  } else {
    return null;
  }
  return copy;
}

const toIso = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

// goPuff prices have not been seen yet: a key that says "cents" is cents, anything else is taken
// as dollars (string or float) and converted, because the import route expects cents. The price
// is only a size hint for the nutrition estimate, so a wrong unit cannot corrupt anything else.
const toCents = (v, key) => {
  const n = typeof v === "string" ? Number(v.replace(/[^0-9.\-]/g, "")) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return /cents/i.test(key || "") ? Math.round(n) : Math.round(n * 100);
};

const PRICE_KEYS = ["priceCents", "unitPriceCents", "price", "unitPrice", "amount", "listPrice"];

/** Copy ONLY these fields. Anything else in the response (address, phone, email, payment) is dropped here. */
export function mapOrder(o) {
  const id = pick(o, ["id", "orderId", "orderNumber", "uuid", "orderUuid"]);
  const when = toIso(pick(o, ["deliveredAt", "completedAt", "deliveredTime", "deliveryTime", "placedAt", "createdAt", "orderDate", "date"]));
  const status = String(pick(o, ["status", "orderStatus", "state"]) ?? "");
  const rawItems = pick(o, ITEM_LISTS) ?? [];
  const list = Array.isArray(rawItems) ? rawItems : isObj(rawItems) ? (pick(rawItems, ["nodes", "edges", "items"]) ?? []) : [];
  const items = list
    .map((it, idx) => {
      const node = isObj(it) && isObj(it.node) ? it.node : it;
      if (!isObj(node)) return { title: null };
      const product = isObj(node.product) ? node.product : node;
      const title = pick(product, ["name", "title", "productName", "displayName"]) ?? pick(node, ["name", "title", "productName"]);
      const priceKey = PRICE_KEYS.find((k) => node[k] !== undefined && node[k] !== null) || "";
      const qty = Number(pick(node, ["quantity", "qty", "count"]));
      const base = pick(node, ["id", "itemId", "lineItemId"]) ?? pick(product, ["id", "productId", "sku"]) ?? "item";
      return {
        key: `${base}:${idx}`,
        title: typeof title === "string" ? title : null,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        price: priceKey ? toCents(node[priceKey], priceKey) : null,
        customizations: [],
      };
    })
    .filter((i) => i.title);
  const totalKey = ["totalCents", "total", "orderTotal", "grandTotal"].find((k) => o[k] !== undefined && o[k] !== null);
  return {
    uuid: id !== undefined ? String(id) : null,
    store: "goPuff",
    completedAt: when,
    isCancelled: /cancel/i.test(status),
    currency: typeof o.currency === "string" ? o.currency : "USD",
    total: totalKey ? toCents(o[totalKey], totalKey) : null,
    multiConsumer: false,
    items,
  };
}
