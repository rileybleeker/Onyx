"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { accentColor, axisTick, chartColors, chartTooltip, gridStyle } from "@/lib/chart-theme";
import type { ForecastResult } from "@/lib/cash-forecast";
import { nextExpiry, safeToMoveTile } from "@/lib/cash-forecast-eligibility";
import type { DriverRow } from "@/lib/cash-forecast-store";
import type { AccuracyRow, ForecastAccountView, PlanItemView } from "@/lib/cash-forecast-server";
import type { ScenarioParams } from "@/lib/cash-forecast-scenario";
import type { TaxProfile, TaxYearResult } from "@/lib/tax-plan";
import { CompareTable, TaxSection, WhatIfPanel } from "./TaxAndWhatIf";
import { GoalsSection, NetWorthChart, ProjectionBreakdown } from "./ProjectionParts";
import type { GoalView } from "@/lib/finance-goals";
import type { MovePlan } from "@/lib/finance-plan";
import { ModelSettings, PlanConfig, StreamEditorList } from "./PlanConfig";
import InfoHint from "@/components/InfoHint";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { useFinanceAutosave } from "@/lib/use-finance-autosave";
import { Part, PartGrid, PartGroup } from "@/components/personalize/PartGrid";
import type { PageLayout } from "@/lib/personalize-layout";

const usd = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "-";
  const v = Math.round(Math.abs(cents) / 100).toLocaleString("en-US");
  return cents < 0 ? `-$${v}` : `$${v}`;
};
const signed = (cents: number) => (cents > 0 ? `+${usd(cents)}` : usd(cents));
const dateLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
const card = "rounded-card shadow-card border border-border-subtle bg-surface-card p-4";
const input = "rounded-control border border-border-subtle bg-transparent px-2 py-1 text-[13px]";
const button = "rounded-control border border-border-subtle px-3 py-1 text-[13px] hover:bg-white/5 disabled:opacity-50";

/**
 * The client's clock for the safe-to-move check, so a page (or a scroll section, or a copy kept by the client cache)
 * left open past the check's expiry withholds the amount instead of showing it as actionable. undefined until
 * mounted, so the first render equals the server's (the server already applied its own clock). Re-read at the
 * earliest expiry ahead and whenever the page comes back into view (a sleeping laptop delays timers).
 */
function useCheckClock(results: readonly ({ eligibility?: unknown } | null | undefined)[]): number | undefined {
  const [now, setNow] = useState<number | undefined>(undefined);
  const untils = results.map((r) => (r?.eligibility as { validUntil?: unknown } | undefined)?.validUntil ?? "").join("|");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (timer) clearTimeout(timer);
      timer = null;
      const next = nextExpiry(results, t);
      // +1 s past the expiry; setTimeout's longest delay is about 24.8 days.
      if (next !== null) timer = setTimeout(tick, Math.min(next - t + 1_000, 2 ** 31 - 1));
    };
    tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // The check's expiry times are what matter; the result objects change identity on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [untils]);
  return now;
}

// Returns null on success, else the fixed copy to show. The server's error text is never shown.
async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.ok) return null;
    return "Not saved. Try again.";
  } catch {
    return "Not saved. Check your connection and try again.";
  }
}

