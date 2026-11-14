"use client";

import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { accentColor, axisTick, chartColors, chartTooltip, gridStyle, legendStyle } from "@/lib/chart-theme";
import type { ForecastResult } from "@/lib/cash-forecast";

const usd = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "-";
  const v = Math.round(Math.abs(cents) / 100).toLocaleString("en-US");
  return cents < 0 ? `-$${v}` : `$${v}`;
};
const card = "rounded-card shadow-card border border-border-subtle bg-surface-card p-4";
const monthLabel = (key: string) => new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

const BUCKETS = ["Paychecks & income", "Bonus (after tax)", "Card payments", "Bills & autopays", "Everyday spending", "Taxes & refunds", "Planned items"] as const;
type Bucket = (typeof BUCKETS)[number];

/** Which variable a forecast line belongs to. */
function bucketOf(l: ForecastResult["lines"][number], kinds: Map<string, string>): Bucket {
  if (l.layer === "baseline") return "Everyday spending";
  if (l.sourceId.startsWith("tax:")) return "Taxes & refunds";
  if (l.sourceId.startsWith("pay:")) return "Bonus (after tax)";
  const k = kinds.get(l.sourceId);
  if (k === "income") return "Paychecks & income";
  if (k === "card") return "Card payments";
  if (k === "bill") return "Bills & autopays";
  return "Planned items";
}

export function ProjectionBreakdown({ result, scenario }: { result: ForecastResult; scenario: ForecastResult | null }) {
  const r = scenario ?? result;
  const kinds = new Map(r.streams.map((s) => [s.id, s.kind]));
  const months = [...new Set(r.lines.map((l) => l.date.slice(0, 7)))].sort().slice(0, 12);
  const grid = new Map<string, Map<Bucket, number>>();
  for (const l of r.lines) {
    const m = l.date.slice(0, 7);
    if (!months.includes(m)) continue;
    const row = grid.get(m) ?? new Map<Bucket, number>();
    const b = bucketOf(l, kinds);
    row.set(b, (row.get(b) ?? 0) + l.amountCents);
    grid.set(m, row);
  }
  const used = BUCKETS.filter((b) => months.some((m) => (grid.get(m)?.get(b) ?? 0) !== 0));
  const endOf = (m: string) => r.days.filter((d) => d.date.slice(0, 7) === m).pop()?.likely;
  return (
    <section className={card} aria-labelledby="fc-breakdown">
      <h2 id="fc-breakdown" className="font-semibold">What is in the projection, month by month{scenario ? " (what-if)" : ""}</h2>
      <p className="text-[12px] text-text-tertiary">Every line the cash forecast adds up. A row you expect but do not see is a variable the forecast is missing: add it as a planned item or in the tax profile.</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="text-text-tertiary">
            <tr>
              <th className="text-left font-normal"></th>
              {months.map((m) => (
                <th key={m} className="px-1 text-right font-normal">
                  {monthLabel(m)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {used.map((b) => (
              <tr key={b} className="border-t border-border-subtle">
                <td className="whitespace-nowrap py-1 pr-2">{b}</td>
                {months.map((m) => {
                  const v = grid.get(m)?.get(b) ?? 0;
                  return (
                    <td key={m} className={`px-1 py-1 text-right tabular-nums ${v > 0 ? "text-up" : ""}`}>
                      {v === 0 ? "" : usd(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t border-border-subtle font-semibold">
              <td className="py-1 pr-2">Net change</td>
              {months.map((m) => {
                const v = [...(grid.get(m)?.values() ?? [])].reduce((a, x) => a + x, 0);
                return (
                  <td key={m} className={`px-1 py-1 text-right tabular-nums ${v >= 0 ? "text-up" : "text-down"}`}>
                    {usd(v)}
                  </td>
                );
              })}
            </tr>
            <tr className="border-t border-border-subtle text-text-secondary">
              <td className="py-1 pr-2">Cash at month end</td>
              {months.map((m) => (
                <td key={m} className="px-1 py-1 text-right tabular-nums">
                  {usd(endOf(m))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function NetWorthChart({ result, scenario }: { result: ForecastResult; scenario: ForecastResult | null }) {
  const data = result.netWorth.map((m, i) => ({
    month: m.month,
    netWorth: m.netWorth / 100,
    investments: m.investments / 100,
    cash: m.cash / 100,
    cards: -m.cardsOwed / 100,
    whatif: scenario ? (scenario.netWorth[i]?.netWorth ?? 0) / 100 : undefined,
  }));
  const last = result.netWorth[result.netWorth.length - 1];
  const first = result.netWorth[0];
  const accounts = last?.byAccount ? Object.entries(last.byAccount) : [];
  return (
    <section className={card} aria-labelledby="fc-nw">
      <h2 id="fc-nw" className="font-semibold">Projected net worth</h2>
      <p className="text-[12px] text-text-secondary">
        {first && last ? (
          <>
            {usd(first.netWorth)} next month → <b>{usd(last.netWorth)}</b> in {result.netWorth.length} months ({last.netWorth - first.netWorth >= 0 ? "+" : ""}
            {usd(last.netWorth - first.netWorth)}). Cash from the forecast, investments at their expected return plus contributions, card balances after
            payments, interest and promo ends.
          </>
        ) : (
          "Not enough data yet."
        )}
      </p>
      <div className="mt-2 h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: 10 }}>
            <CartesianGrid {...gridStyle} vertical={false} />
            <XAxis dataKey="month" tickFormatter={monthLabel} tick={axisTick} minTickGap={20} />
            <YAxis tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} tick={axisTick} width={52} />
            <Tooltip {...chartTooltip} formatter={(v, name) => [usd(Number(v) * 100), String(name)]} labelFormatter={(m) => monthLabel(String(m))} />
            <Legend wrapperStyle={legendStyle} />
            <Line dataKey="netWorth" name="net worth" stroke={accentColor} strokeWidth={2.5} dot={false} isAnimationActive={false} />
            <Line dataKey="investments" name="investments" stroke={chartColors.up} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line dataKey="cash" name="cash" stroke={chartColors.strain} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line dataKey="cards" name="card debt" stroke={chartColors.down} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {scenario && <Line dataKey="whatif" name="net worth (what-if)" stroke={accentColor} strokeDasharray="6 3" strokeWidth={2} dot={false} isAnimationActive={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {accounts.length > 0 && (
        <p className="mt-2 text-[12px] text-text-tertiary">
          Investments in {result.netWorth.length} months: {accounts.map(([k, v]) => `${k} ${usd(v)}`).join(" · ")}. 5% a year unless set otherwise: an assumption, not a promise.
        </p>
      )}
    </section>
  );
}
