import type { Metadata } from "next";
import { loadLedger } from "@/lib/finance-ledger-server";
import { parseLedgerQuery } from "@/lib/finance-ledger";
import FinancialsClient from "./FinancialsClient";
import LedgerView, { FreshnessLine } from "./LedgerView";

// Private financial data: rendered per request on the server, never ISR, never cached by the
// CDN, and never fetched from the browser (the pds.finance_* tables are service-role only; the
// middleware lets only the owner reach this route). This deliberately does NOT follow the
// hourly-ISR pattern of the other dashboards.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Financials - Onyx",
  robots: { index: false, follow: false },
};

export default async function FinancialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const now = new Date();
  const load = await loadLedger(parseLedgerQuery(await searchParams), now);

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-text-tertiary">Money, in view</p>
        <h1 data-testid="page-heading" className="text-2xl font-semibold">Financials</h1>
        <p className="mt-2 text-text-secondary">
          Your bank accounts, balances and transactions, imported automatically (SimpleFIN Bridge, every 6 hours; Rocket Money history before 2026-11-14) and shown only to you.
        </p>
      </header>

      {load.kind === "error" && (
        <section role="alert" className="rounded-[4px] border border-red-500/30 bg-red-500/5 p-4">
          <h2 className="font-semibold text-red-300">{load.message}</h2>
          {load.hint && <p className="mt-1 text-[13px] text-text-secondary">{load.hint}</p>}
          <p className="mt-1 text-[12px] text-text-tertiary">This is a failed query, not an empty ledger.</p>
        </section>
      )}

      {load.kind === "empty" && (
        <section className="rounded-[4px] border border-border-subtle bg-surface-card p-4">
          <p className="font-semibold">
            {load.freshness
              ? "No ledger data yet - the harvester has run but imported nothing."
              : "No ledger data yet - the harvester has not run."}
          </p>
          <p className="mt-2 text-[13px] text-text-secondary">
            Accounts, balances and transactions appear here after the first SimpleFIN import. No sample or invented numbers are shown.
          </p>
          <div className="mt-3">
            <FreshnessLine freshness={load.freshness} now={now} />
          </div>
        </section>
      )}

      {load.kind === "ok" && <LedgerView data={load.data} now={now} />}

      <details className="rounded-[4px] border border-border-subtle bg-surface-card p-4">
        <summary className="cursor-pointer text-[13px] font-medium">Preview a CSV</summary>
        <p className="mt-2 text-[12px] text-text-tertiary">
          A separate, browser-only tool for looking at an exported file. It does not read from or write to the saved ledger above.
        </p>
        <div className="mt-4">
          <FinancialsClient embedded />
        </div>
      </details>
    </main>
  );
}
