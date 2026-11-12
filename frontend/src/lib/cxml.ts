// cXML 1.2 PunchOut, buyer side (2026-11-11): build a PunchOutSetupRequest, read the supplier's
// PunchOutSetupResponse (StartPage) and the PunchOutOrderMessage the supplier posts back.
//
// No dependency. The XML reader below is deliberately small and strict:
//   - it never fetches or expands a DTD: the only DOCTYPE accepted is the standard external
//     `<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/<version>/cXML.dtd">` line (skipped, never
//     loaded); any internal subset, <!ENTITY>, <!ELEMENT> or other markup declaration is refused;
//   - entity references are limited to the five XML built-ins and numeric character references;
//   - input size, nesting depth, node count and cart lines are capped.
// Money and quantities stay decimal strings and are computed with scaled BigInt, never floats.
// Pure module (no server imports) so the node tests can compile it on its own.

export const MAX_CXML_BYTES = 1_000_000;
export const MAX_CART_LINES = 500;
const MAX_DEPTH = 40;
const MAX_NODES = 20_000;
export const SUPPORTED_CURRENCIES = ["USD", "CAD", "EUR", "GBP"] as const;
export const CXML_DTD_VERSION = "1.2.014";

export class CxmlError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CxmlError";
  }
}

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const STANDARD_DOCTYPE = /^<!DOCTYPE\s+cXML\s+SYSTEM\s+"http:\/\/xml\.cxml\.org\/schemas\/cXML\/[0-9.]{1,12}\/cXML\.dtd"\s*>$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;\s&<]{0,12});?/g, (match, ref: string) => {
    if (!match.endsWith(";")) throw new CxmlError("malformed_xml", "Bare '&' in XML text.");
    switch (ref) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return '"';
      case "apos": return "'";
    }
    let code: number;
    if (/^#x[0-9a-fA-F]{1,6}$/.test(ref)) code = parseInt(ref.slice(2), 16);
    else if (/^#[0-9]{1,7}$/.test(ref)) code = parseInt(ref.slice(1), 10);
    else throw new CxmlError("entity_forbidden", `Entity '&${ref};' is not allowed.`);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new CxmlError("malformed_xml", "Invalid character reference.");
    }
    return String.fromCodePoint(code);
  });
}