export default function ForecastView({
  result,
  items,
  drivers,
  accounts,
  setupPending,
  profile,
  tax,
  scenario,
  saved,
  accuracy,
  goals,
  move,
  onChanged,
  layout,
}: {
  result: ForecastResult;
  items: PlanItemView[];
  drivers: DriverRow[];
  accounts: ForecastAccountView[];
  setupPending: boolean;
  profile: TaxProfile | null;
  tax: TaxYearResult[];
  scenario: { params: ScenarioParams; result: ForecastResult; tax: TaxYearResult[] } | null;
  saved: { slug: string; name: string; params: ScenarioParams }[];
  accuracy: AccuracyRow[];
  goals: GoalView[];
  move: MovePlan | null;
  /** Re-read the data after a save (the scroll section); without it the server page refreshes. */
  onChanged?: () => void;
  /** The saved Personalize layout read from the page's cookie (the routed page only). */
  layout?: PageLayout;
}) {
  const router = useRouter();
  const [range, setRange] = useState<"13w" | "12m">("13w");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const h = result.headlines;
  const buffer = Number((drivers.find((d) => d.key === "settings")?.value as { bufferCents?: number } | undefined)?.bufferCents ?? 0);
  // Safe to move: an amount only when the inputs were complete and fresh (result.eligibility), else the reasons.
  // checkNow = this browser's clock (after mount): an amount whose check has expired since it was computed is withheld.
  const checkNow = useCheckClock([result, scenario?.result]);
  const safe = safeToMoveTile(result, buffer, checkNow);
  // Pool accounts Riley left out of the amount (driver "safe-to-move"): an account the feed no longer refreshes would
  // otherwise withhold it for good. Leaving one out takes its balance out of the amount; the projection keeps it.
  // One account per request, merged with the saved list on the server (never this page's copy of the drivers).
  const setLeftOut = (account: string, out: boolean) => run(() => send("/api/finance/forecast/drivers", "PUT", { key: "safe-to-move", account, leaveOut: out }));
  // Keyed by account AND text (index for an exact repeat): two accounts can share a label, so the same sentence can
  // name two accounts, and each Leave it out button must stay bound to its own account.
  const reasonItem = (r: { text: string; account?: string }, i: number) => (
    <li key={`${i}|${r.account ?? ""}|${r.text}`}>
      {r.text}
      {r.account && (
        <button type="button" className="ml-1 underline disabled:opacity-50" disabled={busy} onClick={() => void setLeftOut(r.account as string, true)}>
          Leave it out
        </button>
      )}
    </li>
  );

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const err = await fn();
    setBusy(false);
    if (err) setError(err);
    else if (onChanged) onChanged();
    else router.refresh();
  };

  const shown = range === "13w" ? 91 : 365;
  const chartData = useMemo(
    () =>
      result.days.slice(0, shown).map((d, i) => ({
        date: d.date,
        likely: d.likely / 100,
        band: [d.low / 100, d.high / 100],
        whatif: scenario ? (scenario.result.days[i]?.likely ?? 0) / 100 : undefined,
      })),
    [result.days, shown, scenario],
  );
  const lastShown = result.days[Math.min(shown, result.days.length) - 1]?.date ?? result.today;
  const milestonesShown = result.milestones.filter((m) => !m.ended && m.date <= lastShown);
  const soon = result.lines.filter((l) => l.layer !== "baseline" && l.date <= addDaysIso(result.today, 30));
  const weekly = result.baseline.projected ? result.baseline.weeklyMeanCents : null;

  if (result.state !== "ok") {
    return (
      <section className={card}>
        <p className="font-semibold">{result.state === "no-pool" ? "No checking or savings account found." : "No balance yet for your cash accounts."}</p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {setupPending && <p className="text-[13px] text-mid">Planned items could not be read; showing the forecast from your history only.</p>}
      {error && <p role="alert" className="text-[13px] text-down">{error}</p>}

      {/* Personalize: every tile, chart and card is its own part; parts move within and between the sections below. */}
      <PartGrid page="/financials/forecast" title="Cash forecast" initial={layout}>
        <PartGroup id="section-headlines" title="Headlines">
          <Part id="lowest" title="Lowest point, next 13 weeks" width="quarter">
            <div className={card}>
              <p className="text-[12px] text-text-tertiary">Lowest point, next 13 weeks (cautious)</p>
              <p className="text-xl font-semibold">{usd(h.lowest?.cents)}</p>
              <p className="text-[12px] text-text-secondary">{h.lowest ? `around ${dateLabel(h.lowest.date)}` : ""} · likely {usd(h.lowestLikely?.cents)}</p>
            </div>
          </Part>
          <Part id="safe-to-move" title="Safe to move to savings" width="quarter">
            {/* The amount and the reason it is withheld live in ONE part, so Personalize cannot hide one without the other. */}
            <div className={`${card} ${safe.kind === "unavailable" ? "border-mid/40" : ""}`} data-testid="safe-to-move">
              <p className="text-[12px] text-text-tertiary">Safe to move to savings / investing</p>
              {safe.kind === "amount" ? (
                <>
                  <p className="text-xl font-semibold">{usd(safe.cents)}</p>
                  <p className="text-[12px] text-text-secondary">
                    keeps the cautious path above {safe.bufferSet ? `${usd(safe.bufferCents)} (your buffer)` : "$0"} for 13 weeks
                    {safe.perWeekCents !== null ? ` · or about ${usd(safe.perWeekCents)} a week` : ""}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xl font-semibold text-mid">Not available</p>
                  <ul className="mt-1 space-y-0.5 text-[12px] text-mid" aria-label="Why there is no amount">
                    {safe.reasons.map(reasonItem)}
                    {safe.more.length > 0 && (
                      <li>
                        <details>
                          <summary className="cursor-pointer">{`${safe.more.length} more`}</summary>
                          <ul className="mt-0.5 space-y-0.5">{safe.more.map(reasonItem)}</ul>
                        </details>
                      </li>
                    )}
                  </ul>
                  <p className="mt-1 text-[12px] text-text-secondary">The projection below is an estimate.</p>
                </>
              )}
              {safe.leftOut.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[12px] text-text-secondary" aria-label="Accounts not counted in this amount">
                  {safe.leftOut.map((l) => (
                    <li key={l.account}>
                      {l.text}
                      {l.chosen && (
                        <button type="button" className="ml-1 underline disabled:opacity-50" disabled={busy} onClick={() => void setLeftOut(l.account, false)}>
                          Count it again
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {safe.asOf && <p className="mt-1 text-[12px] text-text-tertiary">Cash as of {safe.asOf}</p>}
            </div>
          </Part>
          <Part id="cash-13w" title="Cash in 13 weeks" width="quarter">
            <div className={card}>
              <p className="text-[12px] text-text-tertiary">Cash in 13 weeks</p>
              <p className="text-xl font-semibold">{usd(h.end13w?.likely)}</p>
              <p className="text-[12px] text-text-secondary">range {usd(h.end13w?.low)} to {usd(h.end13w?.high)} · today {usd(result.opening.cents)}</p>
            </div>
          </Part>
          <Part id="promo-end" title="Next 0% promo ends" width="quarter">
            <div className={`${card} ${h.nextPromoEnd ? "border-mid/40" : ""}`}>
              <p className="text-[12px] text-text-tertiary">Next 0% promo ends</p>
              {h.nextPromoEnd ? (
                <>
                  <p className="text-xl font-semibold">{dateLabel(h.nextPromoEnd.date, { month: "short", day: "numeric", year: "numeric" })}</p>
                  <p className="text-[12px] text-text-secondary">
                    {h.nextPromoEnd.label}: {usd(h.nextPromoEnd.owedAtEndCents)} still owed then at current payments
                  </p>
                </>
              ) : (
                <p className="text-[13px] text-text-secondary">No promo end date known.</p>
              )}
            </div>
          </Part>
          {result.warnings.length > 0 && (
            <Part id="warnings" title="Forecast warnings">
              <ul className="space-y-1 text-[13px] text-mid">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Part>
          )}
        </PartGroup>

        <PartGroup id="section-what-if" title="What-if">
          <Part id="what-if" title="What-if">
            <WhatIfPanel params={scenario?.params ?? null} accounts={accounts} saved={saved} busy={busy} run={run} />
          </Part>
          {scenario && (
            <Part id="compare" title="Base plan vs what-if">
              <CompareTable base={result} baseTax={tax} scen={scenario.result} scenTax={scenario.tax} now={checkNow} />
            </Part>
          )}
        </PartGroup>

        <PartGroup id="section-projection" title="Projection">
          <Part id="cash-chart" title="Projected cash">
            <section className={card} aria-labelledby="fc-chart">
              <div className="mb-2 flex items-center justify-between">
                <h2 id="fc-chart" className="font-semibold">Projected cash (checking + savings)</h2>
                <div className="flex gap-1">
                  {(["13w", "12m"] as const).map((r) => (
                    <button key={r} className={`${button} ${range === r ? "bg-white/10" : ""}`} onClick={() => setRange(r)}>
                      {r === "13w" ? "13 weeks" : "12 months"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 10 }}>
                    <CartesianGrid {...gridStyle} vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => dateLabel(d)} minTickGap={40} tick={axisTick} />
                    <YAxis tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} tick={axisTick} width={48} />
                    <Tooltip
                      formatter={(v, name) =>
                        Array.isArray(v) ? [`${usd(Number(v[0]) * 100)} to ${usd(Number(v[1]) * 100)}`, "range"] : [usd(Number(v) * 100), String(name)]
                      }
                      labelFormatter={(d) => dateLabel(String(d), { month: "short", day: "numeric", year: "numeric" })}
                      {...chartTooltip}
                    />
                    <Area dataKey="band" stroke="none" fill={accentColor} fillOpacity={0.15} isAnimationActive={false} name="range" />
                    <Line dataKey="likely" stroke={accentColor} dot={false} strokeWidth={2} isAnimationActive={false} name={scenario ? "base plan" : "likely"} />
                    {scenario && <Line dataKey="whatif" stroke={chartColors.strain} dot={false} strokeWidth={2} strokeDasharray="6 3" isAnimationActive={false} name="what-if" />}
                    <ReferenceLine y={0} stroke={chartColors.zeroLine} />
                    {buffer > 0 && <ReferenceLine y={buffer / 100} stroke={chartColors.down} strokeDasharray="4 4" label={{ value: "buffer", fill: chartColors.down, fontSize: 11 }} />}
                    {milestonesShown.map((m) => (
                      <ReferenceLine key={m.account_key} x={nearestDay(chartData, m.date)} stroke={chartColors.mid} strokeDasharray="3 3" label={{ value: `${shortCard(m.label)} 0% ends`, fill: chartColors.mid, fontSize: 11, position: "insideTopLeft" }} />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-2 text-[12px] text-text-tertiary">
                Line = likely · shaded = 10th–90th percentile of 500 resampled paths · amber = a 0% promo ends
                {scenario && " · dashed blue = the what-if"}
                {range === "12m" && " · less certain past 13 weeks"}
              </p>
            </section>
          </Part>
          <Part id="goals" title="Goals">
            <GoalsSection goals={goals} accounts={accounts} busy={busy} run={run} />
          </Part>
          <Part id="breakdown" title="Projection, month by month">
            <ProjectionBreakdown result={result} scenario={scenario?.result ?? null} />
          </Part>
          <Part id="net-worth" title="Net worth projection">
            <NetWorthChart result={result} scenario={scenario?.result ?? null} />
          </Part>
        </PartGroup>

        <PartGroup id="section-upcoming" title="Promos and next 30 days">
          <Part id="promos" title="0% promos">
            <section className={card} aria-labelledby="fc-promos">
              <h2 id="fc-promos" className="font-semibold">0% promos</h2>
              {result.milestones.length === 0 ? (
                <p className="mt-1 text-[13px] text-text-secondary">No promo end dates known. Add one under Cards below.</p>
              ) : (
                <ul className="mt-2 space-y-2 text-[13px]">
                  {result.milestones.map((m) => (
                    <li key={m.account_key} className={m.ended ? "text-text-tertiary" : ""}>
                      <span className="font-semibold">{m.label}</span>: {m.ended ? "ended" : "ends"} {dateLabel(m.date, { month: "short", day: "numeric", year: "numeric" })}
                      {!m.ended && ` (${m.daysAway} days)`}. At your current payments about <b>{usd(m.owedAtEndCents)}</b> is still owed then, costing about{" "}
                      <b>{usd(m.interestPerMonthAfterCents)}/month</b> at {m.standardAprPct}%{m.standardAprAssumed ? " (assumed: enter the real APR below)" : ""}.
                      {!m.ended && m.payPerMonthToClearCents > 0 && <> Paying <b>{usd(m.payPerMonthToClearCents)}/month</b> clears it in time.</>}
                      <span className="text-text-tertiary"> Date {m.source}.</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </Part>
          <Part id="next-30" title="Next 30 days">
            <section className={card} aria-labelledby="fc-soon">
              <h2 id="fc-soon" className="font-semibold">Next 30 days</h2>
              <table className="mt-2 w-full text-[13px]">
                <tbody>
                  {soon.map((l, i) => (
                    <tr key={`${l.sourceId}-${l.date}-${i}`} className="border-t border-border-subtle">
                      <td className="py-1 pr-3 text-text-secondary">{dateLabel(l.date)}</td>
                      <td className="py-1 pr-3">{l.label}</td>
                      <td className={`py-1 pr-3 text-right ${l.amountCents > 0 ? "text-up" : ""}`}>{signed(l.amountCents)}</td>
                      <td className="py-1 text-[12px] text-text-tertiary">{l.layer === "planned" ? `planned (${l.certainty})` : l.reason}</td>
                    </tr>
                  ))}
                  {weekly !== null && (
                    <tr className="border-t border-border-subtle">
                      <td className="py-1 pr-3 text-text-secondary">every week</td>
                      <td className="py-1 pr-3">Everyday spending</td>
                      <td className="py-1 pr-3 text-right">{signed(weekly)}</td>
                      <td className="py-1 text-[12px] text-text-tertiary">mean of the last {result.baseline.weeksUsed} weeks after the lines above</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          </Part>
        </PartGroup>

        <PartGroup id="section-plan" title="Plan">
          <Part id="plan" title="Plan and assumptions">
            <PlanConfig move={move} drivers={drivers} accounts={accounts} netWorth={result.netWorth} busy={busy} run={run} />
          </Part>
          <Part id="taxes" title="Taxes">
            <TaxSection tax={tax} profile={profile} busy={busy} run={run} />
          </Part>
          <Part id="planned" title="Planned items">
            <PlannedItems
              items={items}
              statuses={result.planned}
              busy={busy}
              run={run}
              accountOptions={[
                ...accounts.filter((a) => a.type === "investment").map((a) => ({ key: a.account_key, label: a.label })),
                ...drivers.filter((d) => d.key.startsWith("growth:virtual-")).map((d) => ({ key: d.key.slice(7), label: String((d.value as { label?: unknown }).label ?? d.key.slice(7)) })),
              ]}
            />
          </Part>
          <Part id="cards" title="Cards">
            <Cards result={result} drivers={drivers} accounts={accounts} busy={busy} run={run} />
          </Part>
        </PartGroup>

        <PartGroup id="section-history" title="History and accuracy">
          <Part id="detected" title="What the forecast found">
            <section className={card} aria-labelledby="fc-detected">
              <div className="flex items-center gap-2">
                <h2 id="fc-detected" className="font-semibold">What the forecast found in your history</h2>
                <InfoHint label="What the forecast found">
                  <p>Change any amount from a date (a raise, a new card payment plan) or stop one; Reset goes back to what your history shows.</p>
                </InfoHint>
              </div>
              <StreamEditorList streams={result.streams} drivers={drivers} today={result.today} busy={busy} run={run} />
              {result.notes.length > 0 && (
                <ul className="mt-3 space-y-1 text-[12px] text-text-tertiary">
                  {result.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </section>
          </Part>
          <Part id="accuracy" title="Forecast accuracy">
            <section className={card} aria-labelledby="fc-acc">
              <div className="flex items-center gap-2">
                <h2 id="fc-acc" className="font-semibold">How accurate has the forecast been?</h2>
                <InfoHint label="Forecast accuracy">
                  <p>
                    Backtest on 18 months of history (64 weekly runs): typically off by about 17% of a month&apos;s outflows at 4 weeks and 32%
                    at 13 weeks, with no average bias; about 85% of outcomes landed inside the range.
                  </p>
                </InfoHint>
              </div>
              {accuracy.length === 0 ? (
                <p className="mt-1 text-[13px] text-text-secondary">A snapshot is saved every Monday; this fills in as weeks pass.</p>
              ) : (
                <table className="mt-2 w-full text-[13px]">
                  <thead className="text-[12px] text-text-tertiary">
                    <tr>
                      <th className="text-left font-normal">Week ending</th>
                      <th className="text-left font-normal">Forecast made</th>
                      <th className="text-right font-normal">Said</th>
                      <th className="text-right font-normal">Range</th>
                      <th className="text-right font-normal">Actual</th>
                      <th className="text-right font-normal">Off by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accuracy.map((a) => (
                      <tr key={a.weekEnd} className="border-t border-border-subtle">
                        <td className="py-1">{dateLabel(a.weekEnd)}</td>
                        <td className="py-1 text-text-secondary">{dateLabel(a.asOf)}</td>
                        <td className="py-1 text-right">{usd(a.likely)}</td>
                        <td className="py-1 text-right text-text-tertiary">
                          {usd(a.low)} to {usd(a.high)}
                        </td>
                        <td className="py-1 text-right font-semibold">{usd(a.actual)}</td>
                        <td className={`py-1 text-right ${a.actual < a.low || a.actual > a.high ? "text-mid" : "text-text-secondary"}`}>{signed(a.likely - a.actual)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </Part>
          <Part id="model-settings" title="Model settings">
            <ModelSettings drivers={drivers} busy={busy} run={run} />
          </Part>
        </PartGroup>
      </PartGrid>
    </div>
  );
}

function PlannedItems({ items, statuses, busy, run, accountOptions }: { items: PlanItemView[]; statuses: ForecastResult["planned"]; busy: boolean; run: (fn: () => Promise<string | null>) => void; accountOptions: { key: string; label: string }[] }) {
  const [label, setLabel] = useState("");
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [dir, setDir] = useState<"out" | "in">("out");
  const [certainty, setCertainty] = useState("likely");
  const [months, setMonths] = useState("1");
  const [unit, setUnit] = useState<"once" | "month" | "year">("once");
  const [account, setAccount] = useState("");
  const statusOf = (id: string) => statuses.filter((s) => s.id === id || s.id.startsWith(`${id}#`));
  const add = () => {
    const dollars = Number(amount.replace(/[$,\s]/g, ""));
    const count = Math.max(1, Math.min(120, Math.round(Number(months) || 1)));
    if (!label.trim() || !date || !(dollars > 0)) return;
    run(() =>
      send("/api/finance/forecast/items", "POST", {
        label: label.trim(),
        date,
        amountCents: Math.round(dollars * 100) * (dir === "in" ? 1 : -1),
        certainty,
        ...(unit !== "once" && count > 1 ? { repeatUnit: "month", repeatEvery: unit === "year" ? 12 : 1, repeatCount: count } : {}),
        ...(account ? { accountKey: account } : {}),
      }).then((e) => {
        if (!e) {
          setLabel("");
          setAmount("");
        }
        return e;
      }),
    );
  };
  return (
    <section className={card} aria-labelledby="fc-planned">
      <div className="flex items-center gap-2">
        <h2 id="fc-planned" className="font-semibold">Planned items</h2>
        <InfoHint label="Planned items">
          <p>A bonus, move, trip, tax payment or big purchase. Each one is matched to the real transaction when it happens.</p>
        </InfoHint>
      </div>
      <table className="mt-2 w-full text-[13px]">
        <tbody>
          {items.map((it) => {
            const st = statusOf(it.id);
            const realized = st.filter((s) => s.status === "realized").length;
            const late = st.filter((s) => s.status.startsWith("late")).length;
            return (
              <tr key={it.id} className="border-t border-border-subtle">
                <td className="py-1 pr-3 text-text-secondary">{dateLabel(it.date, { month: "short", day: "numeric", year: "numeric" })}</td>
                <td className="py-1 pr-3">
                  {it.label}
                  {it.repeat && <span className="text-text-tertiary"> · {it.repeat}</span>}
                  {it.account && <span className="text-text-tertiary"> · {it.amountCents < 0 ? "into" : "from"} {it.account}</span>}
                  {it.note && <div className="text-[12px] text-text-tertiary">{it.note}</div>}
                </td>
                <td className={`py-1 pr-3 text-right ${it.amountCents > 0 ? "text-up" : ""}`}>{signed(it.amountCents)}</td>
                <td className="py-1 pr-3 text-[12px] text-text-tertiary">
                  {it.certainty}
                  {realized > 0 && " · happened"}
                  {late > 0 && " · late"}
                </td>
                <td className="py-1 text-right">
                  <button className={button} disabled={busy} onClick={() => run(() => send(`/api/finance/forecast/items/${it.id}`, "DELETE"))}>
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input className={input} placeholder="What (e.g. Movers)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
        <input className={input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <select className={input} value={dir} onChange={(e) => setDir(e.target.value as "in" | "out")}>
          <option value="out">money out</option>
          <option value="in">money in</option>
        </select>
        <input className={`${input} w-28`} placeholder="$ amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <select className={input} value={certainty} onChange={(e) => setCertainty(e.target.value)}>
          <option value="confirmed">confirmed</option>
          <option value="likely">likely</option>
          <option value="possible">possible</option>
        </select>
        <label className="text-[12px] text-text-secondary">
          <select className={input} value={unit} onChange={(e) => setUnit(e.target.value as "once" | "month" | "year")} aria-label="Repeats">
            <option value="once">once</option>
            <option value="month">every month</option>
            <option value="year">every year</option>
          </select>{" "}
          times <input className={`${input} w-14`} inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} />
        </label>
        <label className="text-[12px] text-text-secondary">
          {dir === "out" ? "into" : "from"}{" "}
          <select className={input} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Investment account on the other side">
            <option value="">(spent / received)</option>
            {accountOptions.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <button className={button} disabled={busy} onClick={add}>
          Add
        </button>
      </div>
    </section>
  );
}

function Cards({ result, drivers, accounts, busy, run }: { result: ForecastResult; drivers: DriverRow[]; accounts: ForecastAccountView[]; busy: boolean; run: (fn: () => Promise<string | null>) => void }) {
  const cards = result.cards;
  const known = new Set(cards.map((c) => c.account_key));
  const extra = accounts.filter((a) => a.type === "card" && !known.has(a.account_key));
  return (
    <section className={card} aria-labelledby="fc-cards">
      <div className="flex items-center gap-2">
        <h2 id="fc-cards" className="font-semibold">Cards</h2>
        <InfoHint label="Cards">
          <p>
            APR comes from the interest each card actually charged unless you enter it. Promo end dates are read from balance-transfer
            rows when the bank prints them; enter the rest from your statement.
          </p>
        </InfoHint>
      </div>
      <div className="mt-2 space-y-3">
        {cards.map((c) => (
          <CardRow key={c.account_key} c={c} driver={drivers.find((d) => d.key === `card:${c.account_key}`)?.value} busy={busy} run={run} />
        ))}
        {extra.length > 0 && <p className="text-[12px] text-text-tertiary">{extra.length} other card(s) with no balance or activity.</p>}
      </div>
    </section>
  );
}

function CardRow({ c, driver, busy, run }: { c: ForecastResult["cards"][number]; driver: Record<string, unknown> | undefined; busy: boolean; run: (fn: () => Promise<string | null>) => void }) {
  const [promoEnds, setPromoEnds] = useState(typeof driver?.promoEnds === "string" ? driver.promoEnds : "");
  const [apr, setApr] = useState(typeof driver?.aprPct === "number" ? String(driver.aprPct) : "");
  const [std, setStd] = useState(typeof driver?.standardAprPct === "number" ? String(driver.standardAprPct) : "");
  type CardForm = { promoEnds: string; apr: string; std: string };
  const toValue = (g: CardForm) => {
    const value: Record<string, unknown> = {};
    if (g.promoEnds) value.promoEnds = g.promoEnds;
    if (g.apr.trim()) value.aprPct = Number(g.apr);
    if (g.std.trim()) value.standardAprPct = Number(g.std);
    if (g.promoEnds && typeof driver?.promoNote === "string" && g.promoEnds === driver.promoEnds) value.promoNote = driver.promoNote;
    if (g.promoEnds && g.promoEnds !== driver?.promoEnds) value.promoAprPct = 0;
    // An unchanged promo keeps its stored promo APR (autosave sends this value again whenever an APR changes).
    else if (g.promoEnds && typeof driver?.promoAprPct === "number") value.promoAprPct = driver.promoAprPct;
    return Object.keys(value).length ? value : null;
  };
  // Autosave (lib/use-finance-autosave.ts): sent after a pause or when the field is left, then the forecast re-reads.
  const autosave = useFinanceAutosave<CardForm>(`forecast-card:${c.account_key}`, run, (g) => send("/api/finance/forecast/drivers", "PUT", { key: `card:${c.account_key}`, value: toValue(g) }), {
    ready: (g) => (g.apr.trim() && !Number.isFinite(Number(g.apr))) || (g.std.trim() && !Number.isFinite(Number(g.std))) ? "APR must be a number." : null,
    baseline: { promoEnds, apr, std },
  });
  const edit = (patch: Partial<CardForm>) => {
    const next = { promoEnds, apr, std, ...patch };
    setPromoEnds(next.promoEnds);
    setApr(next.apr);
    setStd(next.std);
    autosave.change(next);
  };
  const flush = () => void autosave.flush();
  void busy;
  return (
    <div className="border-t border-border-subtle pt-2 text-[13px]">
      <p>
        <span className="font-semibold">{c.label}</span>: owed {usd(c.owedNow)} · APR {c.aprPct}% <span className="text-text-tertiary">({c.aprSource})</span> · paid about {usd(c.monthlyPaymentCents)}/month ·
        interest next 12 months ~{usd(c.interestNext12Cents)}
        {c.promoEnds && (
          <>
            {" "}
            · <span className="text-mid">promo ends {c.promoEnds}</span> <span className="text-text-tertiary">({c.promoSource})</span>
          </>
        )}
      </p>
      {c.warnings.map((w) => (
        <p key={w} className="text-[12px] text-mid">
          {w}
        </p>
      ))}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
        <label>
          promo ends <input className={input} type="date" value={promoEnds} onChange={(e) => edit({ promoEnds: e.target.value })} onBlur={flush} />
        </label>
        <label>
          APR now % <input className={`${input} w-16`} inputMode="decimal" value={apr} onChange={(e) => edit({ apr: e.target.value })} onBlur={flush} placeholder="auto" />
        </label>
        <label>
          APR after promo % <input className={`${input} w-16`} inputMode="decimal" value={std} onChange={(e) => edit({ std: e.target.value })} onBlur={flush} placeholder="24" />
        </label>
        <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} showIncomplete />
      </div>
    </div>
  );
}

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function nearestDay(data: { date: string }[], iso: string): string {
  return data.find((d) => d.date >= iso)?.date ?? data[data.length - 1]?.date ?? iso;
}
function shortCard(label: string): string {
  return label.replace(/[®™]/g, "").replace(/\bCard\b/i, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");
}
