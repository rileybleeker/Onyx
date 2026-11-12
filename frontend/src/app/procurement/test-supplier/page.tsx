import type { Metadata } from "next";
import Link from "next/link";
import { TEST_CATALOG, TEST_SUPPLIER_NAME, testSupplierSecret, verifyBlob } from "@/lib/punchout";

// The synthetic test supplier's StartPage: a tiny catalog hosted inside Onyx. Not a merchant.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Test supplier (synthetic) - Onyx", robots: { index: false, follow: false } };

const card = "rounded-xl border border-border-subtle bg-surface-card p-5 space-y-4";
const button = "rounded border border-border-subtle px-3 py-2 text-sm hover:bg-white/5";

export default async function TestSupplierPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const s = typeof sp.s === "string" ? sp.s : null;
  const secret = testSupplierSecret(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const session = secret ? verifyBlob(s, secret, new Date()) : null;
  return (
    <main className="max-w-3xl mx-auto p-4 md:p-8 space-y-6">
      <header className="rounded border border-amber-400/40 bg-amber-400/10 p-3 text-sm">
        <strong>{TEST_SUPPLIER_NAME}.</strong> A pretend store inside Onyx that exercises cXML PunchOut. Not a real merchant: nothing can be
        bought here.
      </header>
      {!session ? (
        <section className={card}>
          <h1 className="text-xl font-semibold">Session not valid</h1>
          <p className="text-sm text-text-secondary">
            This test-supplier link is invalid or expired. Start a new session from{" "}
            <Link className="underline" href="/procurement/shop">
              Shop
            </Link>
            .
          </p>
        </section>
      ) : (
        <form className={card} method="post" action="/api/procurement/punchout/test-supplier/checkout">
          <h1 className="text-xl font-semibold">Catalog</h1>
          <input type="hidden" name="s" value={s ?? ""} />
          <table className="w-full text-sm">
            <thead className="text-left text-text-tertiary">
              <tr>
                <th className="py-1">Item</th>
                <th>Part</th>
                <th>UOM</th>
                <th className="text-right">Price</th>
                <th className="text-right">Qty</th>
              </tr>
            </thead>
            <tbody>
              {TEST_CATALOG.map((item) => (
                <tr key={item.partId} className="border-t border-border-subtle">
                  <td className="py-2 pr-2">{item.description}</td>
                  <td className="pr-2 font-mono text-xs">{item.partId}</td>
                  <td className="pr-2">{item.uom}</td>
                  <td className="pr-2 text-right">USD {item.unitPrice}</td>
                  <td className="text-right">
                    <input
                      aria-label={`Quantity of ${item.description}`}
                      className="w-16 rounded border border-border-subtle bg-transparent p-1 text-right"
                      type="number"
                      name={`qty_${item.partId}`}
                      min={0}
                      max={99}
                      step={1}
                      defaultValue={0}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap gap-3">
            <button className={button} type="submit" name="action" value="return">
              Return cart to Onyx
            </button>
            <button className={button} type="submit" name="action" value="cancel">
              Cancel and return an empty cart
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
