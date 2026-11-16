/**
 * Tax planning engine (docs/cash-flow-forecast.md, Section 7). PURE: no I/O, no clock (callers pass `today`).
 * Planning estimates for one single filer who lives in Georgia, works for an employer that withholds North
 * Carolina tax, and may move to New York City: federal tax, Georgia (resident part of the year), North Carolina
 * (nonresident, on days physically worked there), New York + NYC (resident part of the year), what is withheld,
 * the safe harbour, and the payments that close each gap, as dated cash lines for the forecast.
 * Not a filed return: no itemizing, credits, AMT or equity; FICA is assumed to be withheld exactly.
 */
import { isBusinessDay, lastBusinessDayOfMonth, type PlannedItem } from "./cash-forecast";
import { FORECAST } from "./cash-forecast-config";
import {
  bracketTax,
  lastPublishedFederalYear,
  marginalRate,
  nyResidentTax,
  round4,
  TABLES_CHECKED,
  taxTables,
  type Bracket,
  type RuleBasis,
  type TableSource,
  type YearTables,
} from "./tax-tables";

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
  /**
   * What-if only (lib/cash-forecast-scenario.ts; never stored, never read from the driver): other income changes by
   * annualCents a year from `from` on, received as one twelfth at each month end (otherIncomeReceiptDates). Each
   * year's tax counts exactly the receipts dated in that year, so the tax and the cash lines of a what-if agree.
   */
  otherIncomeChange?: { annualCents: number; from: string } | null;
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
  /** Yearly increase applied to federal brackets, standard deduction and wage base for years without published figures (default 2.7%). */
  bracketIndexPct?: number;
  /** Rate overrides (percent), applied to every year. */
  gaRatePct?: number | null;
  ncRatePct?: number | null;
  /** The state your employer withholds ("NC" today; "none" if it withholds no state tax). */
  employerStateWithholding?: "NC" | "none";
}

export const DEFAULT_BRACKET_INDEX_PCT = 2.7;
/**
 * Tax tables for a year with the profile's entries applied. Published figures are used as they are; a year whose
 * federal figures are not published yet indexes the last published year's by `bracketIndexPct` and stays an
 * "assumption" either way (the note says whether the percentage is the plan's default or Riley's entry, since an
 * entered index does not make an unpublished year's figures any less of an estimate); an entered Georgia or North
 * Carolina rate replaces the table's for every year ("override", the table's own figure named in the note).
 */
export function tablesFor(profile: TaxProfile, year: number): YearTables {
  const t = taxTables(year);
  let out: YearTables = t;
  const from = lastPublishedFederalYear();
  const n = year - from;
  if (t.federal.basis === "assumption" && n > 0) {
    const entered = typeof profile.bracketIndexPct === "number";
    const pct = profile.bracketIndexPct ?? DEFAULT_BRACKET_INDEX_PCT;
    const f = Math.pow(1 + pct / 100, n);
    // The IRS rounds indexed brackets down to a multiple of $25 and the standard deduction down to $50; the SSA
    // rounds the wage base to the nearest $300.
    const down = (x: number, step: number) => Math.floor((x * f) / step) * step;
    out = {
      ...t,
      federal: {
        ...t.federal,
        single: t.federal.single.map((b) => ({ ...b, upTo: b.upTo === null ? null : down(b.upTo, 25) })),
        standardDeduction: down(t.federal.standardDeduction, 50),
        ssWageBase: Math.round((t.federal.ssWageBase * f) / 300) * 300,
        basis: "assumption",
        note: `${year} federal brackets, standard deduction and wage base are not published yet: estimated as ${from}'s indexed ${pct.toFixed(1)}% a year (${entered ? "the index is your entry in the tax profile" : "the plan's default index; edit it in the tax profile"}).`,
      },
    };
  }
  if (typeof profile.gaRatePct === "number") {
    const was = `${out.ga.rate}% ${out.ga.basis === "published" ? "published" : "assumed"} for ${year}`;
    out = { ...out, ga: { ...out.ga, rate: profile.gaRatePct, basis: "override", note: `Georgia rate ${profile.gaRatePct}% is your entry (the table has ${was}).` } };
  }
  if (typeof profile.ncRatePct === "number") {
    const was = `${out.nc.rate}% ${out.nc.basis === "published" ? "published" : "assumed"} for ${year}`;
    out = { ...out, nc: { ...out.nc, rate: profile.ncRatePct, supplementalRate: Math.round((profile.ncRatePct + 0.1) * 100) / 100, basis: "override", note: `North Carolina rate ${profile.ncRatePct}% is your entry (the table has ${was}).` } };
  }
  const parts = [out.federal, out.ga, out.nc, out.ny, out.nyc].filter((x) => x.basis !== "published" && x.note).map((x) => x.note as string);
  return { ...out, estimated: parts.length ? parts.join(" ") : null };
}