/** Parse a cXML document into a tree. Throws CxmlError on anything outside the safe subset. */
export function parseXml(input: string): XmlNode {
  if (typeof input !== "string" || input.length === 0) throw new CxmlError("empty", "Empty cXML payload.");
  if (input.length > MAX_CXML_BYTES || byteLength(input) > MAX_CXML_BYTES) {
    throw new CxmlError("too_large", `cXML payload is over ${MAX_CXML_BYTES} bytes.`);
  }
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let pos = 0;
  let nodes = 0;
  let sawRoot = false;
  let sawDoctype = false;

  while (pos < src.length) {
    const lt = src.indexOf("<", pos);
    const textEnd = lt === -1 ? src.length : lt;
    if (textEnd > pos) {
      const raw = src.slice(pos, textEnd);
      const top = stack[stack.length - 1];
      if (top === root) {
        if (raw.trim()) throw new CxmlError("malformed_xml", "Text outside the root element.");
      } else {
        top.text += decodeEntities(raw);
      }
    }
    if (lt === -1) break;
    pos = lt;

    if (src.startsWith("<?", pos)) {
      const end = src.indexOf("?>", pos + 2);
      if (end === -1) throw new CxmlError("malformed_xml", "Unclosed processing instruction.");
      pos = end + 2;
      continue;
    }
    if (src.startsWith("<!--", pos)) {
      const end = src.indexOf("-->", pos + 4);
      if (end === -1) throw new CxmlError("malformed_xml", "Unclosed comment.");
      pos = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", pos)) {
      const end = src.indexOf("]]>", pos + 9);
      if (end === -1) throw new CxmlError("malformed_xml", "Unclosed CDATA section.");
      const top = stack[stack.length - 1];
      if (top === root) throw new CxmlError("malformed_xml", "CDATA outside the root element.");
      top.text += src.slice(pos + 9, end);
      pos = end + 3;
      continue;
    }
    if (src.startsWith("<!DOCTYPE", pos)) {
      const end = src.indexOf(">", pos);
      const decl = end === -1 ? "" : src.slice(pos, end + 1);
      if (sawDoctype || sawRoot || decl.includes("[") || !STANDARD_DOCTYPE.test(decl)) {
        throw new CxmlError("dtd_forbidden", "Only the standard external cXML DOCTYPE is accepted (never loaded).");
      }
      sawDoctype = true;
      pos = end + 1;
      continue;
    }
    if (src.startsWith("<!", pos)) {
      throw new CxmlError("dtd_forbidden", "Markup declarations (<!ENTITY>, <!ELEMENT>, ...) are not accepted.");
    }
    if (src.startsWith("</", pos)) {
      const m = NAME.exec(src.slice(pos + 2, pos + 2 + 200));
      if (!m) throw new CxmlError("malformed_xml", "Bad closing tag.");
      const close = src.indexOf(">", pos);
      if (close === -1 || src.slice(pos + 2 + m[0].length, close).trim()) {
        throw new CxmlError("malformed_xml", "Bad closing tag.");
      }
      const top = stack.pop();
      if (!top || top === root || top.name !== m[0]) {
        throw new CxmlError("malformed_xml", `Mismatched closing tag </${m[0]}>.`);
      }
      pos = close + 1;
      continue;
    }

    // Opening tag
    const m = NAME.exec(src.slice(pos + 1, pos + 1 + 200));
    if (!m) throw new CxmlError("malformed_xml", "Bad element name.");
    const node: XmlNode = { name: m[0], attrs: {}, children: [], text: "" };
    if (++nodes > MAX_NODES) throw new CxmlError("too_large", "Too many XML elements.");
    let i = pos + 1 + m[0].length;
    let selfClosing = false;
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (i >= src.length) throw new CxmlError("malformed_xml", "Unclosed tag.");
      if (src[i] === ">") { i++; break; }
      if (src.startsWith("/>", i)) { selfClosing = true; i += 2; break; }
      const an = NAME.exec(src.slice(i, i + 200));
      if (!an) throw new CxmlError("malformed_xml", "Bad attribute name.");
      i += an[0].length;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] !== "=") throw new CxmlError("malformed_xml", "Attribute without a value.");
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      const q = src[i];
      if (q !== '"' && q !== "'") throw new CxmlError("malformed_xml", "Unquoted attribute value.");
      const vEnd = src.indexOf(q, i + 1);
      if (vEnd === -1) throw new CxmlError("malformed_xml", "Unclosed attribute value.");
      const rawValue = src.slice(i + 1, vEnd);
      if (rawValue.includes("<")) throw new CxmlError("malformed_xml", "'<' in an attribute value.");
      if (Object.prototype.hasOwnProperty.call(node.attrs, an[0])) throw new CxmlError("malformed_xml", "Duplicate attribute.");
      node.attrs[an[0]] = decodeEntities(rawValue);
      i = vEnd + 1;
    }
    const parent = stack[stack.length - 1];
    if (parent === root) {
      if (sawRoot) throw new CxmlError("malformed_xml", "More than one root element.");
      sawRoot = true;
    }
    parent.children.push(node);
    if (!selfClosing) {
      stack.push(node);
      if (stack.length - 1 > MAX_DEPTH) throw new CxmlError("too_large", "XML nested too deeply.");
    }
    pos = i;
  }
  if (stack.length !== 1) throw new CxmlError("malformed_xml", "Unclosed element.");
  const top = root.children[0];
  if (!top) throw new CxmlError("malformed_xml", "No root element.");
  return top;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}
