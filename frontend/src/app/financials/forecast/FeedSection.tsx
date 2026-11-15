"use client";

import Link from "next/link";
import InfoHint from "@/components/InfoHint";
import type { ForecastLoad } from "@/lib/cash-forecast-server";
import ForecastView from "./ForecastView";
import { FeedSkeleton, StaleNote, useFinancePageData } from "../feed-data";

/**
 * /financials/forecast as a section of the continuous scroll: the same content as page.tsx without what-if
 * levers (the stored forecast), rendered in the browser from GET /api/finance/page-data?page=forecast.
 * Showing a what-if opens the routed page, which computes it from the address.
 */
export default function ForecastFeedSection() {
  const { rootRef, data, failed, refresh } = useFinancePageData<ForecastLoad>("forecast");
  const load = data?.load ?? null;
  const code = failed?.load?.kind === "error" ? failed.load.code : "unavailable";

  return (
    <section ref={rootRef} aria-labelledby="feed-forecast-heading" className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-text-tertiary">
          <Link href="/financials" className="hover:text-text-secondary">Financials</Link> / Forecast
        </p>
        <div className="flex items-center gap-2">
          <h2 id="feed-forecast-heading" data-testid="feed-page-heading" className="text-2xl font-semibold">
            Cash forecast
          </h2>
          <InfoHint label="Cash forecast">
            <p>
              Checking + savings, projected from your own history: paychecks and bills on their schedules, what you actually pay each
              card, everyday spending, and the items you plan below. Read-only: nothing here moves money.
            </p>
          </InfoHint>
        </div>
      </header>

      {!load && !failed && <FeedSkeleton label="Cash forecast" tiles={4} blocks={["h-80", "h-48"]} />}

      {!load && failed && (
        <section role="alert" className="rounded-card border border-down/30 bg-down/5 p-4">
          <h3 className="font-semibold text-down">The forecast could not be loaded</h3>
          <p className="mt-1 text-[13px] text-text-secondary">Error code {code}. This is a failed query, not an empty ledger.</p>
        </section>
      )}

      {load && failed && <StaleNote />}

      {load?.kind === "empty" && (
        <section className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
          <p className="font-semibold">No ledger data yet.</p>
          <p className="mt-1 text-[13px] text-text-secondary">The forecast appears after the first SimpleFIN import.</p>
        </section>
      )}

      {load?.kind === "ok" && (
        <ForecastView
          result={load.result}
          items={load.items}
          drivers={load.drivers}
          accounts={load.accounts}
          setupPending={load.setupPending}
          profile={load.profile}
          tax={load.tax}
          scenario={load.scenario}
          saved={load.saved}
          accuracy={load.accuracy}
          goals={load.goals}
          move={load.move}
          onChanged={refresh}
        />
      )}
    </section>
  );
}