/** Where a year's figures for one jurisdiction come from, for the page: published, an assumption, or your entry. */
export interface TaxRuleStatus {
  jur: Jur;
  label: string;
  basis: RuleBasis;
  /** The figures in one line, e.g. "4.99% flat, standard deduction $15,000". */
  figures: string;
  note: string | null;
  sources: TableSource[];
  /** Set when the official figures should be published by now but the built-in table still has an assumption. */
  stale: string | null;
}
const dollarsText = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const rangeText = (b: readonly Bracket[]) => `${b[0].rate}% to ${b[b.length - 1].rate}%`;
export function taxRuleStatus(t: YearTables, jur: Jur, today: string): TaxRuleStatus {
  const part = jur === "federal" ? t.federal : jur === "GA" ? t.ga : jur === "NC" ? t.nc : jur === "NY" ? t.ny : t.nyc;
  const fed = t.federal.single;
  const top = fed.length > 1 ? fed[fed.length - 2].upTo : null;
  const figures =
    jur === "federal"
      ? `standard deduction ${dollarsText(t.federal.standardDeduction)}, brackets ${rangeText(fed)}${top ? ` (${fed[fed.length - 1].rate}% over ${dollarsText(top)})` : ""}, Social Security wage base ${dollarsText(t.federal.ssWageBase)}`
      : jur === "GA"
        ? `${t.ga.rate}% flat, standard deduction ${dollarsText(t.ga.standardDeduction)}`
        : jur === "NC"
          ? `${t.nc.rate}% flat, standard deduction ${dollarsText(t.nc.standardDeduction)}, withholding ${t.nc.supplementalRate}%`
          : jur === "NY"
            ? `brackets ${rangeText(t.ny.single)}, standard deduction ${dollarsText(t.ny.standardDeduction)}${t.ny.recapture ? `, recapture above ${dollarsText(t.ny.recapture.startAgi)} of NY AGI` : ""}`
            : `brackets ${rangeText(t.nyc.single)}`;
  const stale = part.staleAfter && today > part.staleAfter
    ? `${JUR_LABEL[jur]} ${t.year}: the official figures are normally published by ${part.staleAfter}, and the built-in table still has an assumption. Ask an agent to update the built-in tax tables.`
    : null;
  return { jur, label: JUR_LABEL[jur], basis: part.basis, figures, note: part.note, sources: part.sources, stale };
}
/**
 * The built-in tables are re-checked every year (each November to January); past a year since the check, say so.
 * One message for the whole page (TaxYearResult.tablesReview, shown once above the years), not one per year.
 */
export function tablesReviewMessage(today: string, checked: string = TABLES_CHECKED): string | null {
  const due = `${Number(checked.slice(0, 4)) + 1}${checked.slice(4)}`;
  return today > due ? `The built-in tax tables were last checked against their sources on ${checked} (a new check was due ${due}): ask an agent to check every year's figures again.` : null;
}

/** What the estimate leaves out, shown beside it on the page. */
export const TAX_LIMITATIONS: readonly string[] = [
  "One single filer with the standard deduction: no itemizing, credits, AMT or equity compensation; FICA is assumed to be withheld exactly.",
  "Not modeled: the federal deductions for tips, overtime and car-loan interest, Georgia's tips and overtime exclusions and retirement exclusion, half of self-employment tax as a deduction, NYC credits, the MCTMT and Yonkers.",
  "Part-year rules: Georgia prorates its standard deduction by the Georgia share of income (Form 500 Schedule 3); New York taxes the income percentage of the full-year tax, rounded to four decimals (IT-203); NYC prorates the standard deduction by full months of residence (IT-360.1). Wages and other income are split at the move date by when they are received (other income counted as one twelfth at each month end). No special accruals.",
  "New York's tax benefit recapture is included (worksheets 7-11, single), derived from the brackets: within about $2 of the published worksheet amounts.",
  "North Carolina: nonresident tax on the share of days worked there, credited by Georgia or New York up to their own tax on that income.",
  "Payment dates move past weekends, federal holidays and DC Emancipation Day like IRS due dates (IRC 7503); the states are assumed to use the same dates. A refund is assumed on April 30.",
];

