// PunchOut orchestration (2026-11-11): supplier registry, session tokens, the start and return flows,
// and the synthetic test supplier. Storage and HTTP are injected (PunchoutStore, fetch) so the node tests
// run the whole round trip offline; lib/punchout-store.ts is the Supabase-backed store.
//
// Trust model:
//  - /start runs behind the owner login (middleware). It creates a session (only a SHA-256 of the URL
//    secret is stored), sends the cXML PunchOutSetupRequest and returns the StartPage, which must be https
//    on a host allow-listed for that supplier (no open redirect).
//  - The return arrives cross-site without the Onyx cookie. It is accepted only with the session's
//    secret (constant-time compare), the matching BuyerCookie, before expiry, once (a duplicate post of the
//    same payload is idempotent; a different payload is a replay and is refused). Decided atomically in
//    pds.procurement_punchout_record_return.
//  - Supplier credentials live only in the server env (PUNCHOUT_SUPPLIERS). Nothing here sends a
//    purchase order: a returned cart is a price snapshot.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  buildOrderMessage,
  buildSetupRequest,
  buildStatusResponse,
  CxmlError,
  MAX_CXML_BYTES,
  parseOrderMessage,
  parseSetupRequest,
  parseSetupResponse,
  xmlEscape,
  type Credential,
  type DeploymentMode,
  type OrderMessage,
  type SenderCredential,
} from "./cxml";
import { RETURN_TOKEN_RE, TEST_SUPPLIER_SETUP_PATH, returnPath } from "./punchout-paths";

export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const SETUP_TIMEOUT_MS = 15_000;
export const TEST_SUPPLIER_KEY = "test-supplier";
export const TEST_SUPPLIER_NAME = "Test supplier (synthetic)";
export const USER_AGENT = "Onyx PunchOut 1.0";
// The single Onyx account (same default as middleware.ts). Not a secret.
export const OWNER_USER_ID = process.env.ONYX_OWNER_USER_ID || "dc041abc-115a-4252-8536-803f2ac75557";

export type SupplierSource = "cxml" | "synthetic";

export interface SupplierConfig {
  key: string;
  name: string;
  source: SupplierSource;
  setupUrl: string;
  startPageHosts: string[];
  from: Credential;
  to: Credential;
  sender: SenderCredential;
  deploymentMode: DeploymentMode;
  userAgent: string;
}

/** What the browser may see about a supplier: never credentials. */
export interface SupplierCard {
  key: string;
  name: string;
  source: SupplierSource;
  mode: DeploymentMode;
  connected: boolean;
}

// ---------------------------------------------------------------------------
// Registry (server env JSON)
// ---------------------------------------------------------------------------
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HOST_RE = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|^\[/;

function cred(raw: unknown, withSecret: boolean): SenderCredential | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const domain = typeof r.domain === "string" ? r.domain.trim() : "";
  const identity = typeof r.identity === "string" ? r.identity.trim() : "";
  const sharedSecret = typeof r.sharedSecret === "string" ? r.sharedSecret : "";
  if (!domain || !identity || (withSecret && !sharedSecret)) return null;
  return { domain, identity, sharedSecret: withSecret ? sharedSecret : "" };
}

/**
 * Parse PUNCHOUT_SUPPLIERS: a JSON array of
 * {key, name, setupUrl, startPageHosts[], from{domain,identity}, to{domain,identity},
 *  sender{domain,identity,sharedSecret}, deploymentMode "test"|"production"}.
 * Invalid entries are skipped and reported by key (never with their values).
 */