export function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}
export function at(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let cur = node;
  for (const p of path) cur = child(cur, p);
  return cur;
}
/** Text of a node and all descendants, whitespace collapsed. */
export function deepText(node: XmlNode | undefined): string {
  if (!node) return "";
  const parts: string[] = [node.text];
  for (const c of node.children) parts.push(deepText(c));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function ownText(node: XmlNode | undefined): string {
  return (node?.text ?? "").replace(/\s+/g, " ").trim();
}

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

// ---------------------------------------------------------------------------
// Decimal-safe money and quantity (scaled BigInt)
// ---------------------------------------------------------------------------
// BigInt() calls instead of literals: the project tsconfig targets below ES2020.
const B0 = BigInt(0);
const B10 = BigInt(10);
const B1000 = BigInt(1000);
const MONEY_RE = /^\d{1,12}(\.\d{1,4})?$/;
const QTY_RE = /^\d{1,6}(\.\d{1,3})?$/;
const UOM_RE = /^[A-Z0-9]{1,3}$/;

function scaled(s: string, dp: number): bigint {
  const [int, frac = ""] = s.split(".");
  return BigInt(int) * B10 ** BigInt(dp) + BigInt((frac + "0".repeat(dp)).slice(0, dp) || "0");
}
function unscaled(v: bigint, dp: number, minDp: number): string {
  const neg = v < B0;
  const abs = neg ? -v : v;
  const base = B10 ** BigInt(dp);
  let frac = (abs % base).toString().padStart(dp, "0");
  while (frac.length > minDp && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${neg ? "-" : ""}${abs / base}${frac ? "." + frac : ""}`;
}

/** Validate and normalize a money amount (>= 0, up to 4 decimals). */
export function normalizeMoney(raw: string): string {
  const s = raw.trim();
  if (!MONEY_RE.test(s)) throw new CxmlError("invalid_money", `Invalid money amount '${s.slice(0, 32)}'.`);
  return unscaled(scaled(s, 4), 4, 2);
}
export function normalizeQuantity(raw: string): string {
  const s = raw.trim();
  if (!QTY_RE.test(s) || scaled(s, 3) <= B0) throw new CxmlError("invalid_quantity", `Invalid quantity '${s.slice(0, 32)}'.`);
  return unscaled(scaled(s, 3), 3, 0);
}
export function normalizeCurrency(raw: string | undefined): string {
  const c = (raw ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new CxmlError("invalid_currency", "Missing or invalid currency code.");
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(c)) {
    throw new CxmlError("unsupported_currency", `Currency ${c} is not supported.`);
  }
  return c;
}
export function normalizeUom(raw: string): string {
  const u = raw.trim().toUpperCase();
  if (!UOM_RE.test(u)) throw new CxmlError("invalid_uom", `Invalid unit of measure '${raw.trim().slice(0, 16)}'.`);
  return u;
}

/** quantity x unit price, as a money string (4 dp, trimmed to >= 2). */
export function extendedPrice(quantity: string, unitPrice: string): string {
  return unscaled((scaled(quantity, 3) * scaled(unitPrice, 4)) / B1000, 4, 2);
}
/** Sum money strings per currency. */
export function totalsByCurrency(lines: { quantity: string; unitPrice: string; currency: string }[]): Record<string, string> {
  const sums = new Map<string, bigint>();
  for (const l of lines) {
    const ext = (scaled(l.quantity, 3) * scaled(l.unitPrice, 4)) / B1000;
    sums.set(l.currency, (sums.get(l.currency) ?? B0) + ext);
  }
  const out: Record<string, string> = {};
  for (const [cur, v] of [...sums.entries()].sort(([a], [b]) => a.localeCompare(b))) out[cur] = unscaled(v, 4, 2);
  return out;
}
export function moneyEquals(a: string, b: string): boolean {
  return scaled(a, 4) === scaled(b, 4);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
export interface Credential {
  domain: string;
  identity: string;
}
export interface SenderCredential extends Credential {
  sharedSecret: string;
}
export interface Money {
  amount: string;
  currency: string;
}
export type DeploymentMode = "test" | "production";

const DOCTYPE_LINE = `<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/${CXML_DTD_VERSION}/cXML.dtd">`;

function credentialXml(c: Credential, secret?: string): string {
  return `<Credential domain="${xmlEscape(c.domain)}"><Identity>${xmlEscape(c.identity)}</Identity>${
    secret !== undefined ? `<SharedSecret>${xmlEscape(secret)}</SharedSecret>` : ""
  }</Credential>`;
}
function headerXml(from: Credential, to: Credential, sender: SenderCredential, userAgent: string): string {
  return `<Header><From>${credentialXml(from)}</From><To>${credentialXml(to)}</To><Sender>${credentialXml(
    sender,
    sender.sharedSecret,
  )}<UserAgent>${xmlEscape(userAgent)}</UserAgent></Sender></Header>`;
}
function envelope(payloadId: string, timestamp: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${DOCTYPE_LINE}\n<cXML payloadID="${xmlEscape(payloadId)}" timestamp="${xmlEscape(
    timestamp,
  )}" xml:lang="en-US">${body}</cXML>`;
}

export interface SetupRequestInput {
  payloadId: string;
  timestamp: string;
  from: Credential;
  to: Credential;
  sender: SenderCredential;
  userAgent: string;
  buyerCookie: string;
  browserFormPostUrl: string;
  supplierSetupUrl: string;
  deploymentMode: DeploymentMode;
  operation?: "create";
}

export function buildSetupRequest(i: SetupRequestInput): string {
  return envelope(
    i.payloadId,
    i.timestamp,
    headerXml(i.from, i.to, i.sender, i.userAgent) +
      `<Request deploymentMode="${i.deploymentMode}"><PunchOutSetupRequest operation="${i.operation ?? "create"}">` +
      `<BuyerCookie>${xmlEscape(i.buyerCookie)}</BuyerCookie>` +
      `<BrowserFormPost><URL>${xmlEscape(i.browserFormPostUrl)}</URL></BrowserFormPost>` +
      `<SupplierSetup><URL>${xmlEscape(i.supplierSetupUrl)}</URL></SupplierSetup>` +
      `</PunchOutSetupRequest></Request>`,
  );
}

function readCredential(node: XmlNode | undefined, withSecret: boolean): SenderCredential {
  const cred = child(node, "Credential");
  if (!cred) throw new CxmlError("missing_credential", "Missing Credential.");
  return {
    domain: cred.attrs.domain ?? "",
    identity: ownText(child(cred, "Identity")),
    sharedSecret: withSecret ? ownText(child(cred, "SharedSecret")) : "",
  };
}

export interface ParsedSetupRequest {
  payloadId: string;
  from: Credential;
  to: Credential;
  sender: SenderCredential;
  buyerCookie: string;
  browserFormPostUrl: string;
  operation: string;
  deploymentMode: string;
}

export function parseSetupRequest(xml: string): ParsedSetupRequest {
  const doc = parseXml(xml);
  if (doc.name !== "cXML") throw new CxmlError("not_cxml", "Root element is not cXML.");
  const header = child(doc, "Header");
  const request = child(doc, "Request");
  const setup = child(request, "PunchOutSetupRequest");
  if (!header || !setup) throw new CxmlError("not_setup_request", "Not a PunchOutSetupRequest.");
  const buyerCookie = ownText(child(setup, "BuyerCookie"));
  const browserFormPostUrl = ownText(at(setup, "BrowserFormPost", "URL"));
  if (!buyerCookie || !browserFormPostUrl) throw new CxmlError("not_setup_request", "Missing BuyerCookie or BrowserFormPost.");
  return {
    payloadId: doc.attrs.payloadID ?? "",
    from: readCredential(child(header, "From"), false),
    to: readCredential(child(header, "To"), false),
    sender: readCredential(child(header, "Sender"), true),
    buyerCookie,
    browserFormPostUrl,
    operation: setup.attrs.operation ?? "create",
    deploymentMode: request?.attrs.deploymentMode ?? "production",
  };
}

export function buildStatusResponse(payloadId: string, timestamp: string, code: number, text: string, startPageUrl?: string): string {
  return envelope(
    payloadId,
    timestamp,
    `<Response><Status code="${code}" text="${xmlEscape(text)}"/>${
      startPageUrl ? `<PunchOutSetupResponse><StartPage><URL>${xmlEscape(startPageUrl)}</URL></StartPage></PunchOutSetupResponse>` : ""
    }</Response>`,
  );
}

/** Read the supplier's PunchOutSetupResponse; returns the StartPage URL (not yet host-checked). */
export function parseSetupResponse(xml: string): { startPageUrl: string } {
  const doc = parseXml(xml);
  if (doc.name !== "cXML") throw new CxmlError("not_cxml", "Root element is not cXML.");
  const response = child(doc, "Response");
  const status = child(response, "Status");
  const code = status?.attrs.code ?? "";
  if (code !== "200") {
    throw new CxmlError("supplier_refused", `Supplier answered status ${code.slice(0, 8) || "missing"}${status?.attrs.text ? ` (${status.attrs.text.slice(0, 80)})` : ""}.`);
  }
  const url = ownText(at(response, "PunchOutSetupResponse", "StartPage", "URL"));
  if (!url) throw new CxmlError("missing_start_page", "Supplier response has no StartPage URL.");
  return { startPageUrl: url };
}

export interface OrderLine {
  supplierPartId: string;
  supplierPartAuxId: string | null;
  description: string;
  quantity: string;
  uom: string;
  unitPrice: string;
  currency: string;
  classificationDomain: string | null;
  classification: string | null;
  manufacturerPartId: string | null;
  manufacturerName: string | null;
}
export interface OrderMessage {
  payloadId: string | null;
  buyerCookie: string;
  operationAllowed: "create" | "inspect" | "edit" | null;
  deploymentMode: string;
  total: Money | null;
  shipping: Money | null;
  tax: Money | null;
  lines: OrderLine[];
}

function readMoney(node: XmlNode | undefined): Money | null {
  const money = child(node, "Money");
  if (!money) return null;
  return { amount: normalizeMoney(ownText(money)), currency: normalizeCurrency(money.attrs.currency) };
}
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}
function optional(s: string, n: number): string | null {
  const t = s.trim();
  return t ? clip(t, n) : null;
}

