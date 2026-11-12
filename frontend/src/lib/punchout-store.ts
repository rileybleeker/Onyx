// Supabase-backed PunchOut store and the /procurement/shop data loader. Server only: service role,
// explicit column lists, owner-scoped reads. The browser never touches the punchout tables.
import { procurementDb } from "./procurement-db";
import { extendedPrice, moneyEquals, totalsByCurrency } from "./cxml";
import {
  OWNER_USER_ID,
  parseSupplierRegistry,
  supplierCards,
  testSupplierConfig,
  testSupplierSecret,
  type PunchoutStore,
  type ReturnOutcome,
  type SessionRow,
  type SupplierCard,
  type SupplierConfig,
} from "./punchout";

export function supabaseStore(): PunchoutStore {
  const db = procurementDb();
  return {
    async createSession(row) {
      const { error } = await db.from("procurement_punchout_sessions").insert(row);
      if (error) throw new Error(`punchout_session_insert:${error.code ?? "unknown"}`);
    },
    async getSession(sessionId) {
      const { data, error } = await db
        .from("procurement_punchout_sessions")
        .select("session_id,secret_hash,buyer_cookie,supplier_key,source,owner_id,status,expires_at")
        .eq("session_id", sessionId)
        .maybeSingle();
      if (error) throw new Error(`punchout_session_read:${error.code ?? "unknown"}`);
      return (data as SessionRow | null) ?? null;
    },
    async markFailed(sessionId, code) {
      await db
        .from("procurement_punchout_sessions")
        .update({ status: "failed", error_code: code.slice(0, 64) })
        .eq("session_id", sessionId)
        .eq("status", "started");
    },
    async recordReturn(sessionId, payloadHash, cart, lines) {
      const { data, error } = await db.rpc("procurement_punchout_record_return", {
        p_session_id: sessionId,
        p_payload_hash: payloadHash,
        p_cart: cart,
        p_lines: lines,
      });
      if (error) throw new Error(`punchout_record_return:${error.code ?? "unknown"}`);
      const r = (data ?? {}) as { outcome?: ReturnOutcome; cart_id?: number | null };
      return { outcome: r.outcome ?? "unknown", cart_id: r.cart_id ?? null };
    },
  };
}

/** Every supplier Onyx can punch out to right now: the synthetic test supplier plus PUNCHOUT_SUPPLIERS. */
export function loadSuppliers(origin: string): { suppliers: SupplierConfig[]; errors: string[] } {
  const reg = parseSupplierRegistry(process.env.PUNCHOUT_SUPPLIERS);
  const secret = testSupplierSecret(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const suppliers = secret ? [testSupplierConfig(origin, secret), ...reg.suppliers] : reg.suppliers;
  return { suppliers, errors: reg.errors };
}

export interface CartLineView {
  lineNo: number;
  supplierPartId: string;
  supplierPartAuxId: string | null;
  description: string;
  quantity: string;
  uom: string;
  unitPrice: string;
  currency: string;
  extended: string;
  classification: string | null;
}
export interface CartView {
  cartId: number;
  supplierKey: string;
  source: "cxml" | "synthetic";
  sessionId: string;
  payloadId: string | null;
  operationAllowed: string | null;
  returnedAt: string;
  lines: CartLineView[];
  totals: Record<string, string>;
  supplierTotal: { amount: string; currency: string; matches: boolean | null } | null;
  shipping: { amount: string; currency: string } | null;
  tax: { amount: string; currency: string } | null;
}
export type ShopLoad =
  | { state: "ok"; carts: CartView[]; suppliers: SupplierCard[]; registryErrors: string[] }
  | { state: "error"; code: string; suppliers: SupplierCard[]; registryErrors: string[] };

function num(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

export async function loadShop(origin: string, limit = 15): Promise<ShopLoad> {
  const { suppliers, errors } = loadSuppliers(origin);
  const cards = supplierCards(suppliers);
  try {
    const db = procurementDb();
    const { data: carts, error } = await db
      .from("procurement_punchout_carts")
      .select("cart_id,session_id,supplier_key,source,payload_id,operation_allowed,supplier_total,total_currency,shipping,shipping_currency,tax,tax_currency,returned_at,status")
      .eq("owner_id", OWNER_USER_ID)
      .neq("status", "discarded")
      .order("returned_at", { ascending: false })
      .order("cart_id", { ascending: false })
      .limit(limit);
    if (error) return { state: "error", code: error.code ?? "carts", suppliers: cards, registryErrors: errors };
    const ids = (carts ?? []).map((c) => c.cart_id as number);
    const linesByCart = new Map<number, CartLineView[]>();
    if (ids.length) {
      const { data: lines, error: lerr } = await db
        .from("procurement_punchout_cart_lines")
        .select("cart_id,line_no,supplier_part_id,supplier_part_aux_id,description,quantity,uom,unit_price,currency,classification")
        .in("cart_id", ids)
        .order("cart_id", { ascending: true })
        .order("line_no", { ascending: true })
        .limit(5000);
      if (lerr) return { state: "error", code: lerr.code ?? "lines", suppliers: cards, registryErrors: errors };
      for (const l of lines ?? []) {
        const quantity = String(l.quantity);
        const unitPrice = String(l.unit_price);
        const view: CartLineView = {
          lineNo: l.line_no as number,
          supplierPartId: l.supplier_part_id as string,
          supplierPartAuxId: (l.supplier_part_aux_id as string | null) ?? null,
          description: l.description as string,
          quantity,
          uom: l.uom as string,
          unitPrice,
          currency: l.currency as string,
          extended: extendedPrice(quantity, unitPrice),
          classification: (l.classification as string | null) ?? null,
        };
        const list = linesByCart.get(l.cart_id as number) ?? [];
        list.push(view);
        linesByCart.set(l.cart_id as number, list);
      }
    }
    const views: CartView[] = (carts ?? []).map((c) => {
      const lines = linesByCart.get(c.cart_id as number) ?? [];
      const totals = totalsByCurrency(lines);
      const st = num(c.supplier_total);
      const stc = (c.total_currency as string | null) ?? null;
      return {
        cartId: c.cart_id as number,
        supplierKey: c.supplier_key as string,
        source: c.source as "cxml" | "synthetic",
        sessionId: c.session_id as string,
        payloadId: (c.payload_id as string | null) ?? null,
        operationAllowed: (c.operation_allowed as string | null) ?? null,
        returnedAt: c.returned_at as string,
        lines,
        totals,
        supplierTotal: st && stc ? { amount: st, currency: stc, matches: totals[stc] !== undefined ? moneyEquals(totals[stc], st) : null } : null,
        shipping: num(c.shipping) && c.shipping_currency ? { amount: num(c.shipping)!, currency: c.shipping_currency as string } : null,
        tax: num(c.tax) && c.tax_currency ? { amount: num(c.tax)!, currency: c.tax_currency as string } : null,
      };
    });
    return { state: "ok", carts: views, suppliers: cards, registryErrors: errors };
  } catch {
    return { state: "error", code: "unavailable", suppliers: cards, registryErrors: errors };
  }
}
