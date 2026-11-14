"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TOTAL_KEY, type BudgetLine, type BudgetsResult } from "@/lib/finance-budgets";

const usd = (cents: number | null | undefined) => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "-";
  const v = Math.round(Math.abs(cents) / 100).toLocaleString("en-US");
  return cents < 0 ? `-$${v}` : `$${v}`;
};
const card = "rounded-card shadow-card border border-border-subtle bg-surface-card p-4";
const input = "rounded-control border border-border-subtle bg-transparent px-2 py-1 text-[13px]";
const button = "rounded-control border border-border-subtle px-3 py-1 text-[13px] hover:bg-white/5 disabled:opacity-50";
const STATUS: Record<BudgetLine["status"], { text: string; cls: string }> = {
  over: { text: "over budget", cls: "text-down" },
  "at-risk": { text: "on track to go over", cls: "text-mid" },
  ok: { text: "on track", cls: "text-up" },
  none: { text: "no budget", cls: "text-text-tertiary" },
};

async function put(url: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return j.error ?? `failed (${res.status})`;
  } catch {
    return "network error";
  }
}

export default function BudgetsView({ result, categories, rules, setupPending }: { result: BudgetsResult; categories: string[]; rules: { merchantKey: string; category: string }[]; setupPending: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const e = await fn();
    setBusy(false);
    if (e) setError(e);
    else router.refresh();
  };
  const r = result;
  const t = r.total;
  const left = t.budgetCents !== null ? t.budgetCents - t.spentCents : null;
  const monthName = new Date(`${r.month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const unbudgeted = r.lines.filter((l) => l.budgetCents === null && l.suggestedCents > 0);

  return (
    <div className="space-y-6">
      {setupPending && <p className="text-[13px] text-mid">Budgets could not be read; showing spending only.</p>}
      {error && <p role="alert" className="text-[13px] text-down">Not saved: {error}</p>}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className={card}>
          <p className="text-[12px] text-text-tertiary">Spent in {monthName} (day {r.dayOfMonth} of {r.daysInMonth})</p>
          <p className="text-xl font-semibold">{usd(t.spentCents)}</p>
          <p className="text-[12px] text-text-secondary">usual by now {usd(t.sameDaysAvgCents)} · last month {usd(t.lastMonthCents)}</p>
        </div>
        <div className={card}>
          <p className="text-[12px] text-text-tertiary">Left to spend this month</p>
          <p className={`text-xl font-semibold ${left !== null && left < 0 ? "text-down" : ""}`}>{left === null ? "set a budget" : usd(left)}</p>
          <p className="text-[12px] text-text-secondary">budget {usd(t.budgetCents)}</p>
        </div>
        <div className={card}>
          <p className="text-[12px] text-text-tertiary">Heading for, by month end</p>
          <p className={`text-xl font-semibold ${STATUS[t.status].cls}`}>{usd(t.projectedCents)}</p>
          <p className="text-[12px] text-text-secondary">{STATUS[t.status].text} · 3-month average {usd(t.avg3Cents)}</p>
        </div>
        <div className={card}>
          <p className="text-[12px] text-text-tertiary">Income this month</p>
          <p className="text-xl font-semibold">{usd(r.incomeCents)}</p>
          <p className="text-[12px] text-text-secondary">3-month average {usd(r.incomeAvg3Cents)} · net {usd(r.incomeCents - t.spentCents)}</p>
        </div>
      </section>

      {r.increases.length > 0 && (
        <section className={card} aria-labelledby="bd-up">
          <h2 id="bd-up" className="font-semibold">Spending more than usual</h2>
          <ul className="mt-2 space-y-1 text-[13px]">
            {r.increases.map((x) => (
              <li key={x.category}>
                <b>{x.category}</b>: {usd(x.cents)} so far, against {usd(x.usualCents)} by this day in a usual month ({usd(x.cents - x.usualCents)} more).
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={card} aria-labelledby="bd-lines">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="bd-lines" className="font-semibold">Budgets by category</h2>
          <div className="flex flex-wrap gap-2">
            {unbudgeted.length > 0 && (
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    for (const l of unbudgeted) {
                      const e = await put("/api/finance/budgets", { category: l.category, monthlyCents: l.suggestedCents });
                      if (e) return e;
                    }
                    return null;
                  })
                }
              >
                Use suggested for {unbudgeted.length} categories
              </button>
            )}
            <TotalBudget current={t.budgetCents} busy={busy} run={run} />
          </div>
        </div>
        <p className="text-[12px] text-text-tertiary">Suggested = the median of the last 3 months. The marker shows where the month is heading at your usual pace.</p>
        <table className="mt-2 w-full text-[13px]">
          <thead className="text-[12px] text-text-tertiary">
            <tr>
              <th className="text-left font-normal">Category</th>
              <th className="w-1/3 text-left font-normal">This month</th>
              <th className="text-right font-normal">Spent</th>
              <th className="text-right font-normal">Heading for</th>
              <th className="text-right font-normal">Budget</th>
              <th className="text-left font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l) => (
              <BudgetRow key={l.category} l={l} busy={busy} run={run} />
            ))}
          </tbody>
        </table>
      </section>

      <section className={card} aria-labelledby="bd-top">
        <h2 id="bd-top" className="font-semibold">Biggest merchants this month</h2>
        <table className="mt-2 w-full text-[13px]">
          <tbody>
            {r.topMerchants.map((m) => (
              <tr key={m.key} className="border-t border-border-subtle">
                <td className="py-1">{m.label}</td>
                <td className="py-1 text-text-tertiary">{m.category}</td>
                <td className="py-1 text-right">{usd(m.cents)}</td>
                <td className="py-1 text-right text-text-tertiary">{m.count}×</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={card} aria-labelledby="bd-review">
        <h2 id="bd-review" className="font-semibold">To review: uncategorized merchants (last 90 days)</h2>
        <p className="text-[12px] text-text-tertiary">Pick a category to file every transaction from that merchant, past and future. The bank data itself is not changed.</p>
        {r.uncategorized.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-secondary">Nothing to review.</p>
        ) : (
          <table className="mt-2 w-full text-[13px]">
            <tbody>
              {r.uncategorized.map((m) => (
                <ReviewRow key={m.key} m={m} categories={categories} busy={busy} run={run} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={card} aria-labelledby="bd-rules">
        <h2 id="bd-rules" className="font-semibold">Merchant rules</h2>
        {rules.length === 0 ? (
          <p className="mt-1 text-[13px] text-text-secondary">None yet.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-[13px]">
            {rules.map((x) => (
              <li key={x.merchantKey} className="flex items-center gap-2">
                <span className="text-text-secondary">{x.merchantKey}</span> → <b>{x.category}</b>
                <button className="text-[12px] text-text-tertiary hover:text-down" disabled={busy} onClick={() => run(() => put("/api/finance/categories", { merchantKey: x.merchantKey, category: null }))}>
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function BudgetRow({ l, busy, run }: { l: BudgetLine; busy: boolean; run: (fn: () => Promise<string | null>) => void }) {
  const [v, setV] = useState(l.budgetCents ? String(Math.round(l.budgetCents / 100)) : "");
  const scale = Math.max(l.budgetCents ?? 0, l.projectedCents, l.spentCents, 1);
  const pct = (x: number) => `${Math.min(100, (x / scale) * 100)}%`;
  const color = l.status === "over" ? "bg-down" : l.status === "at-risk" ? "bg-mid" : "bg-accent";
  return (
    <tr className="border-t border-border-subtle">
      <td className="py-1 pr-2">
        {l.category}
        <div className={`text-[11px] ${STATUS[l.status].cls}`}>{STATUS[l.status].text}</div>
      </td>
      <td className="py-1 pr-2">
        <div className="relative h-2 w-full rounded-control bg-white/5">
          <div className={`absolute left-0 top-0 h-2 rounded-control ${color}`} style={{ width: pct(l.spentCents) }} />
          <div className="absolute top-[-3px] h-3.5 w-0.5 bg-text-secondary" style={{ left: pct(l.projectedCents) }} title="heading for" />
          {l.budgetCents && <div className="absolute top-[-3px] h-3.5 w-0.5 bg-down" style={{ left: pct(l.budgetCents) }} title="budget" />}
        </div>
      </td>
      <td className="py-1 text-right">{usd(l.spentCents)}</td>
      <td className="py-1 text-right text-text-secondary">{usd(l.projectedCents)}</td>
      <td className="py-1 text-right">
        <input className={`${input} w-20 text-right`} inputMode="numeric" value={v} placeholder={String(Math.round(l.suggestedCents / 100))} onChange={(e) => setV(e.target.value)} aria-label={`Budget for ${l.category}`} />
      </td>
      <td className="py-1 pl-2">
        <button
          className={button}
          disabled={busy}
          onClick={() => {
            const n = Number(v.replace(/[$,\s]/g, ""));
            run(() => put("/api/finance/budgets", { category: l.category, monthlyCents: v.trim() && n > 0 ? Math.round(n * 100) : null }));
          }}
        >
          Save
        </button>
      </td>
    </tr>
  );
}

function TotalBudget({ current, busy, run }: { current: number | null; busy: boolean; run: (fn: () => Promise<string | null>) => void }) {
  const [v, setV] = useState("");
  return (
    <span className="flex items-center gap-1 text-[12px] text-text-secondary">
      Overall $
      <input className={`${input} w-24`} inputMode="numeric" value={v} placeholder={current ? String(Math.round(current / 100)) : "sum of categories"} onChange={(e) => setV(e.target.value)} />
      <button
        className={button}
        disabled={busy}
        onClick={() => {
          const n = Number(v.replace(/[$,\s]/g, ""));
          run(() => put("/api/finance/budgets", { category: TOTAL_KEY, monthlyCents: v.trim() && n > 0 ? Math.round(n * 100) : null }));
        }}
      >
        Set
      </button>
    </span>
  );
}

function ReviewRow({ m, categories, busy, run }: { m: BudgetsResult["uncategorized"][number]; categories: string[]; busy: boolean; run: (fn: () => Promise<string | null>) => void }) {
  const [cat, setCat] = useState("");
  return (
    <tr className="border-t border-border-subtle">
      <td className="py-1 pr-2">{m.label}</td>
      <td className="py-1 pr-2 text-right">{usd(m.cents)}</td>
      <td className="py-1 pr-2 text-text-tertiary">{m.count}× · last {m.lastDate}</td>
      <td className="py-1">
        <select className={input} value={cat} onChange={(e) => setCat(e.target.value)} aria-label={`Category for ${m.label}`}>
          <option value="">(category)</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>{" "}
        <button className={button} disabled={busy || !cat} onClick={() => run(() => put("/api/finance/categories", { merchantKey: m.key, category: cat }))}>
          Always
        </button>
      </td>
    </tr>
  );
}