/** Parse and validate a PunchOutOrderMessage. Zero ItemIn lines = the shopper cancelled. */
export function parseOrderMessage(xml: string): OrderMessage {
  const doc = parseXml(xml);
  if (doc.name !== "cXML") throw new CxmlError("not_cxml", "Root element is not cXML.");
  const message = child(doc, "Message");
  const pom = child(message, "PunchOutOrderMessage");
  if (!pom) throw new CxmlError("not_order_message", "Not a PunchOutOrderMessage.");
  const buyerCookie = ownText(child(pom, "BuyerCookie"));
  if (!buyerCookie) throw new CxmlError("missing_buyer_cookie", "Missing BuyerCookie.");
  const header = child(pom, "PunchOutOrderMessageHeader");
  const op = header?.attrs.operationAllowed ?? null;
  if (op !== null && !["create", "inspect", "edit"].includes(op)) {
    throw new CxmlError("invalid_operation", "Unknown operationAllowed.");
  }
  const items = childrenNamed(pom, "ItemIn");
  if (items.length > MAX_CART_LINES) throw new CxmlError("too_many_lines", `More than ${MAX_CART_LINES} cart lines.`);
  const lines: OrderLine[] = items.map((item, idx) => {
    const itemId = child(item, "ItemID");
    const detail = child(item, "ItemDetail");
    const partId = ownText(child(itemId, "SupplierPartID"));
    if (!partId) throw new CxmlError("missing_part_id", `Line ${idx + 1} has no SupplierPartID.`);
    if (partId.length > 256) throw new CxmlError("invalid_part_id", `Line ${idx + 1} SupplierPartID is too long.`);
    const unit = child(detail, "UnitPrice");
    const money = child(unit, "Money");
    if (!money) throw new CxmlError("invalid_money", `Line ${idx + 1} has no unit price.`);
    const uomText = ownText(child(detail, "UnitOfMeasure"));
    if (!uomText) throw new CxmlError("invalid_uom", `Line ${idx + 1} has no unit of measure.`);
    const classification = child(detail, "Classification");
    const manufacturerName = child(detail, "ManufacturerName");
    return {
      supplierPartId: partId,
      supplierPartAuxId: optional(ownText(child(itemId, "SupplierPartAuxiliaryID")), 1024),
      description: clip(deepText(child(detail, "Description")), 2000),
      quantity: normalizeQuantity(item.attrs.quantity ?? ""),
      uom: normalizeUom(uomText),
      unitPrice: normalizeMoney(ownText(money)),
      currency: normalizeCurrency(money.attrs.currency),
      classificationDomain: classification ? optional(classification.attrs.domain ?? "", 64) : null,
      classification: classification ? optional(ownText(classification), 64) : null,
      manufacturerPartId: optional(ownText(child(detail, "ManufacturerPartID")), 256),
      manufacturerName: manufacturerName ? optional(ownText(manufacturerName), 256) : null,
    };
  });
  return {
    payloadId: doc.attrs.payloadID ? clip(doc.attrs.payloadID, 256) : null,
    buyerCookie,
    operationAllowed: op as OrderMessage["operationAllowed"],
    deploymentMode: message?.attrs.deploymentMode ?? "production",
    total: readMoney(child(header, "Total")),
    shipping: readMoney(child(header, "Shipping")),
    tax: readMoney(child(header, "Tax")),
    lines,
  };
}

