/**
 * Tax planning engine (docs/cash-flow-forecast.md, Section 7). PURE: no I/O, no clock (callers pass `today`).
 * Planning estimates for one single filer who lives in Georgia, works for an employer that withholds North
 * Carolina tax, and may move to New York City: federal tax, Georgia (resident part of the year), North Carolina
 * (nonresident, on days physically worked there), New York + NYC (resident part of the year), what is withheld,
 * the safe harbour, and the payments that close each gap, as dated cash lines for the forecast.
 * Not a filed return: no itemizing, credits, AMT or equity; FICA is assumed to be withheld exactly.
 */
import { lastBusinessDayOfMonth, type PlannedItem } from "./cash-forecast";
import { bracketTax, marginalRate, taxTables } from "./tax-tables";

export type Jur = "federal" | "GA" | "NC" | "NY" | "NYC";
export const JUR_LABEL: Record<Jur, string> = { federal: "Federal", GA: "Georgia", NC: "North Carolina", NY: "New York State", NYC: "New York City" };

export interface TaxOneOff {
  date: string;
  grossCents: number;
  label: string;
}
export interface TaxProfile {
  salaryAnnualCents: number;
  employmentStart: string;
  /** Supplemental wages: bonus, profit share, signing bonus (gross). */
  oneOffs: TaxOneOff[];
  /** The day Riley becomes a New York (and NYC) resident; null = stays in Georgia. */
  moveDate: string | null;
  /** Share of work days physically in North Carolina (0-100). */
  ncWorkSharePct: number;
  preTaxAnnualCents: number;
  otherIncomeAnnualCents: number;
  /** Year-to-date withholding from a pay stub. */
  ytd: { year: number; asOf: string; federalCents: number; stateCents: number } | null;
  priorYear: { year: number; federalTaxCents: number; agiCents: number } | null;
  estimatesPaid: { year: number; jur: Jur; date: string; cents: number }[];
  /**
   * The bonus every year, not just the next one: for each plan year from firstPlanYear on, a bonus (and profit
   * share) paid on the last business day of the following January, growing growthPct a year. A January one-off
   * labelled "bonus" in oneOffs replaces the generated one for that year.
   */
  annualBonus?: { amountCents: number; profitShareCents: number; growthPct: number; firstPlanYear: number } | null;
  /** Salary raise each January after the start year (percent). */
  raisePct?: number;
}

