"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TOTAL_KEY, type BudgetLine, type BudgetsResult } from "@/lib/finance-budgets";
import { activeMonthly, type SubscriptionView } from "@/lib/finance-subscriptions";
import InfoHint from "@/components/InfoHint";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { useFinanceAutosave } from "@/lib/use-finance-autosave";
import { Part, PartGrid, PartGroup } from "@/components/personalize/PartGrid";
import type { PageLayout } from "@/lib/personalize-layout";

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

export default function BudgetsView({
  result,
  categories,
  rules,
  setupPending,
  subscriptions,
  onChanged,
  layout,
}: {
  result: BudgetsResult;
  categories: string[];
  rules: { merchantKey: string; category: string }[];
  setupPending: boolean;
  subscriptions: SubscriptionView[];
  /** Re-read the data after a save (the scroll section); without it the server page refreshes. */
  onChanged?: () => void;
  /** The saved Personalize layout read from the page's cookie (the routed page only). */
  layout?: PageLayout;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const e = await fn();
    setBusy(false);
    if (e) setError(e);
    else if (onChanged) onChanged();
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

      {/* Personalize: every tile and card is its own part; parts move within and between the sections below. */}
      <PartGrid page="/financials/budgets" title="Budgets" initial={layout}>
        <PartGroup id="section-month" title="This month">
          <Part id="spent" title="Spent this month" width="quarter">
            <div className={card}>
              <p className="text-[12px] text-text-tertiary">Spent in {monthName} (day {r.dayOfMonth} of {r.daysInMonth})</p>
              <p className="text-xl font-semibold">{usd(t.spentCents)}</p>
              <p className="text-[12px] text-text-secondary">usual by now {usd(t.sameDaysAvgCents)} · last month {usd(t.lastMonthCents)}</p>
            </div>
          </Part>
          <Part id="left" title="Left to spend" width="quarter">
            <div className={card}>
              <p className="text-[12px] text-text-tertiary">Left to spend this month</p>
              <p className={`text-xl font-semibold ${left !== null && left < 0 ? "text-down" : ""}`}>{left === null ? "set a budget" : usd(left)}</p>
              <p className="text-[12px] text-text-secondary">budget {usd(t.budgetCents)}</p>
            </div>
          </Part>
          <Part id="heading-for" title="Heading for, by month end" width="quarter">
            <div className={card}>
              <p className="text-[12px] text-text-tertiary">Heading for, by month end</p>
              <p className={`text-xl font-semibold ${STATUS[t.status].cls}`}>{usd(t.projectedCents)}</p>
              <p className="text-[12px] text-text-secondary">{STATUS[t.status].text} · 3-month average {usd(t.avg3Cents)}</p>
            </div>
          </Part>
          <Part id="income" title="Income this month" width="quarter">
            <div className={card}>
              <p className="text-[12px] text-text-tertiary">Income this month</p>
              <p className="text-xl font-semibold">{usd(r.incomeCents)}</p>
              <p className="text-[12px] text-text-secondary">3-month average {usd(r.incomeAvg3Cents)} · net {usd(r.incomeCents - t.spentCents)}</p>
            </div>
          </Part>
          {r.increases.length > 0 && (
            <Part id="increases" title="Spending more than usual">
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
            </Part>
          )}
        </PartGroup>

        <PartGroup id="section-budgets" title="Budgets by category">
          <Part id="lines" title="Budgets by category">
            <section className={card} aria-labelledby="bd-lines">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h2 id="bd-lines" className="font-semibold">Budgets by category</h2>
                  <InfoHint label="Budgets by category">
                    <p>Suggested = the median of the last 3 months. The grey marker shows where the month is heading at your usual pace; the red one is the budget.</p>
                  </InfoHint>
                </div>
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
          </Part>
        </PartGroup>

        <PartGroup id="section-merchants" title="Subscriptions and merchants">
          <Part id="subscriptions" title="Subscriptions">
            <section className={card} aria-labelledby="bd-subs">
              <div className="flex items-center gap-2">
                <h2 id="bd-subs" className="font-semibold">Subscriptions</h2>
                <InfoHint label="Subscriptions">
                  <p>
                    Detected from repeat charges. To cancel one, cancel it on the merchant&apos;s site, then press I cancelled it: Onyx checks
                    the ledger and tells you whether the charges actually stopped. Onyx never cancels anything itself.
                  </p>
                </InfoHint>
              </div>
              <p className="text-[12px] text-text-tertiary">
                {subscriptions.filter((s) => s.state !== "stopped").length} active, about {usd(activeMonthly(subscriptions))} a month
              </p>
              <table className="mt-2 w-full text-[13px]">
                <tbody>
                  {subscriptions.map((s) => (
                    <tr key={s.id} className="border-t border-border-subtle align-top">
                      <td className="py-1 pr-2">
                        <b>{s.merchant}</b>
                        <div className="text-[12px] text-text-tertiary">
                          {s.cadence} · {usd(s.typicalCents)} · next about {s.nextExpected}
                        </div>
                        {s.stateText && <div className={`text-[12px] ${s.state === "still-charging" ? "text-down" : s.state === "stopped" ? "text-up" : "text-mid"}`}>{s.stateText}</div>}
                      </td>
                      <td className="py-1 pr-2 text-right">{usd(s.monthlyCents)}/mo</td>
                      <td className="whitespace-nowrap py-1 text-right">
                        {s.markedOn ? (
                          <button className={button} disabled={busy} onClick={() => run(() => put("/api/finance/subscriptions", { subId: s.id, cancelling: false }))}>
                            Undo
                          </button>
                        ) : (
                          <>
                            <a className="mr-2 text-[12px] text-accent hover:underline" href={s.cancelSearchUrl} target="_blank" rel="noopener noreferrer">
                              How to cancel
                            </a>
                            <button className={button} disabled={busy} onClick={() => run(() => put("/api/finance/subscriptions", { subId: s.id, cancelling: true }))}>
                              I cancelled it
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </Part>
          <Part id="top-merchants" title="Biggest merchants this month">
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
          </Part>
        </PartGroup>

        <PartGroup id="section-categorize" title="Categorizing">
          <Part id="review" title="Uncategorized merchants">
            <section className={card} aria-labelledby="bd-review">
              <div className="flex items-center gap-2">
                <h2 id="bd-review" className="font-semibold">To review: uncategorized merchants (last 90 days)</h2>
                <InfoHint label="Uncategorized merchants">
                  <p>Always files every transaction from that merchant, past and future, under the category you pick. The bank data itself is not changed.</p>
                </InfoHint>
              </div>
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
          </Part>
          <Part id="rules" title="Merchant rules">
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
          </Part>
        </PartGroup>
      </PartGrid>
    </div>
  );
}

function BudgetRow({ l, busy, run }: { l: BudgetLine; busy: boolean; run: (fn: () => Promise<string | null>) => void }) {
  const [v, setV] = useState(l.budgetCents ? String(Math.round(l.budgetCents / 100)) : "");
  // Autosave (lib/use-finance-autosave.ts): the budget is sent after a pause or when the field is left; blank = none.
  const autosave = useFinanceAutosave<string>(`budget:${l.category}`, run, (x) => {
    const n = Number(x.replace(/[$,\s]/g, ""));
    return put("/api/finance/budgets", { category: l.category, monthlyCents: x.trim() && n > 0 ? Math.round(n * 100) : null });
  }, { baseline: v });
  void busy;
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
        <input className={`${input} w-20 text-right`} inputMode="numeric" value={v} placeholder={String(Math.round(l.suggestedCents / 100))} onChange={(e) => { setV(e.target.value); autosave.change(e.target.value); }} onBlur={() => void autosave.flush()} aria-label={`Budget for ${l.category}`} />
      </td>
      <td className="py-1 pl-2">
        <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} />
      </td>
    </tr>
  );
}

/** Exported for tests/autosave-forms.test.cjs (the overall budget field's save outcomes). */
export function TotalBudget({ current, busy, run }: { current: number | null; busy: boolean; run: (fn: () => Promise<string | null>) => void }) {
  // The field starts empty (the current overall budget is its placeholder). Typing saves after a pause; an empty
  // field changes nothing, 0 clears the overall budget (back to the sum of categories).
  const [v, setV] = useState("");
  const lastSaved = useRef("");
  const autosave = useFinanceAutosave<string>("budget:overall", run, async (x) => {
    const n = Number(x.replace(/[$,\s]/g, ""));
    const err = await put("/api/finance/budgets", { category: TOTAL_KEY, monthlyCents: n > 0 ? Math.round(n * 100) : null });
    if (!err) lastSaved.current = x;
    return err;
  }, { baseline: "" });
  const onOverall = (x: string) => {
    setV(x);
    // Empty is not a value: nothing is sent and the saved budget stays (the last saved value is the baseline again).
    if (x.trim()) autosave.change(x);
    else autosave.reset(lastSaved.current);
  };
  void busy;
  return (
    <span className="flex items-center gap-1 text-[12px] text-text-secondary">
      Overall $
      <input className={`${input} w-24`} inputMode="numeric" value={v} placeholder={current ? String(Math.round(current / 100)) : "sum of categories"} onChange={(e) => onOverall(e.target.value)} onBlur={() => void autosave.flush()} aria-label="Overall budget" title="0 clears the overall budget" />
      <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} />
    </span>
  );
}

function ReviewRow({ m, categories, busy, run }: { m: BudgetsResult["uncategorized"][number]; categories: string[]; busy: boolean; run: (fn: () => Promise<string | null>) => void }) {
  const [cat, setCat] = useState("");
  // Picking a category files every transaction from this merchant under it (the row's only action), saved at once.
  const autosave = useFinanceAutosave<string>(`merchant-rule:${m.key}`, run, (c) => put("/api/finance/categories", { merchantKey: m.key, category: c }), {
    baseline: "",
    delayMs: 400,
    ready: (c) => (c ? null : "Pick a category."),
  });
  void busy;
  return (
    <tr className="border-t border-border-subtle">
      <td className="py-1 pr-2">{m.label}</td>
      <td className="py-1 pr-2 text-right">{usd(m.cents)}</td>
      <td className="py-1 pr-2 text-text-tertiary">{m.count}× · last {m.lastDate}</td>
      <td className="py-1">
        <select className={input} value={cat} onChange={(e) => { setCat(e.target.value); autosave.change(e.target.value); }} aria-label={`Category for ${m.label}`}>
          <option value="">(category)</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>{" "}
        <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} savedText="Always filed here" />
      </td>
    </tr>
  );
}