export interface OrderMessageInput {
  payloadId: string;
  timestamp: string;
  from: Credential;
  to: Credential;
  sender: SenderCredential;
  userAgent: string;
  buyerCookie: string;
  deploymentMode: DeploymentMode;
  operationAllowed: "create" | "inspect" | "edit";
  lines: {
    supplierPartId: string;
    supplierPartAuxId?: string | null;
    description: string;
    quantity: string;
    uom: string;
    unitPrice: string;
    currency: string;
    classificationDomain?: string;
    classification?: string;
  }[];
}

/** Build a PunchOutOrderMessage (used by the synthetic test supplier). */
export function buildOrderMessage(i: OrderMessageInput): string {
  const totals = totalsByCurrency(i.lines);
  const currencies = Object.keys(totals);
  const totalXml =
    currencies.length === 1
      ? `<Total><Money currency="${currencies[0]}">${totals[currencies[0]]}</Money></Total>`
      : "";
  const items = i.lines
    .map(
      (l) =>
        `<ItemIn quantity="${xmlEscape(l.quantity)}"><ItemID><SupplierPartID>${xmlEscape(l.supplierPartId)}</SupplierPartID>${
          l.supplierPartAuxId ? `<SupplierPartAuxiliaryID>${xmlEscape(l.supplierPartAuxId)}</SupplierPartAuxiliaryID>` : ""
        }</ItemID><ItemDetail><UnitPrice><Money currency="${xmlEscape(l.currency)}">${xmlEscape(l.unitPrice)}</Money></UnitPrice>` +
        `<Description xml:lang="en">${xmlEscape(l.description)}</Description><UnitOfMeasure>${xmlEscape(l.uom)}</UnitOfMeasure>` +
        (l.classification
          ? `<Classification domain="${xmlEscape(l.classificationDomain ?? "UNSPSC")}">${xmlEscape(l.classification)}</Classification>`
          : "") +
        `</ItemDetail></ItemIn>`,
    )
    .join("");
  return envelope(
    i.payloadId,
    i.timestamp,
    headerXml(i.from, i.to, i.sender, i.userAgent) +
      `<Message deploymentMode="${i.deploymentMode}"><PunchOutOrderMessage><BuyerCookie>${xmlEscape(i.buyerCookie)}</BuyerCookie>` +
      `<PunchOutOrderMessageHeader operationAllowed="${i.operationAllowed}">${totalXml}</PunchOutOrderMessageHeader>${items}` +
      `</PunchOutOrderMessage></Message>`,
  );
}
