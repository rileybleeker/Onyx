import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { layoutCookieName, layoutFromCookie } from "@/lib/personalize-layout";
import { cachedBudgets } from "@/lib/finance-result-cache-server";
import InfoHint from "@/components/InfoHint";
import BudgetsView from "./BudgetsView";

// Private financial data: per request on the server, never ISR, never cached by the CDN; owner-only via
// middleware. The computed budgets are stored server-side (pds.finance_result_cache) and reused until the
// ledger, the budgets or the category fixes change.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Budgets - Onyx", robots: { index: false, follow: false } };

export default async function BudgetsPage() {
  const load = await cachedBudgets(new Date());
  // Personalize: the saved layout rides in a cookie scoped to this page, so the server renders it as is.
  const layout = layoutFromCookie((await cookies()).get(layoutCookieName("/financials/budgets"))?.value);
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-text-tertiary">
          <Link href="/financials" className="hover:text-text-secondary">Financials</Link> / Budgets
        </p>
        <div className="flex items-center gap-2">
          <h1 data-testid="page-heading" className="text-2xl font-semibold">Budgets</h1>
          <InfoHint label="Budgets">
            <p>
              This month&apos;s spending by category against your budgets, where it is heading, and what changed. Card payments and
              transfers are not spending, so a card purchase counts once.
            </p>
          </InfoHint>
        </div>
        <p className="mt-2 text-[13px]">
          <Link href="/financials/forecast" className="text-accent hover:underline">Cash forecast →</Link>
        </p>
      </header>
      {load.kind === "error" && (
        <section role="alert" className="rounded-card border border-down/30 bg-down/5 p-4">
          <h2 className="font-semibold text-down">Budgets could not be loaded</h2>
          <p className="mt-1 text-[13px] text-text-secondary">Error code {load.code}. This is a failed query, not an empty ledger.</p>
        </section>
      )}
      {load.kind === "empty" && (
        <section className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
          <p className="font-semibold">No transactions in the last six months yet.</p>
        </section>
      )}
      {load.kind === "ok" && <BudgetsView result={load.result} categories={load.categories} rules={load.rules} setupPending={load.setupPending} subscriptions={load.subscriptions} layout={layout} />}
    </main>
  );
}
