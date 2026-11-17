import type { Metadata } from "next";
import { cookies } from "next/headers";
import { loadLedger } from "@/lib/finance-ledger-server";
import { loadInvestments } from "@/lib/finance-holdings-server";
import { parseLedgerQuery } from "@/lib/finance-ledger";
import { layoutCookieName, layoutFromCookie } from "@/lib/personalize-layout";
import InfoHint from "@/components/InfoHint";
import FinancialsClient from "./FinancialsClient";
import LedgerView, { FreshnessLine } from "./LedgerView";
import InvestmentsPanel from "./InvestmentsPanel";

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
  // Search params and cookies are read together; both reads are in-request, not database round trips.
  const [params, cookieStore] = await Promise.all([searchParams, cookies()]);
  const [load, investments] = await Promise.all([
    loadLedger(parseLedgerQuery(params), now),
    loadInvestments(now),
  ]);
  // Personalize: the saved layout rides in a cookie scoped to this page, so the server renders it as is.
  const layout = layoutFromCookie(cookieStore.get(layoutCookieName("/financials"))?.value);

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header>
        <div className="flex items-center gap-2">
          <h1 data-testid="page-heading" className="text-2xl font-semibold">Financials</h1>
          <InfoHint label="Financials">
            <p>
              Bank accounts, balances and transactions, imported from SimpleFIN Bridge every 6 hours (Rocket Money history before
              2026-11-14). Shown only to you.
            </p>
          </InfoHint>
        </div>
        <p className="mt-2 text-[13px]">
          <a href="/financials/budgets" className="text-accent hover:underline">Budgets →</a>{" "}
          <a href="/financials/forecast" className="ml-3 text-accent hover:underline">Cash forecast →</a>
        </p>
      </header>

      {load.kind === "error" && (
        <section role="alert" className="rounded-control border border-red-500/30 bg-red-500/5 p-4">
          <h2 className="font-semibold text-red-300">{load.message}</h2>
          {load.hint && <p className="mt-1 text-[13px] text-text-secondary">{load.hint}</p>}
          <p className="mt-1 text-[12px] text-text-tertiary">This is a failed query, not an empty ledger.</p>
        </section>
      )}

      {load.kind === "empty" && (
        <section className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
          <p className="font-semibold">
            {load.freshness
              ? "No ledger data yet. The bank import ran but found no transactions."
              : "No ledger data yet. The bank import has not run."}
          </p>
          <p className="mt-2 text-[13px] text-text-secondary">They appear after the first SimpleFIN import.</p>
          <div className="mt-3">
            <FreshnessLine freshness={load.freshness} now={now} />
          </div>
        </section>
      )}

      {load.kind === "ok" && <LedgerView data={load.data} now={now} layout={layout} />}

      <InvestmentsPanel load={investments} />

      <details className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
        <summary className="cursor-pointer text-[13px] font-medium">Preview a CSV</summary>
        <p className="mt-2 text-[12px] text-text-tertiary">Browser-only; it does not touch the saved ledger.</p>
        <div className="mt-4">
          <FinancialsClient embedded />
        </div>
      </details>
    </main>
  );
}