/** The next day that is not a weekend, a federal holiday or DC Emancipation Day (IRC 7503: a due date on one moves). */
export function taxDueDate(nominal: string): string {
  let d = nominal;
  for (let i = 0; i < 10 && !(isBusinessDay(d) && d !== emancipationDay(Number(d.slice(0, 4)))); i++) d = shiftDay(d, 1);
  return d;
}
/** DC Emancipation Day (April 16; observed the Friday before when a Saturday, the Monday after when a Sunday). */
function emancipationDay(year: number): string {
  const w = new Date(Date.UTC(year, 3, 16)).getUTCDay();
  return w === 6 ? `${year}-04-15` : w === 0 ? `${year}-04-17` : `${year}-04-16`;
}
/**
 * Full months a filer who moves into New York City is a city resident in `year` (IT-360.1-I: a part of a month over
 * half of it counts as a month, half or less does not). Moved April 1 = 9 months; September 4 = 4 months.
 */
export function cityResidentMonths(moveDate: string | null, year: number): number {
  if (!moveDate) return 0;
  if (moveDate < `${year}-01-01`) return 12;
  if (!moveDate.startsWith(`${year}-`)) return 0;
  const m = Number(moveDate.slice(5, 7));
  const dim = daysIn(year, m);
  const residentDays = dim - Number(moveDate.slice(8, 10)) + 1;
  return 12 - m + (residentDays > dim / 2 ? 1 : 0);
}

const PROJECT_YEARS = 4;

/** The last cash line a tax year can make: its refund, after the April 15 return of the next year. */
export const taxYearLastCashDate = (year: number): string => `${year + 1}-04-30`;
const shiftDay = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/**
 * The tax years the cash forecast needs, picked by cash date rather than calendar year. A tax year makes cash lines
 * from its April 15 estimate to the January estimate, the April balance and the refund of the NEXT year, so it stays
 * in after New Year: until its last line is more than the late-match window (FORECAST.lateMatchDays) behind `today`,
 * which gives the forecast time to match the payment or refund (or to keep counting an unpaid balance). The last
 * year is the one `horizonEnd` falls in.
 */
export function taxYearsFor(today: string, horizonEnd: string, keepDays: number = FORECAST.lateMatchDays): number[] {
  const keepFrom = shiftDay(today, -keepDays);
  const last = Number(horizonEnd.slice(0, 4));
  const years: number[] = [];
  for (let y = Number(today.slice(0, 4)) - 2; y <= last; y++) if (taxYearLastCashDate(y) >= keepFrom) years.push(y);
  return years;
}

/** Month ends (last business day) on which a what-if change in other income is received, from `from`, in `year`. */
export function otherIncomeReceiptDates(from: string, year: number): string[] {
  const out: string[] = [];
  if (year < Number(from.slice(0, 4))) return out;
  for (let m = 1; m <= 12; m++) {
    const date = lastBusinessDayOfMonth(year, m);
    if (date >= from) out.push(date);
  }
  return out;
}
/** One receipt of a what-if change in other income (the same rounding for the cash lines and the tax). */
export const otherIncomeReceiptCents = (annualCents: number): number => Math.round(annualCents / 12);
/** Other income counted in a tax year: the profile's yearly figure plus the receipts of a what-if change dated that year. */
export function otherIncomeFor(profile: TaxProfile, year: number): number {
  const ch = profile.otherIncomeChange;
  const extra = ch && ch.annualCents ? otherIncomeReceiptCents(ch.annualCents) * otherIncomeReceiptDates(ch.from, year).length : 0;
  return Math.max(0, profile.otherIncomeAnnualCents + extra);
}
/**
 * The part of a year's other income (`otherCents` = otherIncomeFor) received as a New York resident, split by receipt
 * date like wages: the profile's yearly figure as one twelfth at each month end, a what-if change on its own receipt
 * dates, and every receipt on or after the move date is New York's. Deliberately not the NYC resident months
 * (cityResidentMonths), which round a part month and only prorate the NYC standard deduction: a move on December 20
 * still receives December's income in New York.
 */
