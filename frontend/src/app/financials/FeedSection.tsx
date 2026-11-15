"use client";

import { useMemo } from "react";
import InfoHint from "@/components/InfoHint";
import type { LedgerLoad } from "@/lib/finance-ledger-types";
import FinancialsClient from "./FinancialsClient";
import LedgerView, { FreshnessLine } from "./LedgerView";
import { FeedSkeleton, RetryButton, StaleNote, useFinancePageData } from "./feed-data";

/**
 * /financials as a section of the continuous scroll: the same content as page.tsx (its default view: newest
 * month, all accounts, no search), rendered in the browser from GET /api/finance/page-data?page=financials.
 * Filters and paging open the routed page, which reads them from the address.
 */
export default function FinancialsFeedSection() {
  const { rootRef, data, failed, refresh, retry } = useFinancePageData<LedgerLoad>("financials");
  const now = useMemo(() => (data ? new Date(data.now) : null), [data]);
  const load = data?.load ?? null;
  const failedLoad = failed?.load?.kind === "error" ? failed.load : null;

  return (
    <section ref={rootRef} aria-labelledby="feed-financials-heading" className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header>
        <div className="flex items-center gap-2">
          <h2 id="feed-financials-heading" data-testid="feed-page-heading" className="text-2xl font-semibold">
            Financials
          </h2>
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

      {!load && !failed && <FeedSkeleton label="Financials" tiles={4} blocks={["h-72"]} list={6} />}

      {!load && failed && (
        <section role="alert" className="rounded-control border border-red-500/30 bg-red-500/5 p-4">
          <h3 className="font-semibold text-red-300">{failedLoad?.message ?? "Couldn't load the ledger."}</h3>
          <p className="mt-1 text-[13px] text-text-secondary">{failedLoad?.hint ?? "The server did not answer. Try again in a moment."}</p>
          <p className="mt-1 text-[12px] text-text-tertiary">This is a failed query, not an empty ledger.</p>
          <RetryButton onClick={retry} />
        </section>
      )}

      {load && failed && <StaleNote />}

      {load?.kind === "empty" && now && (
        <section className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
          <p className="font-semibold">
            {load.freshness
              ? "No ledger data yet - the harvester has run but imported nothing."
              : "No ledger data yet - the harvester has not run."}
          </p>
          <p className="mt-2 text-[13px] text-text-secondary">They appear after the first SimpleFIN import.</p>
          <div className="mt-3">
            <FreshnessLine freshness={load.freshness} now={now} />
          </div>
        </section>
      )}

      {load?.kind === "ok" && now && <LedgerView data={load.data} now={now} onChanged={refresh} />}

      <details className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
        <summary className="cursor-pointer text-[13px] font-medium">Preview a CSV</summary>
        <p className="mt-2 text-[12px] text-text-tertiary">Browser-only; it does not touch the saved ledger.</p>
        <div className="mt-4">
          <FinancialsClient embedded />
        </div>
      </details>
    </section>
  );
}