const PROJECT_YEARS = 4;
/** Salary for a calendar year, with the annual raise from the start year on. */
export function salaryFor(profile: TaxProfile, year: number): number {
  const startYear = Number(profile.employmentStart.slice(0, 4));
  const r = Math.max(0, profile.raisePct ?? 0) / 100;
  return Math.round(profile.salaryAnnualCents * Math.pow(1 + r, Math.max(0, year - startYear)));
}
/** Every supplemental payment: the explicit one-offs plus the generated annual bonuses and profit shares. */
export function allOneOffs(profile: TaxProfile): TaxOneOff[] {
  const out = [...profile.oneOffs];
  const ab = profile.annualBonus;
  if (ab && (ab.amountCents > 0 || ab.profitShareCents > 0)) {
    for (let k = 0; k < PROJECT_YEARS; k++) {
      const plan = ab.firstPlanYear + k;
      const payYear = plan + 1;
      const hasExplicit = profile.oneOffs.some((o) => o.date.startsWith(`${payYear}-01`) && /bonus/i.test(o.label));
      if (hasExplicit) continue;
      const g = Math.pow(1 + (ab.growthPct ?? 0) / 100, k);
      const date = lastBusinessDayOfMonth(payYear, 1);
      if (ab.amountCents > 0) out.push({ date, grossCents: Math.round(ab.amountCents * g), label: `Annual bonus (${plan} plan year)` });
      if (ab.profitShareCents > 0) out.push({ date, grossCents: Math.round(ab.profitShareCents * g), label: `Profit share (${plan} plan year)` });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface TaxJurResult {
  jur: Jur;
  label: string;
  incomeCents: number;
  taxCents: number;
  withheldCents: number;
  estimatesPaidCents: number;
  /** Positive = still owed, negative = refund due. */
  balanceCents: number;
}
export interface TaxPayment {
  year: number;
  jur: Jur;
  label: string;
  date: string;
  /** Balance-positive: a payment is -, a refund is +. */
  cents: number;
  kind: "estimate" | "refund";
}
export interface TaxYearResult {
  year: number;
  wagesCents: number;
  agiCents: number;
  jurisdictions: TaxJurResult[];
  payments: TaxPayment[];
  safeHarbor: { requiredCents: number; coveredCents: number; met: boolean; basis: string };
  fixes: string[];
  assumptions: string[];
}

const c = (dollars: number): number => Math.round(dollars * 100);
const d = (cents: number): number => cents / 100;
const iso = (y: number, m: number, day: number) => `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const usd = (cents: number) => `$${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;

interface Wage {
  date: string;
  cents: number;
  supplemental: boolean;
  label: string;
}
/** Monthly salary on the last business day (the first month prorated by start day), plus the one-offs. */
export function wagesFor(profile: TaxProfile, year: number): Wage[] {
  const out: Wage[] = [];
  const monthly = salaryFor(profile, year) / 12;
  const start = profile.employmentStart;
  for (let m = 1; m <= 12; m++) {
    const pay = lastBusinessDayOfMonth(year, m);
    const monthStart = iso(year, m, 1);
    const monthEnd = iso(year, m, daysIn(year, m));
    if (start > monthEnd) continue;
    const share = start > monthStart ? (daysIn(year, m) - Number(start.slice(8, 10)) + 1) / daysIn(year, m) : 1;
    out.push({ date: pay, cents: Math.round(monthly * share), supplemental: false, label: "salary" });
  }
  for (const o of allOneOffs(profile)) if (o.date.startsWith(`${year}-`) && o.grossCents > 0) out.push({ date: o.date, cents: o.grossCents, supplemental: true, label: o.label });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Net cash of one supplemental payment: federal flat rate, Social Security up to the wage base, Medicare, NC supplemental. */
export function oneOffNetCents(profile: TaxProfile, oneOff: TaxOneOff): number {
  const year = Number(oneOff.date.slice(0, 4));
  const t = taxTables(year);
  const before = wagesFor(profile, year).filter((w) => w.date < oneOff.date || (w.date === oneOff.date && !w.supplemental)).reduce((s, w) => s + w.cents, 0);
  const g = oneOff.grossCents;
  const ssRoom = Math.max(0, c(t.federal.ssWageBase) - before);
  const ss = Math.min(g, ssRoom) * (t.federal.ssRate / 100);
  const overAddl = Math.max(0, before + g - c(t.federal.addlMedicareThreshold)) - Math.max(0, before - c(t.federal.addlMedicareThreshold));
  const medicare = g * (t.federal.medicareRate / 100) + Math.max(0, overAddl) * (t.federal.addlMedicareRate / 100);
  const fed = g * (t.federal.supplementalRate / 100);
  const nc = g * (t.nc.supplementalRate / 100);
  return Math.round(g - fed - ss - medicare - nc);
}

const DUE = (year: number) => [`${year}-04-15`, `${year}-06-15`, `${year}-09-15`, `${year + 1}-01-15`];

export function computeTaxYear(profile: TaxProfile, year: number, today: string): TaxYearResult {
  const t = taxTables(year);
  const assumptions: string[] = [];
  if (t.estimated) assumptions.push(t.estimated);
  assumptions.push(t.ga.note, `North Carolina ${t.nc.rate}% (nonresident, on the share of days worked there).`, `New York: ${t.ny.note}`);
  const wages = wagesFor(profile, year);
  const W = wages.reduce((s, w) => s + w.cents, 0);
  const preTax = Math.min(profile.preTaxAnnualCents, W);
  const other = profile.otherIncomeAnnualCents;
  const agi = Math.max(0, W - preTax + other);
  const isNY = (date: string) => !!profile.moveDate && date >= profile.moveDate;
  const nyMonths = profile.moveDate && profile.moveDate.startsWith(`${year}-`) ? 12 - Number(profile.moveDate.slice(5, 7)) + 1 : profile.moveDate && profile.moveDate < `${year}-01-01` ? 12 : 0;
  const preTaxShare = W > 0 ? preTax / W : 0;

  // Federal.
  const taxable = Math.max(0, d(agi) - t.federal.standardDeduction);
  const fedIncomeTax = c(bracketTax(taxable, t.federal.single));
  const seRate = d(W) >= t.federal.ssWageBase ? 0.029 : 0.153;
  const seTax = Math.round(other * 0.9235 * seRate);
  const fedTax = fedIncomeTax + seTax;
  if (other > 0) assumptions.push(`Other (1099) income ${usd(other)} adds self-employment tax at ${(seRate * 100).toFixed(1)}%.`);

  // Withholding, projected: a pay stub's year-to-date figure plus the paychecks after it, else estimated from the start.
  const salary = salaryFor(profile, year);
  const regularFed = Math.round(c(bracketTax(Math.max(0, d(salary - profile.preTaxAnnualCents) - t.federal.standardDeduction), t.federal.single)) / 12);
  const regularNc = Math.round((Math.max(0, d(salary - profile.preTaxAnnualCents) - t.nc.standardDeduction) * t.nc.rate) / 100 * 100 / 12);
  const ytd = profile.ytd && profile.ytd.year === year ? profile.ytd : null;
  let fedWithheld = ytd ? ytd.federalCents : 0;
  let ncWithheld = ytd ? ytd.stateCents : 0;
  for (const w of wages) {
    if (ytd && w.date <= ytd.asOf) continue;
    const share = w.cents / (salary / 12 || 1);
    fedWithheld += w.supplemental ? Math.round(w.cents * (t.federal.supplementalRate / 100)) : Math.round(regularFed * share);
    ncWithheld += w.supplemental ? Math.round(w.cents * (t.nc.supplementalRate / 100)) : Math.round(regularNc * share);
  }
  assumptions.push(ytd ? `Withholding: pay stub to ${ytd.asOf}, then projected.` : "Withholding is estimated from the salary (no pay stub entered yet).");

  // State incomes.
  const gaWages = wages.filter((w) => !isNY(w.date)).reduce((s, w) => s + w.cents, 0);
  const nyWages = W - gaWages;
  const gaIncome = Math.round(gaWages * (1 - preTaxShare) + (other * (12 - nyMonths)) / 12);
  const nyIncome = Math.round(nyWages * (1 - preTaxShare) + (other * nyMonths) / 12);
  const ncShare = Math.max(0, Math.min(100, profile.ncWorkSharePct)) / 100;
  const ncSource = Math.round(W * (1 - preTaxShare) * ncShare);
  const ncTax = ncSource > 0 && agi > 0 ? Math.round(c((Math.max(0, d(agi) - t.nc.standardDeduction) * t.nc.rate) / 100) * (ncSource / agi)) : 0;
  const ncDuringGa = agi > 0 ? Math.round(ncSource * (gaIncome / Math.max(1, gaIncome + nyIncome))) : 0;
  const ncTaxDuringGa = ncSource > 0 ? Math.round(ncTax * (ncDuringGa / ncSource)) : 0;

  const gaExempt = agi > 0 ? c(t.ga.exemption) * (gaIncome / agi) : 0;
  const gaBefore = gaIncome > 0 ? Math.round(Math.max(0, gaIncome - gaExempt) * (t.ga.rate / 100)) : 0;
  const gaCredit = Math.min(ncTaxDuringGa, Math.round(ncDuringGa * (t.ga.rate / 100)), gaBefore);
  const gaTax = gaBefore - gaCredit;

  const nyFull = c(bracketTax(Math.max(0, d(agi) - t.ny.standardDeduction), t.ny.single));
  const nyBefore = nyIncome > 0 && agi > 0 ? Math.round(nyFull * (nyIncome / agi)) : 0;
  const ncDuringNy = ncSource - ncDuringGa;
  const nyCredit = Math.min(ncTax - ncTaxDuringGa, nyBefore, Math.max(0, ncDuringNy) > 0 ? nyBefore : 0);
  const nyTax = nyBefore - Math.max(0, nyCredit);
  const nycTax = nyIncome > 0 ? c(bracketTax(Math.max(0, d(nyIncome) - (t.ny.standardDeduction * nyMonths) / 12), t.nyc.single)) : 0;
  if (profile.moveDate) assumptions.push(`Moves to New York City on ${profile.moveDate}: income paid before is Georgia's, after is New York's (New York's rate is set by the whole year's income).`);
  if (ncShare === 0) assumptions.push("No days worked in North Carolina: its withholding comes back as a refund on a nonresident return.");

  const paid = (jur: Jur) => profile.estimatesPaid.filter((e) => e.year === year && e.jur === jur).reduce((s, e) => s + e.cents, 0);
  const jurisdictions: TaxJurResult[] = [];
  const add = (jur: Jur, income: number, tax: number, withheld: number) => {
    const est = paid(jur);
    jurisdictions.push({ jur, label: JUR_LABEL[jur], incomeCents: income, taxCents: tax, withheldCents: withheld, estimatesPaidCents: est, balanceCents: tax - withheld - est });
  };
  add("federal", agi, fedTax, fedWithheld);
  if (gaIncome > 0) add("GA", gaIncome, gaTax, 0);
  add("NC", ncSource, ncTax, ncWithheld);
  if (nyIncome > 0) {
    add("NY", nyIncome, nyTax, 0);
    add("NYC", nyIncome, nycTax, 0);
  }

  // Safe harbour (federal).
  let required = Math.round(fedTax * 0.9);
  let basis = "90% of this year's tax";
  const prior = profile.priorYear && profile.priorYear.year === year - 1 ? profile.priorYear : null;
  if (prior) {
    const pct = prior.agiCents > 15_000_000 ? 1.1 : 1.0;
    const alt = Math.round(prior.federalTaxCents * pct);
    if (alt < required) {
      required = alt;
      basis = `${pct === 1.1 ? "110" : "100"}% of ${year - 1}'s tax`;
    }
  } else assumptions.push(`${year - 1} federal tax not entered: the safe harbour uses 90% of ${year}'s tax only.`);
  const covered = fedWithheld + paid("federal");

  // Payments that close each gap, on the remaining due dates; refunds after filing.
  const payments: TaxPayment[] = [];
  const due = DUE(year).filter((x) => x > today);
  for (const j of jurisdictions) {
    if (j.balanceCents > (j.jur === "federal" ? 100_000 : 50_000)) {
      const label = `${j.label} estimated tax ${year}`;
      if (!due.length) {
        payments.push({ year, jur: j.jur, label: `${j.label} tax due with the ${year} return`, date: `${year + 1}-04-15`, cents: -j.balanceCents, kind: "estimate" });
        continue;
      }
      // Income concentrated early (a January bonus before a move) is paid at the first date; else split evenly.
      const early = j.jur === "GA" && profile.moveDate && profile.moveDate.startsWith(`${year}-`) && profile.moveDate <= `${year}-06-30`;
      const dates = early ? [due[0]] : due;
      const each = Math.ceil(j.balanceCents / dates.length);
      dates.forEach((date, k) => payments.push({ year, jur: j.jur, label, date, cents: -(k === dates.length - 1 ? j.balanceCents - each * (dates.length - 1) : each), kind: "estimate" }));
    } else if (j.balanceCents < -10_000) {
      payments.push({ year, jur: j.jur, label: `${j.label} refund ${year}`, date: `${year + 1}-04-30`, cents: -j.balanceCents, kind: "refund" });
    }
  }

  const fixes: string[] = [];
  const fed = jurisdictions[0];
  if (fed.balanceCents > 100_000) {
    const left = wages.filter((w) => !w.supplemental && w.date > today).length;
    if (left > 0) fixes.push(`Federal: add about ${usd(Math.ceil(fed.balanceCents / left))} extra withholding per paycheck (new W-4) for the ${left} paychecks left; withholding counts as paid evenly through the year, so it also fixes earlier quarters.`);
    fixes.push(`Federal: or pay ${usd(fed.balanceCents)} as estimated payments (1040-ES) by the dates listed.`);
  }
  if (covered < required) fixes.push(`Federal safe harbour (${basis}) needs ${usd(required)} paid; ${usd(covered)} is projected.`);
  for (const j of jurisdictions) if (j.jur !== "federal" && j.balanceCents > 50_000) fixes.push(`${j.label}: your employer does not withhold it, so pay ${usd(j.balanceCents)} by estimated payments.`);

  return {
    year,
    wagesCents: W,
    agiCents: agi,
    jurisdictions,
    payments: payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    safeHarbor: { requiredCents: required, coveredCents: covered, met: covered >= required, basis },
    fixes,
    assumptions,
  };
}

/** Federal marginal rate on this year's income (used to price a 401(k) change in cash). */
export function federalMarginalRate(profile: TaxProfile, year: number): number {
  const t = taxTables(year);
  const W = wagesFor(profile, year).reduce((s, w) => s + w.cents, 0);
  return marginalRate(Math.max(0, d(W - profile.preTaxAnnualCents + profile.otherIncomeAnnualCents) - t.federal.standardDeduction), t.federal.single);
}

/** Cash lines for the forecast: tax payments and refunds, and the net of each future supplemental payment. */
export function taxCashItems(profile: TaxProfile, results: readonly TaxYearResult[], today: string): PlannedItem[] {
  const items: PlannedItem[] = [];
  for (const r of results) {
    for (const p of r.payments) {
      if (p.date <= today) continue;
      items.push({ id: `tax:${p.year}:${p.jur}:${p.date}`, label: `${p.label} (calculated)`, date: p.date, amountCents: p.cents, certainty: "likely" });
    }
  }
  for (const o of allOneOffs(profile)) {
    if (o.date <= today) continue;
    items.push({ id: `pay:${o.date}:${o.label}`, label: `${o.label} (after tax, calculated)`, date: o.date, amountCents: oneOffNetCents(profile, o), certainty: "likely" });
  }
  return items;
}

export function parseTaxProfile(raw: unknown): TaxProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const num = (v: unknown, dflt = 0) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
  const start = day(r.employmentStart);
  if (!start || !(num(r.salaryAnnualCents) > 0)) return null;
  const jurs: Jur[] = ["federal", "GA", "NC", "NY", "NYC"];
  return {
    salaryAnnualCents: Math.round(num(r.salaryAnnualCents)),
    employmentStart: start,
    oneOffs: Array.isArray(r.oneOffs)
      ? (r.oneOffs as Record<string, unknown>[]).filter((o) => day(o?.date) && num(o?.grossCents) > 0).map((o) => ({ date: day(o.date)!, grossCents: Math.round(num(o.grossCents)), label: String(o.label ?? "Bonus").slice(0, 80) }))
      : [],
    moveDate: day(r.moveDate),
    ncWorkSharePct: Math.max(0, Math.min(100, num(r.ncWorkSharePct))),
    preTaxAnnualCents: Math.max(0, Math.round(num(r.preTaxAnnualCents))),
    otherIncomeAnnualCents: Math.max(0, Math.round(num(r.otherIncomeAnnualCents))),
    ytd: r.ytd && typeof r.ytd === "object" && day((r.ytd as Record<string, unknown>).asOf)
      ? {
          year: num((r.ytd as Record<string, unknown>).year, Number(day((r.ytd as Record<string, unknown>).asOf)!.slice(0, 4))),
          asOf: day((r.ytd as Record<string, unknown>).asOf)!,
          federalCents: Math.round(num((r.ytd as Record<string, unknown>).federalCents)),
          stateCents: Math.round(num((r.ytd as Record<string, unknown>).stateCents)),
        }
      : null,
    priorYear: r.priorYear && typeof r.priorYear === "object" && num((r.priorYear as Record<string, unknown>).federalTaxCents) > 0
      ? { year: num((r.priorYear as Record<string, unknown>).year), federalTaxCents: Math.round(num((r.priorYear as Record<string, unknown>).federalTaxCents)), agiCents: Math.round(num((r.priorYear as Record<string, unknown>).agiCents)) }
      : null,
    annualBonus:
      r.annualBonus && typeof r.annualBonus === "object" && num((r.annualBonus as Record<string, unknown>).firstPlanYear) >= 2000
        ? {
            amountCents: Math.max(0, Math.round(num((r.annualBonus as Record<string, unknown>).amountCents))),
            profitShareCents: Math.max(0, Math.round(num((r.annualBonus as Record<string, unknown>).profitShareCents))),
            growthPct: Math.max(-50, Math.min(100, num((r.annualBonus as Record<string, unknown>).growthPct))),
            firstPlanYear: Math.round(num((r.annualBonus as Record<string, unknown>).firstPlanYear)),
          }
        : null,
    raisePct: Math.max(0, Math.min(50, num(r.raisePct))),
    estimatesPaid: Array.isArray(r.estimatesPaid)
      ? (r.estimatesPaid as Record<string, unknown>[])
          .filter((e) => jurs.includes(e?.jur as Jur) && day(e?.date) && num(e?.cents) > 0)
          .map((e) => ({ year: num(e.year, Number(String(e.date).slice(0, 4))), jur: e.jur as Jur, date: day(e.date)!, cents: Math.round(num(e.cents)) }))
      : [],
  };
}