export function nyOtherIncomeCents(profile: TaxProfile, year: number, otherCents: number): number {
  const move = profile.moveDate;
  if (!move || otherCents <= 0) return 0;
  const ch = profile.otherIncomeChange;
  const changeDates = ch && ch.annualCents ? otherIncomeReceiptDates(ch.from, year) : [];
  const changeEach = ch && ch.annualCents ? otherIncomeReceiptCents(ch.annualCents) : 0;
  let total = 0;
  let ny = 0;
  for (let m = 1; m <= 12; m++) {
    const date = lastBusinessDayOfMonth(year, m);
    const cents = profile.otherIncomeAnnualCents / 12 + (changeDates.includes(date) ? changeEach : 0);
    total += cents;
    if (date >= move) ny += cents;
  }
  if (total <= 0) return 0;
  return Math.max(0, Math.min(otherCents, Math.round(otherCents * (ny / total))));
}
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
  /** Where each jurisdiction's figures come from (published / assumption / your entry), with sources. */
  rules: TaxRuleStatus[];
  /** Built-in figures of this year that should have been updated by now (an assumption past its publication date). */
  stale: string[];
  /** Set when the built-in tables were last checked more than a year ago (the same on every year: show it once). */
  tablesReview: string | null;
  limitations: readonly string[];
  /** The day the built-in tables were last checked against their sources. */
  tablesChecked: string;
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
  const t = tablesFor(profile, year);
  const before = wagesFor(profile, year).filter((w) => w.date < oneOff.date || (w.date === oneOff.date && !w.supplemental)).reduce((s, w) => s + w.cents, 0);
  const g = oneOff.grossCents;
  const ssRoom = Math.max(0, c(t.federal.ssWageBase) - before);
  const ss = Math.min(g, ssRoom) * (t.federal.ssRate / 100);
  const overAddl = Math.max(0, before + g - c(t.federal.addlMedicareThreshold)) - Math.max(0, before - c(t.federal.addlMedicareThreshold));
  const medicare = g * (t.federal.medicareRate / 100) + Math.max(0, overAddl) * (t.federal.addlMedicareRate / 100);
  const fed = g * (t.federal.supplementalRate / 100);
  const nc = profile.employerStateWithholding === "none" ? 0 : g * (t.nc.supplementalRate / 100);
  return Math.round(g - fed - ss - medicare - nc);
}

/** Estimated tax due dates for a tax year (Form 1040-ES; IT-2105 and the Georgia / NC vouchers use the same), moved past a weekend or holiday. */
export const taxDueDates = (year: number): string[] => [`${year}-04-15`, `${year}-06-15`, `${year}-09-15`, `${year + 1}-01-15`].map(taxDueDate);