export function parseSupplierRegistry(json: string | undefined): { suppliers: SupplierConfig[]; errors: string[] } {
  const suppliers: SupplierConfig[] = [];
  const errors: string[] = [];
  if (!json || !json.trim()) return { suppliers, errors };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { suppliers, errors: ["PUNCHOUT_SUPPLIERS is not valid JSON"] };
  }
  if (!Array.isArray(raw)) return { suppliers, errors: ["PUNCHOUT_SUPPLIERS must be a JSON array"] };
  raw.forEach((entry, idx) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const key = typeof e.key === "string" ? e.key : "";
    const label = KEY_RE.test(key) ? key : `#${idx + 1}`;
    if (!KEY_RE.test(key) || key === TEST_SUPPLIER_KEY) return void errors.push(`${label}: bad key`);
    if (suppliers.some((s) => s.key === key)) return void errors.push(`${label}: duplicate key`);
    let setup: URL;
    try {
      setup = new URL(String(e.setupUrl ?? ""));
    } catch {
      return void errors.push(`${label}: setupUrl is not a URL`);
    }
    if (setup.protocol !== "https:" || setup.username || setup.password || IP_LITERAL.test(setup.hostname)) {
      return void errors.push(`${label}: setupUrl must be an https URL on a named host`);
    }
    const hosts = Array.isArray(e.startPageHosts)
      ? e.startPageHosts.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase())
      : [];
    if (!hosts.length || !hosts.every((h) => HOST_RE.test(h) && !IP_LITERAL.test(h))) {
      return void errors.push(`${label}: startPageHosts must list the supplier's StartPage hosts`);
    }
    const from = cred(e.from, false);
    const to = cred(e.to, false);
    const sender = cred(e.sender, true);
    if (!from || !to || !sender) return void errors.push(`${label}: from/to/sender credentials incomplete`);
    const mode = e.deploymentMode === "production" ? "production" : e.deploymentMode === "test" ? "test" : null;
    if (!mode) return void errors.push(`${label}: deploymentMode must be "test" or "production"`);
    suppliers.push({
      key,
      name: typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, 80) : key,
      source: "cxml",
      setupUrl: setup.toString(),
      startPageHosts: hosts,
      from: { domain: from.domain, identity: from.identity },
      to: { domain: to.domain, identity: to.identity },
      sender,
      deploymentMode: mode,
      userAgent: USER_AGENT,
    });
  });
  return { suppliers, errors };
}

/** The synthetic supplier's shared secret, derived from a server secret so no new env var is needed. */
export function testSupplierSecret(serverSecret: string | undefined): string | null {
  if (!serverSecret) return null;
  return createHmac("sha256", serverSecret).update("onyx-punchout-test-supplier-v1").digest("base64url");
}

export const TEST_SUPPLIER_IDS = {
  buyer: { domain: "NetworkID", identity: "onyx-buyer" },
  supplier: { domain: "NetworkID", identity: "onyx-test-supplier" },
} as const;

export function testSupplierConfig(origin: string, secret: string): SupplierConfig {
  const host = new URL(origin).host.toLowerCase();
  return {
    key: TEST_SUPPLIER_KEY,
    name: TEST_SUPPLIER_NAME,
    source: "synthetic",
    setupUrl: `${origin}${TEST_SUPPLIER_SETUP_PATH}`,
    startPageHosts: [host],
    from: { ...TEST_SUPPLIER_IDS.buyer },
    to: { ...TEST_SUPPLIER_IDS.supplier },
    sender: { ...TEST_SUPPLIER_IDS.buyer, sharedSecret: secret },
    deploymentMode: "test",
    userAgent: USER_AGENT,
  };
}

export function supplierCards(suppliers: SupplierConfig[]): SupplierCard[] {
  return suppliers.map((s) => ({ key: s.key, name: s.name, source: s.source, mode: s.deploymentMode, connected: true }));
}

