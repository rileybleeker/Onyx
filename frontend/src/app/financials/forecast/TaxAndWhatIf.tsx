"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ForecastResult } from "@/lib/cash-forecast";
import { eligibilityOf, safeToMoveOf } from "@/lib/cash-forecast-eligibility";
import { scenarioToQuery, type ScenarioParams } from "@/lib/cash-forecast-scenario";
import type { ForecastAccountView } from "@/lib/cash-forecast-server";
import type { Jur, TaxProfile, TaxYearResult } from "@/lib/tax-plan";
import InfoHint from "@/components/InfoHint";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { useFinanceAutosave } from "@/lib/use-finance-autosave";

const usd = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "-";
  const v = Math.round(Math.abs(cents) / 100).toLocaleString("en-US");
  return cents < 0 ? `-$${v}` : `$${v}`;
};
const card = "rounded-card shadow-card border border-border-subtle bg-surface-card p-4";
const input = "rounded-control border border-border-subtle bg-transparent px-2 py-1 text-[13px]";
const button = "rounded-control border border-border-subtle px-3 py-1 text-[13px] hover:bg-white/5 disabled:opacity-50";
type Run = (fn: () => Promise<string | null>) => void;
const FORECAST_PATH = "/financials/forecast";

async function put(key: string, value: unknown): Promise<string | null> {
  try {
    const res = await fetch("/api/finance/forecast/drivers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) });
    if (res.ok) return null;
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return j.error ?? `failed (${res.status})`;
  } catch {
    return "network error";
  }
}
const dollars = (s: string): number | undefined => {
  const n = Number(s.replace(/[$,\s]/g, ""));
  return s.trim() === "" || !Number.isFinite(n) ? undefined : n;
};

// ─── What-if ──────────────────────────────────────────────────────────────────────────────────

export function WhatIfPanel({ params, accounts, saved, busy, run }: { params: ScenarioParams | null; accounts: ForecastAccountView[]; saved: { slug: string; name: string; params: ScenarioParams }[]; busy: boolean; run: Run }) {
  const router = useRouter();
  // Always the routed page: in the continuous scroll the address follows whichever page is in view, and a
  // what-if (levers in the query) is only computed by the routed page.
  const pathname = FORECAST_PATH;
  const p = params ?? {};
  const [f, setF] = useState<Record<string, string>>({
    bonusPct: p.bonusPct?.toString() ?? "100",
    bonusShiftMonths: p.bonusShiftMonths?.toString() ?? "0",
    moveDate: p.moveDate ?? "",
    rentChange: p.rentChange?.toString() ?? "",
    movingCosts: p.movingCosts?.toString() ?? "",
    spendChange: p.spendChange?.toString() ?? "",
    payoffCard: p.payoffCard ?? "",
    payoffAmount: p.payoffAmount?.toString() ?? "",
    payoffDate: p.payoffDate ?? "",
    otherIncome: p.otherIncome?.toString() ?? "",
    otherIncomeStart: p.otherIncomeStart ?? "",
    preTax: p.preTax?.toString() ?? "",
  });
  const [name, setName] = useState("");
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const levers = (): ScenarioParams => {
    const out: ScenarioParams = {};
    const n = (k: keyof ScenarioParams, skip?: number) => {
      const v = dollars(f[k as string] ?? "");
      if (v !== undefined && v !== skip) (out as Record<string, unknown>)[k] = v;
    };
    n("bonusPct", 100);
    n("bonusShiftMonths", 0);
    n("rentChange", 0);
    n("movingCosts", 0);
    n("spendChange", 0);
    n("payoffAmount", 0);
    n("otherIncome");
    n("preTax");
    if (f.moveDate) out.moveDate = f.moveDate;
    if (f.payoffCard && out.payoffAmount) out.payoffCard = f.payoffCard;
    if (f.payoffDate && out.payoffAmount) out.payoffDate = f.payoffDate;
    if (f.otherIncomeStart && out.otherIncome !== undefined) out.otherIncomeStart = f.otherIncomeStart;
    return out;
  };
  const apply = () => {
    const q = scenarioToQuery(levers());
    router.push(q ? `${pathname}?${q}` : pathname);
  };
  const cards = accounts.filter((a) => a.type === "card");
  const field = (label: string, k: string, ph = "", type = "text", w = "w-24") => (
    <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
      {label}
      <input className={`${input} ${w}`} type={type} value={f[k]} onChange={set(k)} placeholder={ph} inputMode={type === "text" ? "decimal" : undefined} />
    </label>
  );
  return (
    <section className={`${card} ${params ? "border-accent/40" : ""}`} aria-labelledby="fc-whatif">
      <div className="flex items-center gap-2">
        <h2 id="fc-whatif" className="font-semibold">What if</h2>
        <InfoHint label="What if">
          <p>Change a lever and press Show: the page recomputes cash, net worth and taxes and compares them with the base plan. The base plan is not changed.</p>
        </InfoHint>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        {field("Bonus % of plan", "bonusPct", "100", "text", "w-20")}
        {field("Bonus later by (months)", "bonusShiftMonths", "0", "text", "w-20")}
        {field("Move to NYC on", "moveDate", "", "date", "w-36")}
        {field("Rent change after move ($/mo)", "rentChange", "e.g. 1500")}
        {field("Moving costs ($)", "movingCosts", "e.g. 6000")}
        {field("Spending change ($/mo)", "spendChange", "+ or -")}
        {field("Other / 1099 income ($/yr)", "otherIncome", "0")}
        {field("Starting (default next month)", "otherIncomeStart", "", "date", "w-36")}
        {field("401(k) / pre-tax ($/yr)", "preTax", "0")}
        <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
          Extra card payment
          <select className={input} value={f.payoffCard} onChange={set("payoffCard")}>
            <option value="">(card)</option>
            {cards.map((a) => (
              <option key={a.account_key} value={a.account_key}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        {field("Amount ($)", "payoffAmount", "e.g. 28000")}
        {field("On", "payoffDate", "", "date", "w-36")}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className={button} onClick={apply}>
          Show
        </button>
        {params && (
          <button className={button} onClick={() => router.push(pathname)}>
            Back to base plan
          </button>
        )}
        {params && (
          <>
            <input className={input} placeholder="Name this scenario" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <button
              className={button}
              disabled={busy || !name.trim()}
              onClick={() => {
                const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "scenario";
                run(() => put(`scenario:${slug}`, { name: name.trim(), params }));
              }}
            >
              Save
            </button>
          </>
        )}
      </div>
      {saved.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2 text-[13px]">
          {saved.map((s) => (
            <li key={s.slug} className="flex items-center gap-1">
              <a className={`${button} inline-block`} href={`${pathname}?${scenarioToQuery(s.params)}`}>
                {s.name}
              </a>
              <button className="text-[12px] text-text-tertiary hover:text-down" disabled={busy} onClick={() => run(() => put(`scenario:${s.slug}`, null))} aria-label={`Delete ${s.name}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const taxDue = (tax: TaxYearResult[], year: number) => tax.find((t) => t.year === year)?.jurisdictions.reduce((s, j) => s + Math.max(0, j.balanceCents), 0) ?? 0;
const refunds = (tax: TaxYearResult[], year: number) => tax.find((t) => t.year === year)?.jurisdictions.reduce((s, j) => s + Math.max(0, -j.balanceCents), 0) ?? 0;

export function CompareTable({
  base,
  baseTax,
  scen,
  scenTax,
  now,
}: {
  base: ForecastResult;
  baseTax: TaxYearResult[];
  scen: ForecastResult;
  scenTax: TaxYearResult[];
  /** The browser's clock (ms) once mounted: a check that has expired since the forecast was computed withholds the amount. */
  now?: number;
}) {
  const y = Number(base.today.slice(0, 4));
  const interest = (r: ForecastResult) => r.cards.reduce((s, c) => s + c.interestNext12Cents, 0);
  // Safe to move uses the same gate as the headline tile: null = withheld (incomplete or stale inputs).
  const withheld = Array.from(new Set([...eligibilityOf(base, now).reasons, ...eligibilityOf(scen, now).reasons].map((r) => r.text)));
  const rows: [string, number | null | undefined, number | null | undefined][] = [
    ["Lowest point, 13 weeks (cautious)", base.headlines.lowest?.cents, scen.headlines.lowest?.cents],
    ["Safe to move", safeToMoveOf(base, now), safeToMoveOf(scen, now)],
    ["Cash in 13 weeks (likely)", base.headlines.end13w?.likely, scen.headlines.end13w?.likely],
    ["Cash in 12 months (likely)", base.headlines.end12m?.likely, scen.headlines.end12m?.likely],
    ["Net worth in 12 months", base.netWorth[11]?.netWorth, scen.netWorth[11]?.netWorth],
    ["Card interest, next 12 months", interest(base), interest(scen)],
    [`Tax still to pay for ${y}`, taxDue(baseTax, y), taxDue(scenTax, y)],
    [`Tax still to pay for ${y + 1}`, taxDue(baseTax, y + 1), taxDue(scenTax, y + 1)],
    [`Refunds expected for ${y} + ${y + 1}`, refunds(baseTax, y) + refunds(baseTax, y + 1), refunds(scenTax, y) + refunds(scenTax, y + 1)],
  ];
  return (
    <section className={card} aria-labelledby="fc-compare">
      <h2 id="fc-compare" className="font-semibold">Base plan vs what-if</h2>
      <table className="mt-2 w-full text-[13px]">
        <thead className="text-[12px] text-text-tertiary">
          <tr>
            <th className="text-left font-normal"></th>
            <th className="text-right font-normal">Base</th>
            <th className="text-right font-normal">What-if (estimate)</th>
            <th className="text-right font-normal">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, a, b]) => {
            // null (only safe to move uses it) = withheld: no amount and no change.
            const diff = a === null || b === null ? 0 : (b ?? 0) - (a ?? 0);
            return (
              <tr key={label} className="border-t border-border-subtle">
                <td className="py-1">{label}</td>
                <td className="py-1 text-right">{a === null ? "not available" : usd(a)}</td>
                <td className="py-1 text-right font-semibold">{b === null ? "not available" : usd(b)}</td>
                <td className={`py-1 text-right ${diff > 0 ? "text-up" : diff < 0 ? "text-down" : "text-text-tertiary"}`}>{diff === 0 ? "-" : `${diff > 0 ? "+" : ""}${usd(diff)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {withheld.length > 0 && <p className="mt-2 text-[12px] text-mid">Safe to move is not available: {withheld.slice(0, 3).join(" ")}</p>}
      <p className="mt-2 text-[12px] text-text-tertiary">Colors follow cash; for tax and interest rows lower is better.</p>
    </section>
  );
}

// ─── Taxes ────────────────────────────────────────────────────────────────────────────────────

export function TaxSection({ tax, profile, busy, run }: { tax: TaxYearResult[]; profile: TaxProfile | null; busy: boolean; run: Run }) {
  // The "tables last checked over a year ago" line is the same for every year: shown once, above the years.
  const review = tax.find((t) => t.tablesReview)?.tablesReview ?? null;
  return (
    <section className={card} aria-labelledby="fc-tax">
      <div className="flex items-center gap-2">
        <h2 id="fc-tax" className="font-semibold">Taxes</h2>
        <InfoHint label="Taxes">
          <p>Planning estimates, not a filed return. The payments below are already in the cash forecast.</p>
        </InfoHint>
      </div>
      {!profile && <p className="mt-2 text-[13px] text-mid">No tax profile yet: fill in the form below.</p>}
      {review && <p className="mt-2 text-[12px] text-mid">{review}</p>}
      {tax.map((t) => (
        <div key={t.year} className="mt-4">
          <h3 className="font-semibold">{t.year}</h3>
          <p className="text-[12px] text-text-secondary">Wages {usd(t.wagesCents)} · income for tax {usd(t.agiCents)}</p>
          <table className="mt-1 w-full text-[13px]">
            <thead className="text-[12px] text-text-tertiary">
              <tr>
                <th className="text-left font-normal"></th>
                <th className="text-right font-normal">Tax</th>
                <th className="text-right font-normal">Withheld</th>
                <th className="text-right font-normal">Paid</th>
                <th className="text-right font-normal">Still owed / refund</th>
              </tr>
            </thead>
            <tbody>
              {t.jurisdictions.map((j) => (
                <tr key={j.jur} className="border-t border-border-subtle">
                  <td className="py-1">{j.label}</td>
                  <td className="py-1 text-right">{usd(j.taxCents)}</td>
                  <td className="py-1 text-right">{usd(j.withheldCents)}</td>
                  <td className="py-1 text-right">{usd(j.estimatesPaidCents)}</td>
                  <td className={`py-1 text-right font-semibold ${j.balanceCents > 0 ? "text-down" : j.balanceCents < 0 ? "text-up" : ""}`}>
                    {j.balanceCents > 0 ? `owe ${usd(j.balanceCents)}` : j.balanceCents < 0 ? `refund ${usd(-j.balanceCents)}` : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {t.payments.length > 0 && (
            <ul className="mt-2 space-y-1 text-[13px]">
              {t.payments.map((p) => (
                <li key={`${p.jur}-${p.date}`}>
                  {p.date}: {p.label} <b className={p.cents > 0 ? "text-up" : ""}>{p.cents > 0 ? `+${usd(p.cents)}` : usd(p.cents)}</b>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[12px] text-text-secondary">
            Federal safe harbour ({t.safeHarbor.basis}): {usd(t.safeHarbor.coveredCents)} of {usd(t.safeHarbor.requiredCents)} {t.safeHarbor.met ? "covered" : "- not covered yet"}.
          </p>
          {t.fixes.map((x) => (
            <p key={x} className="text-[12px] text-mid">
              {x}
            </p>
          ))}
          <TaxRules t={t} />
          <details className="mt-1 text-[12px] text-text-tertiary">
            <summary>Assumptions</summary>
            <ul className="mt-1 space-y-1">
              {t.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </details>
        </div>
      ))}
      <TaxProfileForm profile={profile} busy={busy} run={run} />
    </section>
  );
}

const BASIS_LABEL: Record<string, string> = { published: "published", assumption: "assumption", override: "your entry" };

/**
 * Where the year's tax figures come from: one line naming each jurisdiction's basis (published / assumption / your
 * entry), a visible warning when a built-in table should have been updated, and the figures, sources and limits
 * behind a disclosure. Older stored results have no `rules`: nothing is shown for them.
 */
function TaxRules({ t }: { t: TaxYearResult }) {
  const rules = t.rules ?? [];
  if (!rules.length) return null;
  return (
    <>
      <p className="mt-1 text-[12px] text-text-secondary">
        Tax figures:{" "}
        {rules.map((r, i) => (
          <span key={r.jur}>
            {i > 0 && " · "}
            {r.label} <span className={r.basis === "published" ? "text-text-tertiary" : "text-mid"}>{BASIS_LABEL[r.basis] ?? r.basis}</span>
          </span>
        ))}
      </p>
      {(t.stale ?? []).map((s) => (
        <p key={s} className="text-[12px] text-mid">
          {s}
        </p>
      ))}
      <details className="mt-1 text-[12px] text-text-tertiary">
        <summary>Tax tables and limits</summary>
        <ul className="mt-1 space-y-1">
          {rules.map((r) => (
            <li key={r.jur}>
              <span className="text-text-secondary">
                {r.label} ({BASIS_LABEL[r.basis] ?? r.basis}):
              </span>{" "}
              {r.figures}.{r.note ? ` ${r.note}` : ""}
              {r.sources.length > 0 && (
                <span>
                  {" "}
                  Sources:{" "}
                  {r.sources.map((s, i) => (
                    <span key={s.url + s.title}>
                      {i > 0 && "; "}
                      <a className="underline hover:text-text-secondary" href={s.url} target="_blank" rel="noreferrer noopener">
                        {s.title}
                      </a>{" "}
                      ({s.effective}; checked {s.retrieved})
                    </span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2">Built-in tables last checked {t.tablesChecked}. How the estimate works and what it leaves out:</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {(t.limitations ?? []).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
    </>
  );
}

const JURS: Jur[] = ["federal", "GA", "NC", "NY", "NYC"];

function TaxProfileForm({ profile, busy, run }: { profile: TaxProfile | null; busy: boolean; run: Run }) {
  const p = profile;
  const $ = (cents: number | undefined | null) => (cents ? String(Math.round(cents / 100)) : "");
  const [f, setF] = useState<Record<string, string>>({
    salary: $(p?.salaryAnnualCents) || "",
    start: p?.employmentStart ?? "",
    move: p?.moveDate ?? "",
    nc: p ? String(p.ncWorkSharePct) : "0",
    preTax: $(p?.preTaxAnnualCents),
    other: $(p?.otherIncomeAnnualCents),
    ytdAsOf: p?.ytd?.asOf ?? "",
    ytdFed: $(p?.ytd?.federalCents),
    ytdState: $(p?.ytd?.stateCents),
    priorTax: $(p?.priorYear?.federalTaxCents),
    priorAgi: $(p?.priorYear?.agiCents),
    abAmount: $(p?.annualBonus?.amountCents),
    abProfit: $(p?.annualBonus?.profitShareCents),
    abGrowth: p?.annualBonus ? String(p.annualBonus.growthPct) : "0",
    abFirst: p?.annualBonus ? String(p.annualBonus.firstPlanYear) : "",
    raise: p?.raisePct ? String(p.raisePct) : "0",
    index: p?.bracketIndexPct !== undefined ? String(p.bracketIndexPct) : "",
    gaRate: typeof p?.gaRatePct === "number" ? String(p.gaRatePct) : "",
    ncRate: typeof p?.ncRatePct === "number" ? String(p.ncRatePct) : "",
    withholds: p?.employerStateWithholding ?? "NC",
  });
  const [oneOffs, setOneOffsState] = useState(p?.oneOffs.map((o) => ({ date: o.date, gross: String(Math.round(o.grossCents / 100)), label: o.label })) ?? []);
  const [est, setEst] = useState({ jur: "GA" as Jur, date: "", amount: "" });
  // Payments recorded so far, kept here so an autosave of the profile never drops one the page has not re-read yet.
  const paid = useRef(p?.estimatesPaid ?? []);
  // While a payment is being recorded nothing else is sent (both write the whole profile).
  const paying = useRef(false);
  const cents = (s: string) => Math.round((dollars(s) ?? 0) * 100);
  type ProfileForm = { f: Record<string, string>; oneOffs: { date: string; gross: string; label: string }[] };
  // Autosave (lib/use-finance-autosave.ts): the profile is sent after a pause or when a field is left, once it has
  // a salary and a job start date, then the forecast re-reads. Recording a payment stays a button (it adds an event).
  const autosave = useFinanceAutosave<ProfileForm>("forecast-tax", run, (v) => put("tax", buildFrom(v.f, v.oneOffs)), {
    ready: (v) => (paying.current ? "Recording the payment…" : v.f.salary && v.f.start ? null : "Enter the salary and the job start date to save the tax profile."),
    baseline: { f, oneOffs },
  });
  const latest = useRef<ProfileForm>({ f, oneOffs });
  const set = (k: string) => (e: { target: { value: string } }) => {
    const next = { ...f, [k]: e.target.value };
    setF(next);
    latest.current = { f: next, oneOffs };
    autosave.change(latest.current);
  };
  const setOneOffs = (fn: (xs: typeof oneOffs) => typeof oneOffs) => {
    const next = fn(oneOffs);
    setOneOffsState(next);
    latest.current = { f, oneOffs: next };
    autosave.change(latest.current);
  };
  const buildFrom = (f: Record<string, string>, oneOffs: { date: string; gross: string; label: string }[], extraEstimate?: { jur: Jur; date: string; cents: number }) => ({
    salaryAnnualCents: cents(f.salary),
    employmentStart: f.start,
    moveDate: f.move || null,
    ncWorkSharePct: dollars(f.nc) ?? 0,
    preTaxAnnualCents: cents(f.preTax),
    otherIncomeAnnualCents: cents(f.other),
    oneOffs: oneOffs.filter((o) => o.date && (dollars(o.gross) ?? 0) > 0).map((o) => ({ date: o.date, grossCents: cents(o.gross), label: o.label || "Bonus" })),
    ytd: f.ytdAsOf ? { year: Number(f.ytdAsOf.slice(0, 4)), asOf: f.ytdAsOf, federalCents: cents(f.ytdFed), stateCents: cents(f.ytdState) } : null,
    priorYear: dollars(f.priorTax) ? { year: Number((f.start || "2026").slice(0, 4)) - 1, federalTaxCents: cents(f.priorTax), agiCents: cents(f.priorAgi) } : null,
    annualBonus: f.abFirst && (dollars(f.abAmount) || dollars(f.abProfit))
      ? { amountCents: cents(f.abAmount), profitShareCents: cents(f.abProfit), growthPct: dollars(f.abGrowth) ?? 0, firstPlanYear: Number(f.abFirst) }
      : null,
    raisePct: dollars(f.raise) ?? 0,
    ...(f.index.trim() ? { bracketIndexPct: dollars(f.index) ?? 0 } : {}),
    gaRatePct: f.gaRate.trim() ? (dollars(f.gaRate) ?? null) : null,
    ncRatePct: f.ncRate.trim() ? (dollars(f.ncRate) ?? null) : null,
    employerStateWithholding: f.withholds === "none" ? "none" : "NC",
    estimatesPaid: [...paid.current, ...(extraEstimate ? [estimateOf(extraEstimate)] : [])],
  });
  const estimateOf = (e: { jur: Jur; date: string; cents: number }) => ({ year: Number(e.date.slice(0, 4)) - (e.date.slice(5, 7) === "01" ? 1 : 0), ...e });
  const field = (label: string, k: string, type = "text", w = "w-28", ph = "") => (
    <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
      {label}
      <input className={`${input} ${w}`} type={type} value={f[k]} onChange={set(k)} onBlur={() => void autosave.flush()} placeholder={ph} />
    </label>
  );
  return (
    <details className="mt-4" open={!profile}>
      <summary className="cursor-pointer text-[13px] font-semibold">Tax profile and payments</summary>
      <div className="mt-2 flex flex-wrap gap-3">
        {field("Salary ($/yr)", "salary")}
        {field("Job start date", "start", "date", "w-36")}
        {field("NYC move date", "move", "date", "w-36")}
        {field("% of work days in NC", "nc", "text", "w-20")}
        {field("401(k) / pre-tax ($/yr)", "preTax")}
        {field("Other / 1099 income ($/yr)", "other")}
        {field("Pay stub: as of", "ytdAsOf", "date", "w-36")}
        {field("YTD federal withheld ($)", "ytdFed")}
        {field("YTD NC withheld ($)", "ytdState")}
        {field("Last year's federal tax ($)", "priorTax")}
        {field("Last year's AGI ($)", "priorAgi")}
        {field("Raise each January (%)", "raise", "text", "w-20")}
      </div>
      <p className="mt-3 text-[12px] text-text-secondary">Tax rules (blank = the built-in tables; an entry is shown as &quot;your entry&quot;):</p>
      <div className="mt-1 flex flex-wrap gap-3">
        {field("Federal brackets rise (%/yr, unpublished years)", "index", "text", "w-20", "2.7")}
        {field("Georgia rate (%)", "gaRate", "text", "w-20", "4.99")}
        {field("NC rate (%)", "ncRate", "text", "w-20", "3.99")}
        <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
          Employer withholds state tax for
          <select className={input} value={f.withholds} onChange={set("withholds")}>
            <option value="NC">North Carolina</option>
            <option value="none">no state</option>
          </select>
        </label>
      </div>
      <p className="mt-3 text-[12px] text-text-secondary">Every year&apos;s bonus (paid each January for the year before):</p>
      <div className="mt-1 flex flex-wrap gap-3">
        {field("Bonus ($/yr, gross)", "abAmount")}
        {field("Profit share ($/yr)", "abProfit")}
        {field("Bonus growth (%/yr)", "abGrowth", "text", "w-20")}
        {field("First plan year", "abFirst", "text", "w-20")}
      </div>
      <p className="mt-3 text-[12px] text-text-secondary">One-off pay (gross; a January &quot;bonus&quot; here replaces that year&apos;s generated bonus):</p>
      {oneOffs.map((o, i) => (
        <div key={i} className="mt-1 flex flex-wrap items-center gap-2">
          <input aria-label="One-off pay label" className={`${input} w-40`} value={o.label} onChange={(e) => setOneOffs((xs) => xs.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} />
          <input aria-label="One-off pay date" className={input} type="date" value={o.date} onChange={(e) => setOneOffs((xs) => xs.map((x, k) => (k === i ? { ...x, date: e.target.value } : x)))} />
          <input aria-label="One-off pay gross" className={`${input} w-28`} value={o.gross} onChange={(e) => setOneOffs((xs) => xs.map((x, k) => (k === i ? { ...x, gross: e.target.value } : x)))} />
          <button className="text-[12px] text-text-tertiary hover:text-down" onClick={() => setOneOffs((xs) => xs.filter((_, k) => k !== i))}>
            remove
          </button>
        </div>
      ))}
      <button className={`${button} mt-1`} onClick={() => setOneOffs((xs) => [...xs, { date: "", gross: "", label: "Bonus" }])}>
        + one-off pay
      </button>
      <div className="mt-3">
        <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} showIncomplete={Object.values(f).some((x) => x.trim() && x !== "0" && x !== "NC")} />
      </div>
      <p className="mt-4 text-[12px] text-text-secondary">Record an estimated payment you made:</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <select aria-label="Estimated tax jurisdiction" className={input} value={est.jur} onChange={(e) => setEst((x) => ({ ...x, jur: e.target.value as Jur }))}>
          {JURS.map((j) => (
            <option key={j} value={j}>
              {j}
            </option>
          ))}
        </select>
        <input aria-label="Estimated tax date" className={input} type="date" value={est.date} onChange={(e) => setEst((x) => ({ ...x, date: e.target.value }))} />
        <input aria-label="Estimated tax amount" className={`${input} w-28`} placeholder="$ amount" value={est.amount} onChange={(e) => setEst((x) => ({ ...x, amount: e.target.value }))} />
        <button
          className={button}
          disabled={busy || !profile || !est.date || !(dollars(est.amount) ?? 0)}
          onClick={() => {
            const extra = { jur: est.jur, date: est.date, cents: cents(est.amount) };
            run(async () => {
              // What was waiting goes first; then the payment, with the profile as shown, in one write.
              await autosave.flush();
              paying.current = true;
              const value = latest.current;
              const e = await put("tax", buildFrom(value.f, value.oneOffs, extra));
              paying.current = false;
              if (!e) {
                paid.current = [...paid.current, estimateOf(extra)];
                autosave.setBaseline(value);
              }
              autosave.change(latest.current); // anything typed meanwhile (nothing is sent if it is unchanged)
              return e;
            });
          }}
        >
          Record payment
        </button>
      </div>
      {(p?.estimatesPaid.length ?? 0) > 0 && (
        <ul className="mt-2 text-[12px] text-text-secondary">
          {p!.estimatesPaid.map((e, i) => (
            <li key={i}>
              {e.date} · {e.jur} · {usd(e.cents)} (for {e.year})
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