export function computeTaxYear(profile: TaxProfile, year: number, today: string): TaxYearResult {
  const t = tablesFor(profile, year);
  const assumptions: string[] = [];
  assumptions.push(`North Carolina ${t.nc.rate}% (nonresident, on the share of days worked there).`);
  const wages = wagesFor(profile, year);
  const W = wages.reduce((s, w) => s + w.cents, 0);
  const preTax = Math.min(profile.preTaxAnnualCents, W);
  const other = otherIncomeFor(profile, year);
  const agi = Math.max(0, W - preTax + other);
  const isNY = (date: string) => !!profile.moveDate && date >= profile.moveDate;
  const nyMonths = cityResidentMonths(profile.moveDate, year);
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
    if (profile.employerStateWithholding !== "none") ncWithheld += w.supplemental ? Math.round(w.cents * (t.nc.supplementalRate / 100)) : Math.round(regularNc * share);
  }
  assumptions.push(ytd ? `Withholding: pay stub to ${ytd.asOf}, then projected.` : "Withholding is estimated from the salary (no pay stub entered yet).");

  // State incomes: wages and other income by the date they are received (before the move = Georgia's).
  const gaWages = wages.filter((w) => !isNY(w.date)).reduce((s, w) => s + w.cents, 0);
  const nyWages = W - gaWages;
  const nyOther = nyOtherIncomeCents(profile, year, other);
  const gaIncome = Math.round(gaWages * (1 - preTaxShare) + (other - nyOther));
  const nyIncome = Math.round(nyWages * (1 - preTaxShare) + nyOther);
  const ncShare = Math.max(0, Math.min(100, profile.ncWorkSharePct)) / 100;
  const ncSource = Math.round(W * (1 - preTaxShare) * ncShare);
  const ncTax = ncSource > 0 && agi > 0 ? Math.round(c((Math.max(0, d(agi) - t.nc.standardDeduction) * t.nc.rate) / 100) * (ncSource / agi)) : 0;
  const ncDuringGa = agi > 0 ? Math.round(ncSource * (gaIncome / Math.max(1, gaIncome + nyIncome))) : 0;
  const ncTaxDuringGa = ncSource > 0 ? Math.round(ncTax * (ncDuringGa / ncSource)) : 0;

  const gaExempt = agi > 0 ? c(t.ga.standardDeduction) * (gaIncome / agi) : 0;
  const gaBefore = gaIncome > 0 ? Math.round(Math.max(0, gaIncome - gaExempt) * (t.ga.rate / 100)) : 0;
  const gaCredit = Math.min(ncTaxDuringGa, Math.round(ncDuringGa * (t.ga.rate / 100)), gaBefore);
  const gaTax = gaBefore - gaCredit;

  // Full-year resident tax on all income (recapture included, on the whole year's NY AGI), times the income
  // percentage rounded to four decimals (IT-203 line 45).
  const nyFull = c(nyResidentTax(d(agi), Math.max(0, d(agi) - t.ny.standardDeduction), t.ny));
  const nyBefore = nyIncome > 0 && agi > 0 ? Math.round(nyFull * round4(nyIncome / agi)) : 0;
  const ncDuringNy = ncSource - ncDuringGa;
  const nyCredit = Math.min(ncTax - ncTaxDuringGa, nyBefore, Math.max(0, ncDuringNy) > 0 ? nyBefore : 0);
  const nyTax = nyBefore - Math.max(0, nyCredit);
  // NYC: resident-period income less the standard deduction prorated by full resident months (IT-360.1 chart).
  const nycTax = nyIncome > 0 ? c(bracketTax(Math.max(0, d(nyIncome) - Math.round((t.ny.standardDeduction * nyMonths) / 12)), t.nyc.single)) : 0;
  if (profile.moveDate) assumptions.push(`Moves to New York City on ${profile.moveDate}: income paid before is Georgia's, after is New York's (New York's rate is set by the whole year's income; ${nyMonths} NYC resident months in ${year}).`);
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
  const due = taxDueDates(year).filter((x) => x > today);
  for (const j of jurisdictions) {
    if (j.balanceCents > (j.jur === "federal" ? 100_000 : 50_000)) {
      const label = `${j.label} estimated tax ${year}`;
      if (!due.length) {
        payments.push({ year, jur: j.jur, label: `${j.label} tax due with the ${year} return`, date: taxDueDate(`${year + 1}-04-15`), cents: -j.balanceCents, kind: "estimate" });
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

  const rules = jurisdictions.map((j) => taxRuleStatus(t, j.jur, today));
  const stale = rules.filter((r) => r.stale).map((r) => r.stale as string);

  return {
    year,
    wagesCents: W,
    agiCents: agi,
    jurisdictions,
    payments: payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    safeHarbor: { requiredCents: required, coveredCents: covered, met: covered >= required, basis },
    fixes,
    assumptions,
    rules,
    stale,
    tablesReview: tablesReviewMessage(today),
    limitations: TAX_LIMITATIONS,
    tablesChecked: TABLES_CHECKED,
  };
}

/** Federal marginal rate on this year's income (used to price a 401(k) change in cash). */
export function federalMarginalRate(profile: TaxProfile, year: number): number {
  const t = tablesFor(profile, year);
  const W = wagesFor(profile, year).reduce((s, w) => s + w.cents, 0);
  return marginalRate(Math.max(0, d(W - profile.preTaxAnnualCents + otherIncomeFor(profile, year)) - t.federal.standardDeduction), t.federal.single);
}

/**
 * Cash lines for the forecast: tax payments and refunds, and the net of each future supplemental payment. A tax line
 * whose date passed less than the late-match window ago is kept: the forecast matches it to the payment or refund
 * that happened, keeps counting a payment that was not made (as of tomorrow) and drops a late refund after its match
 * window (lib/cash-forecast.ts). Recording an estimated payment in the tax profile settles it.
 */
export function taxCashItems(profile: TaxProfile, results: readonly TaxYearResult[], today: string, keepDays: number = FORECAST.lateMatchDays): PlannedItem[] {
  const items: PlannedItem[] = [];
  const keepFrom = shiftDay(today, -keepDays);
  for (const r of results) {
    for (const p of r.payments) {
      if (p.date < keepFrom) continue;
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
    bracketIndexPct: typeof r.bracketIndexPct === "number" && Number.isFinite(r.bracketIndexPct) ? Math.max(0, Math.min(10, r.bracketIndexPct)) : undefined,
    gaRatePct: typeof r.gaRatePct === "number" && Number.isFinite(r.gaRatePct) ? Math.max(0, Math.min(10, r.gaRatePct)) : null,
    ncRatePct: typeof r.ncRatePct === "number" && Number.isFinite(r.ncRatePct) ? Math.max(0, Math.min(10, r.ncRatePct)) : null,
    employerStateWithholding: r.employerStateWithholding === "none" ? "none" : "NC",
    estimatesPaid: Array.isArray(r.estimatesPaid)
      ? (r.estimatesPaid as Record<string, unknown>[])
          .filter((e) => jurs.includes(e?.jur as Jur) && day(e?.date) && num(e?.cents) > 0)
          .map((e) => ({ year: num(e.year, Number(String(e.date).slice(0, 4))), jur: e.jur as Jur, date: day(e.date)!, cents: Math.round(num(e.cents)) }))
      : [],
  };
}