/** https on an allow-listed host (http only for localhost, for local development). */
export function isAllowedUrl(url: string, hosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return false;
  return hosts.includes(u.host.toLowerCase());
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
export function newSessionToken(rand: (n: number) => Buffer = randomBytes) {
  const sessionId = rand(16).toString("hex");
  const secret = rand(32).toString("base64url");
  const buyerCookie = rand(24).toString("base64url");
  return { sessionId, secret, secretHash: sha256Hex(secret), buyerCookie };
}
export function splitToken(token: string): { sessionId: string; secret: string } | null {
  const m = RETURN_TOKEN_RE.exec(token);
  return m ? { sessionId: m[1], secret: m[2] } : null;
}
function safeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
export function secretMatches(secret: string, storedHash: string): boolean {
  const computed = Buffer.from(sha256Hex(secret), "hex");
  const stored = Buffer.from(/^[0-9a-f]{64}$/.test(storedHash) ? storedHash : "0".repeat(64), "hex");
  return timingSafeEqual(computed, stored);
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------
export interface SessionRow {
  session_id: string;
  secret_hash: string;
  buyer_cookie: string;
  supplier_key: string;
  source: SupplierSource;
  owner_id: string;
  status: "started" | "returned" | "cancelled" | "failed" | "expired";
  expires_at: string;
}
export type ReturnOutcome =
  | "created"
  | "duplicate"
  | "cancelled"
  | "duplicate_cancel"
  | "replay"
  | "expired"
  | "not_open"
  | "unknown";
export interface PunchoutStore {
  createSession(row: SessionRow & { operation: string; created_at: string }): Promise<void>;
  getSession(sessionId: string): Promise<SessionRow | null>;
  markFailed(sessionId: string, code: string): Promise<void>;
  recordReturn(
    sessionId: string,
    payloadHash: string,
    cart: Record<string, unknown>,
    lines: Record<string, unknown>[],
  ): Promise<{ outcome: ReturnOutcome; cart_id: number | null }>;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
export type StartResult =
  | { ok: true; startPage: string; sessionId: string }
  | { ok: false; status: number; code: string; message: string };

export async function startPunchout(deps: {
  store: PunchoutStore;
  fetchFn: typeof fetch;
  now: Date;
  origin: string;
  supplier: SupplierConfig;
  ownerId: string;
  rand?: (n: number) => Buffer;
}): Promise<StartResult> {
  const { store, supplier, now } = deps;
  const t = newSessionToken(deps.rand);
  await store.createSession({
    session_id: t.sessionId,
    secret_hash: t.secretHash,
    buyer_cookie: t.buyerCookie,
    supplier_key: supplier.key,
    source: supplier.source,
    owner_id: deps.ownerId,
    status: "started",
    operation: "create",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  });
  const fail = async (status: number, code: string, message: string): Promise<StartResult> => {
    try {
      await store.markFailed(t.sessionId, code);
    } catch {
      /* the session simply expires */
    }
    return { ok: false, status, code, message };
  };
  const body = buildSetupRequest({
    payloadId: `${now.getTime()}.${t.sessionId}@onyx`,
    timestamp: now.toISOString(),
    from: supplier.from,
    to: supplier.to,
    sender: supplier.sender,
    userAgent: supplier.userAgent,
    buyerCookie: t.buyerCookie,
    browserFormPostUrl: `${deps.origin}${returnPath(t.sessionId, t.secret)}`,
    supplierSetupUrl: supplier.setupUrl,
    deploymentMode: supplier.deploymentMode,
  });
  let text: string;
  try {
    const res = await deps.fetchFn(supplier.setupUrl, {
      method: "POST",
      headers: { "content-type": "text/xml; charset=utf-8", accept: "text/xml, application/xml" },
      body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
    });
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_CXML_BYTES) return fail(502, "setup_too_large", "The supplier's setup answer was too large.");
    text = await res.text();
    if (!res.ok && !text.includes("<cXML")) {
      return fail(502, "setup_http_error", `The supplier answered HTTP ${res.status}.`);
    }
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return fail(504, timeout ? "setup_timeout" : "setup_unreachable", timeout ? "The supplier did not answer in time." : "Could not reach the supplier.");
  }
  let startPage: string;
  try {
    startPage = parseSetupResponse(text).startPageUrl;
  } catch (e) {
    const code = e instanceof CxmlError ? e.code : "setup_unreadable";
    return fail(502, code, e instanceof CxmlError ? e.message : "The supplier's setup answer could not be read.");
  }
  if (!isAllowedUrl(startPage, supplier.startPageHosts)) {
    return fail(502, "start_page_not_allowed", "The supplier's StartPage is not on an allowed https host.");
  }
  return { ok: true, startPage, sessionId: t.sessionId };
}

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------
export type ReturnResult =
  | { kind: "cart"; cartId: number; duplicate: boolean }
  | { kind: "cancelled" }
  | { kind: "error"; status: number; code: string; message: string };

export function cartRows(msg: OrderMessage, session: Pick<SessionRow, "session_id" | "supplier_key" | "source">) {
  const cart = {
    payload_id: msg.payloadId,
    operation_allowed: msg.operationAllowed,
    supplier_total: msg.total?.amount ?? null,
    total_currency: msg.total?.currency ?? null,
    shipping: msg.shipping?.amount ?? null,
    shipping_currency: msg.shipping?.currency ?? null,
    tax: msg.tax?.amount ?? null,
    tax_currency: msg.tax?.currency ?? null,
  };
  const lines = msg.lines.map((l, idx) => ({
    line_no: idx + 1,
    supplier_part_id: l.supplierPartId,
    supplier_part_aux_id: l.supplierPartAuxId,
    description: l.description,
    quantity: l.quantity,
    uom: l.uom,
    unit_price: l.unitPrice,
    currency: l.currency,
    classification_domain: l.classificationDomain,
    classification: l.classification,
    manufacturer_part_id: l.manufacturerPartId,
    manufacturer_name: l.manufacturerName,
    provenance: {
      via: session.source === "synthetic" ? "synthetic test supplier (cXML PunchOutOrderMessage)" : "supplier cXML PunchOutOrderMessage",
      supplier_key: session.supplier_key,
      session_id: session.session_id,
      payload_id: msg.payloadId,
      deployment_mode: msg.deploymentMode,
      line_index: idx,
    },
  }));
  return { cart, lines };
}

/** Read the BrowserFormPost body: cxml-urlencoded (standard) or cxml-base64. */
export function cxmlFromForm(form: URLSearchParams | FormData): string | null {
  const urlenc = form.get("cxml-urlencoded");
  if (typeof urlenc === "string" && urlenc.trim()) return urlenc;
  const b64 = form.get("cxml-base64");
  if (typeof b64 === "string" && b64.trim()) {
    if (b64.length > MAX_CXML_BYTES * 2) return null;
    return Buffer.from(b64.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  return null;
}

export async function acceptReturn(deps: { store: PunchoutStore; now: Date }, token: string, cxml: string | null): Promise<ReturnResult> {
  const parts = splitToken(token);
  const unknown: ReturnResult = { kind: "error", status: 404, code: "unknown_session", message: "This PunchOut session is not known." };
  if (!parts) return unknown;
  const session = await deps.store.getSession(parts.sessionId);
  if (!session || !secretMatches(parts.secret, session.secret_hash)) return unknown;
  if (!cxml) return { kind: "error", status: 400, code: "missing_cxml", message: "The supplier sent no cXML cart." };
  let msg: OrderMessage;
  try {
    msg = parseOrderMessage(cxml);
  } catch (e) {
    const code = e instanceof CxmlError ? e.code : "malformed_xml";
    return { kind: "error", status: code === "too_large" || code === "too_many_lines" ? 413 : 400, code, message: e instanceof CxmlError ? e.message : "The cart could not be read." };
  }
  if (!safeEqualStr(msg.buyerCookie, session.buyer_cookie)) {
    return { kind: "error", status: 400, code: "cookie_mismatch", message: "The cart belongs to a different PunchOut session." };
  }
  const { cart, lines } = cartRows(msg, session);
  const { outcome, cart_id } = await deps.store.recordReturn(session.session_id, sha256Hex(cxml), cart, lines);
  switch (outcome) {
    case "created":
    case "duplicate":
      return { kind: "cart", cartId: Number(cart_id), duplicate: outcome === "duplicate" };
    case "cancelled":
    case "duplicate_cancel":
      return { kind: "cancelled" };
    case "replay":
      return { kind: "error", status: 409, code: "replay", message: "This session already returned a different cart. Start a new session." };
    case "expired":
      return { kind: "error", status: 410, code: "expired", message: "This PunchOut session expired. Start a new one from Onyx." };
    case "not_open":
      return { kind: "error", status: 409, code: "session_closed", message: "This PunchOut session is closed." };
    default:
      return unknown;
  }
}

// ---------------------------------------------------------------------------
// Synthetic test supplier (hosted inside Onyx; never a real merchant)
// ---------------------------------------------------------------------------
export interface CatalogItem {
  partId: string;
  auxId: string | null;
  description: string;
  uom: string;
  unitPrice: string;
  classification: string;
}
export const TEST_CATALOG: CatalogItem[] = [
  { partId: "SYN-PEN-BLK10", auxId: "pack-10", description: "Synthetic gel pens, black, pack of 10", uom: "PK", unitPrice: "6.50", classification: "44121701" },
  { partId: "SYN-NB-A5", auxId: null, description: "Synthetic dot-grid notebook, A5", uom: "EA", unitPrice: "12.00", classification: "14111514" },
  { partId: "SYN-USBC-2M", auxId: "length-2m", description: "Synthetic USB-C cable, 2 m", uom: "EA", unitPrice: "9.99", classification: "26121609" },
  { partId: "SYN-AA-24", auxId: "pack-24", description: "Synthetic AA batteries, box of 24", uom: "BX", unitPrice: "18.75", classification: "26111702" },
];

interface Blob {
  c: string; // buyer cookie
  r: string; // BrowserFormPost URL
  e: number; // expiry (ms)
  p: string; // setup payloadID
}
export function signBlob(b: Blob, secret: string): string {
  const body = Buffer.from(JSON.stringify(b), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}
export function verifyBlob(s: string | null | undefined, secret: string, now: Date): Blob | null {
  if (!s || s.length > 4000) return null;
  const [body, mac, extra] = s.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const want = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqualStr(mac, want)) return null;
  try {
    const b = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Blob;
    if (typeof b.c !== "string" || typeof b.r !== "string" || typeof b.e !== "number" || b.e < now.getTime()) return null;
    return b;
  } catch {
    return null;
  }
}

/** The return URL must be this Onyx origin's own return path (the synthetic supplier only ever posts back here). */
export function isOwnReturnUrl(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === origin && !u.search && !u.hash && splitToken(u.pathname.slice(u.pathname.lastIndexOf("/") + 1)) !== null && u.pathname.startsWith("/api/procurement/punchout/public/return/");
  } catch {
    return false;
  }
}

/** The synthetic supplier's PunchOutSetupRequest handler. Returns the cXML answer. */
export function handleTestSupplierSetup(xml: string, ctx: { secret: string; origin: string; now: Date }): { status: number; body: string } {
  const ts = ctx.now.toISOString();
  const pid = `${ctx.now.getTime()}.setup@onyx-test-supplier`;
  let req;
  try {
    req = parseSetupRequest(xml);
  } catch (e) {
    return { status: 400, body: buildStatusResponse(pid, ts, 400, e instanceof CxmlError ? e.code : "malformed_xml") };
  }
  const authOk =
    safeEqualStr(req.sender.sharedSecret, ctx.secret) &&
    req.to.identity === TEST_SUPPLIER_IDS.supplier.identity &&
    req.sender.identity === TEST_SUPPLIER_IDS.buyer.identity;
  if (!authOk) return { status: 401, body: buildStatusResponse(pid, ts, 401, "Unauthorized") };
  if (req.operation !== "create") return { status: 200, body: buildStatusResponse(pid, ts, 450, "Only create is supported") };
  if (!isOwnReturnUrl(req.browserFormPostUrl, ctx.origin)) {
    return { status: 400, body: buildStatusResponse(pid, ts, 400, "BrowserFormPost must be this Onyx origin's return path") };
  }
  const blob = signBlob({ c: req.buyerCookie, r: req.browserFormPostUrl, e: ctx.now.getTime() + SESSION_TTL_MS, p: req.payloadId }, ctx.secret);
  return { status: 200, body: buildStatusResponse(pid, ts, 200, "success", `${ctx.origin}/procurement/test-supplier?s=${encodeURIComponent(blob)}`) };
}

export type CheckoutResult = { ok: true; returnUrl: string; cxml: string } | { ok: false; status: number; message: string };

/** The synthetic supplier's "Return cart" step: build a real PunchOutOrderMessage from the chosen quantities. */
export function testSupplierCheckout(
  form: { s: string | null; action: string | null; quantities: Record<string, string | null> },
  ctx: { secret: string; origin: string; now: Date },
): CheckoutResult {
  const blob = verifyBlob(form.s, ctx.secret, ctx.now);
  if (!blob || !isOwnReturnUrl(blob.r, ctx.origin)) return { ok: false, status: 400, message: "This test-supplier session is invalid or expired. Start again from Onyx." };
  const lines: { supplierPartId: string; supplierPartAuxId: string | null; description: string; quantity: string; uom: string; unitPrice: string; currency: string; classificationDomain: string; classification: string }[] = [];
  if (form.action !== "cancel") {
    for (const item of TEST_CATALOG) {
      const raw = (form.quantities[item.partId] ?? "").trim();
      if (!raw || raw === "0") continue;
      if (!/^\d{1,2}$/.test(raw)) return { ok: false, status: 400, message: "Quantities must be whole numbers from 0 to 99." };
      lines.push({ supplierPartId: item.partId, supplierPartAuxId: item.auxId, description: item.description, quantity: raw, uom: item.uom, unitPrice: item.unitPrice, currency: "USD", classificationDomain: "UNSPSC", classification: item.classification });
    }
    if (!lines.length) return { ok: false, status: 400, message: "Choose at least one item, or use Cancel to return an empty cart." };
  }
  const cxml = buildOrderMessage({
    payloadId: `${ctx.now.getTime()}.cart@onyx-test-supplier`,
    timestamp: ctx.now.toISOString(),
    from: { ...TEST_SUPPLIER_IDS.supplier },
    to: { ...TEST_SUPPLIER_IDS.buyer },
    sender: { ...TEST_SUPPLIER_IDS.supplier, sharedSecret: "" },
    userAgent: "Onyx synthetic test supplier",
    buyerCookie: blob.c,
    deploymentMode: "test",
    operationAllowed: "create",
    lines,
  });
  return { ok: true, returnUrl: blob.r, cxml };
}

/** HTML that posts the cart to the buyer's BrowserFormPost URL (auto-submits; the button works without JS). */
export function autoPostHtml(returnUrl: string, cxml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Returning cart to Onyx</title></head>` +
    `<body style="font-family:system-ui;background:#0b0b0f;color:#e5e5e5;padding:2rem">` +
    `<form id="punchout-return" method="post" action="${xmlEscape(returnUrl)}">` +
    `<input type="hidden" name="cxml-urlencoded" value="${xmlEscape(cxml)}">` +
    `<p>Test supplier (synthetic): returning your cart to Onyx...</p><button type="submit">Return cart to Onyx</button></form>` +
    `<script>document.getElementById('punchout-return').submit();</script></body></html>`;
}

/** Plain HTML page for errors on the browser-facing return. */
export function messagePage(title: string, message: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${xmlEscape(title)}</title></head>` +
    `<body style="font-family:system-ui;background:#0b0b0f;color:#e5e5e5;padding:2rem"><h1>${xmlEscape(title)}</h1><p>${xmlEscape(message)}</p>` +
    `<p><a style="color:#7dd3fc" href="/procurement/shop">Back to Shop in Onyx</a></p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
