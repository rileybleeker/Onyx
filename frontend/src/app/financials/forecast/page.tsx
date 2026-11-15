import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { layoutCookieName, layoutFromCookie } from "@/lib/personalize-layout";
import { loadForecast } from "@/lib/cash-forecast-server";
import { cachedForecast } from "@/lib/finance-result-cache-server";
import { hasLevers, parseScenarioParams } from "@/lib/cash-forecast-scenario";
import InfoHint from "@/components/InfoHint";
import ForecastView from "./ForecastView";

// Private financial data: rendered per request on the server, never ISR, never cached by the CDN; the
// finance and plan tables are service-role only and the middleware lets only the owner reach this route.
// Without what-if levers the computed forecast is stored server-side (pds.finance_result_cache) and reused
// until the ledger or the plan changes; with levers it is computed for the request.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Cash forecast - Onyx",
  robots: { index: false, follow: false },
};

export default async function ForecastPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const levers = parseScenarioParams((k) => (typeof sp[k] === "string" ? (sp[k] as string) : null));
  const now = new Date();
  const load = hasLevers(levers) ? await loadForecast(now, levers) : await cachedForecast(now);
  // Personalize: the saved layout rides in a cookie scoped to this page, so the server renders it as is.
  const layout = layoutFromCookie((await cookies()).get(layoutCookieName("/financials/forecast"))?.value);
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-text-tertiary">
          <Link href="/financials" className="hover:text-text-secondary">Financials</Link> / Forecast
        </p>
        <div className="flex items-center gap-2">
          <h1 data-testid="page-heading" className="text-2xl font-semibold">Cash forecast</h1>
          <InfoHint label="Cash forecast">
            <p>
              Checking + savings, projected from your own history: paychecks and bills on their schedules, what you actually pay each
              card, everyday spending, and the items you plan below. Read-only: nothing here moves money.
            </p>
          </InfoHint>
        </div>
      </header>
      {load.kind === "error" && (
        <section role="alert" className="rounded-card border border-down/30 bg-down/5 p-4">
          <h2 className="font-semibold text-down">The forecast could not be loaded</h2>
          <p className="mt-1 text-[13px] text-text-secondary">Error code {load.code}. This is a failed query, not an empty ledger.</p>
        </section>
      )}
      {load.kind === "empty" && (
        <section className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
          <p className="font-semibold">No ledger data yet.</p>
          <p className="mt-1 text-[13px] text-text-secondary">The forecast appears after the first SimpleFIN import.</p>
        </section>
      )}
      {load.kind === "ok" && (
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
          layout={layout}
        />
      )}
    </main>
  );
}
