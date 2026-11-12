import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { loadShop, type CartView } from "@/lib/punchout-store";
import ShopClient from "./ShopClient";

// PunchOut shop (2026-11-11). Private data: never ISR, never cached, not indexed.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shop (PunchOut) - Onyx", robots: { index: false, follow: false } };

const card = "rounded-xl border border-border-subtle bg-surface-card p-5 space-y-3";
const et = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });

async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function Cart({ cart, highlight }: { cart: CartView; highlight: boolean }) {
  const currencies = Object.keys(cart.totals);
  return (
    <article className={`${card} ${highlight ? "ring-1 ring-cyan-400/60" : ""}`} aria-label={`Returned cart ${cart.cartId}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold">
          {cart.source === "synthetic" ? "Test supplier (synthetic)" : cart.supplierKey} · cart {cart.cartId}
        </h3>
        <p className="text-xs text-text-tertiary">Returned {et.format(new Date(cart.returnedAt))} ET</p>
      </header>
      <p className="text-xs text-text-secondary">
        Provenance: {cart.source === "synthetic" ? "synthetic test supplier, real cXML PunchOutOrderMessage" : "supplier cXML PunchOutOrderMessage"} · session{" "}
        {cart.sessionId.slice(0, 8)}
        {cart.payloadId ? ` · payload ${cart.payloadId.slice(0, 40)}` : ""}
        {cart.operationAllowed ? ` · supplier allows: ${cart.operationAllowed}` : ""}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-text-tertiary">
            <tr>
              <th className="py-1 pr-3">Item</th>
              <th className="pr-3">Part / variant</th>
              <th className="pr-3 text-right">Qty</th>
              <th className="pr-3">UOM</th>
              <th className="pr-3 text-right">Unit price</th>
              <th className="text-right">Line total</th>
            </tr>
          </thead>
          <tbody>
            {cart.lines.map((l) => (
              <tr key={l.lineNo} className="border-t border-border-subtle">
                <td className="py-1 pr-3">{l.description || <span className="text-text-tertiary">No description supplied</span>}</td>
                <td className="pr-3 font-mono text-xs">
                  {l.supplierPartId}
                  {l.supplierPartAuxId ? ` / ${l.supplierPartAuxId}` : ""}
                </td>
                <td className="pr-3 text-right">{l.quantity}</td>
                <td className="pr-3">{l.uom}</td>
                <td className="pr-3 text-right">
                  {l.currency} {l.unitPrice}
                </td>
                <td className="text-right">
                  {l.currency} {l.extended}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <div>
          <dt className="text-text-tertiary">Items total</dt>
          <dd>{currencies.map((c) => `${c} ${cart.totals[c]}`).join(" + ") || "none"}</dd>
        </div>
        <div>
          <dt className="text-text-tertiary">Supplier&apos;s total</dt>
          <dd>
            {cart.supplierTotal
              ? `${cart.supplierTotal.currency} ${cart.supplierTotal.amount}${cart.supplierTotal.matches === false ? " (does not match the lines)" : ""}`
              : "not supplied"}
          </dd>
        </div>
        <div>
          <dt className="text-text-tertiary">Shipping</dt>
          <dd>{cart.shipping ? `${cart.shipping.currency} ${cart.shipping.amount}` : "unknown (not supplied)"}</dd>
        </div>
        <div>
          <dt className="text-text-tertiary">Tax</dt>
          <dd>{cart.tax ? `${cart.tax.currency} ${cart.tax.amount}` : "unknown (not supplied)"}</dd>
        </div>
      </dl>
      <p className="text-xs text-text-tertiary">A returned cart is a price snapshot, not an order. Nothing was bought; purchase orders are not built in Onyx.</p>
    </article>
  );
}

export default async function ShopPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const highlight = typeof sp.cart === "string" && /^\d{1,12}$/.test(sp.cart) ? Number(sp.cart) : null;
  const cancelled = sp.cancelled === "1";
  const data = await loadShop(await requestOrigin());
  const hasAmazonBusiness = data.suppliers.some((s) => s.key.includes("amazon"));
  return (
    <main className="max-w-5xl mx-auto p-4 md:p-8 space-y-6">
      <header>
        <p className="text-xs uppercase tracking-widest text-text-tertiary">
          <Link href="/procurement" className="hover:underline">
            Procurement
          </Link>{" "}
          / Shop
        </p>
        <h1 className="text-3xl font-semibold mt-2">Shop with PunchOut</h1>
        <p className="text-text-secondary mt-2">
          Start a session, shop on the supplier&apos;s own site, and the supplier sends the cart back here as a structured cXML message: parts,
          quantities, units and prices, with nothing retyped. Each session returns one new cart.
        </p>
      </header>
      {highlight !== null && (
        <p role="status" className="rounded border border-cyan-400/40 bg-cyan-400/10 p-3 text-sm">
          Cart {highlight} came back from the supplier and is saved below.
        </p>
      )}
      {cancelled && (
        <p role="status" className="rounded border border-border-subtle p-3 text-sm">
          Shopping was cancelled at the supplier. No cart was saved.
        </p>
      )}

      <section className="space-y-3" aria-label="Suppliers">
        <h2 className="text-xl font-semibold">Suppliers</h2>
        <ShopClient suppliers={data.suppliers} />
        {!hasAmazonBusiness && (
          <div className={card}>
            <h3 className="font-semibold">
              Amazon Business <span className="ml-2 text-xs rounded bg-amber-500/20 px-2 py-0.5">Set up connection</span>
            </h3>
            <p className="text-sm text-text-secondary">
              Not connected. Amazon Business supports cXML PunchOut, configured by an account admin in Amazon Business &gt; Business Settings &gt;
              System Integrations &gt; Configure purchasing system. Missing, all from that screen:
            </p>
            <ul className="list-disc pl-5 text-sm text-text-secondary">
              <li>the From, To and Sender identities (domain and identity) Amazon assigns to Onyx</li>
              <li>the Sender shared secret</li>
              <li>the PunchOut setup URL (test mode first) and the StartPage host</li>
            </ul>
            <p className="text-xs text-text-tertiary">
              They go into the server setting PUNCHOUT_SUPPLIERS (Vercel), never into the browser or the repo. Amazon Business is a separate account
              product from a personal Amazon account.
            </p>
          </div>
        )}
        <div className={card}>
          <h3 className="font-semibold">
            Amazon (personal account) <span className="ml-2 text-xs rounded bg-white/10 px-2 py-0.5">Not available</span>
          </h3>
          <p className="text-sm text-text-secondary">
            Amazon offers no PunchOut or cart API for consumer accounts. The candidate ways to bring a personal cart back (a cart-capture browser
            bridge, or a cart-sharing provider) need Riley&apos;s choice and an access review first. Nothing is connected.
          </p>
        </div>
        {data.registryErrors.length > 0 && (
          <p className="text-xs text-amber-300">Supplier settings with problems (fix PUNCHOUT_SUPPLIERS): {data.registryErrors.join("; ")}</p>
        )}
      </section>

      <section className="space-y-3" aria-label="Returned carts">
        <h2 className="text-xl font-semibold">Returned carts</h2>
        {data.state === "error" ? (
          <p className="text-sm text-red-300">Returned carts could not be loaded right now ({data.code}). Saved carts are not lost; reload in a minute.</p>
        ) : data.carts.length === 0 ? (
          <p className="text-sm text-text-secondary">No carts yet. Start a session with a supplier above.</p>
        ) : (
          data.carts.map((c) => <Cart key={c.cartId} cart={c} highlight={c.cartId === highlight} />)
        )}
      </section>
    </main>
  );
}
