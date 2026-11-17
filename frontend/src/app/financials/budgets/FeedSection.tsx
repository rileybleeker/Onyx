"use client";

import Link from "next/link";
import InfoHint from "@/components/InfoHint";
import type { BudgetsLoad } from "@/lib/finance-budgets-server";
import BudgetsView from "./BudgetsView";
import { FeedSkeleton, RetryButton, StaleNote, useFinancePageData } from "../feed-data";

/**
 * /financials/budgets as a section of the continuous scroll: the same content as page.tsx, rendered in the
 * browser from GET /api/finance/page-data?page=budgets.
 */
export default function BudgetsFeedSection() {
  const { rootRef, data, failed, refresh, retry } = useFinancePageData<BudgetsLoad>("budgets");
  const load = data?.load ?? null;

  return (
    <section ref={rootRef} aria-labelledby="feed-budgets-heading" className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-text-tertiary">
          <Link href="/financials" className="hover:text-text-secondary">Financials</Link> / Budgets
        </p>
        <div className="flex items-center gap-2">
          <h2 id="feed-budgets-heading" data-testid="feed-page-heading" className="text-2xl font-semibold">
            Budgets
          </h2>
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

      {!load && !failed && <FeedSkeleton label="Budgets" tiles={3} blocks={["h-48"]} list={6} />}

      {!load && failed && (
        <section role="alert" className="rounded-card border border-down/30 bg-down/5 p-4">
          <h3 className="font-semibold text-down">Budgets could not be loaded</h3>
          <p className="mt-1 text-[13px] text-text-secondary">Couldn&apos;t load this page. Try again.</p>
          <RetryButton onClick={retry} />
        </section>
      )}

      {load && failed && <StaleNote />}

      {load?.kind === "empty" && (
        <section className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
          <p className="font-semibold">No transactions in the last six months yet.</p>
        </section>
      )}

      {load?.kind === "ok" && (
        <BudgetsView
          result={load.result}
          categories={load.categories}
          rules={load.rules}
          setupPending={load.setupPending}
          subscriptions={load.subscriptions}
          onChanged={refresh}
        />
      )}
    </section>
  );
}
