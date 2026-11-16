/**
 * Tax tables for planning (docs/cash-flow-forecast.md, Section 7.2). Planning estimates, not filing values. PURE.
 *
 * Every jurisdiction's figures for a year carry their provenance:
 *  - basis "published": set by an official table or an enacted law for that year, with the source URL, the date the
 *    figures were checked against it (`retrieved`) and what they apply to (`effective`);
 *  - basis "assumption": not published yet; a planning figure (carried forward, or indexed in lib/tax-plan.ts), with
 *    the reason in `note` and `staleAfter` = the date by which the official figures are normally out. Past that date
 *    the plan says the built-in table needs updating (taxRuleStatus in lib/tax-plan.ts).
 * A rate Riley enters in the tax profile is a third basis, "override", applied by lib/tax-plan.ts (tablesFor). An
 * entered federal index does not make an unpublished year "override": its figures stay an assumption.
 *
 * Yearly refresh (who and when: docs/cash-flow-forecast.md, Section 7.2): federal figures after the IRS revenue
 * procedure (October / November) and the SSA wage base (October), Georgia after the Office of Planning and Budget's
 * December 1 report, North Carolina and New York after their sessions (NC: summer; NY: the spring budget).
 */

/** The day every figure below was last checked against its source. */
export const TABLES_CHECKED = "2026-11-16";

export interface Bracket {
  upTo: number | null; // dollars of taxable income; null = no upper bound
  rate: number; // percent
}
export type RuleBasis = "published" | "assumption" | "override";
export interface TableSource {
  title: string;
  url: string;
  /** The day the figures were checked against this source. */
  retrieved: string;
  /** What the figures apply to (tax years / payrolls), as the source states it. */
  effective: string;
}
export interface Provenance {
  basis: RuleBasis;
  /** Why a figure is an assumption or an override, or a caveat on a published one; null = nothing to add. */
  note: string | null;
  sources: TableSource[];
  /** For an assumption: the date by which the official figures are normally published (null = no date known). */
  staleAfter: string | null;
}
export interface FederalTable extends Provenance {
  single: Bracket[];
  standardDeduction: number;
  supplementalRate: number;
  ssWageBase: number;
  ssRate: number;
  medicareRate: number;
  addlMedicareThreshold: number;
  addlMedicareRate: number;
}
export interface GaTable extends Provenance {
  rate: number;
  standardDeduction: number;
}
export interface NcTable extends Provenance {
  rate: number;
  standardDeduction: number;
  /** Withholding rate on wages, including supplemental wages (NC-30: the tax rate + 0.10). */
  supplementalRate: number;
}
/**
 * New York's tax benefit recapture (Tax Law 601(d-1); the tax computation worksheets of IT-201-I / IT-2105-I): above
 * `startAgi` of NY AGI the benefit of the lower brackets is taken back over `phaseIn` dollars, and above `flatAbove`
 * the whole taxable income is taxed at the top rate. `firstLevel` = index of the bracket whose rate the first
 * worksheet applies flat (5.90% in 2026, 5.80% from 2027).
 */
export interface NyRecapture {
  startAgi: number;
  phaseIn: number;
  flatAbove: number;
  firstLevel: number;
}
export interface NyTable extends Provenance {
  single: Bracket[];
  standardDeduction: number;
  recapture: NyRecapture | null;
}
export interface NycTable extends Provenance {
  single: Bracket[];
}
export interface YearTables {
  year: number;
  /**
   * The notes of every jurisdiction that is not published (an assumption here; also an override once lib/tax-plan.ts
   * applies Riley's entries), joined; null = every figure is published.
   */
  estimated: string | null;
  federal: FederalTable;
  ga: GaTable;
  nc: NcTable;
  ny: NyTable;
  nyc: NycTable;
}

// ─── Sources ──────────────────────────────────────────────────────────────────────────────────

const R = TABLES_CHECKED;
const SRC = {
  irs2026: { title: "IRS Rev. Proc. 2025-32 (2026 brackets, Table 3; standard deduction, section 4.15)", url: "https://www.irs.gov/pub/irs-drop/rp-25-32.pdf", retrieved: R, effective: "taxable years beginning in 2026" },
  irs2027: { title: "IRS Rev. Proc. 2026-35 (2027 brackets, Table 3; standard deduction, section 4.15); IR-2026-133, Nov. 5, 2026", url: "https://www.irs.gov/pub/irs-drop/rp-26-35.pdf", retrieved: R, effective: "taxable years beginning in 2027" },
  ssa: { title: "SSA contribution and benefit base ($184,500 for 2026, $192,300 for 2027)", url: "https://www.ssa.gov/oact/cola/cbb.html", retrieved: R, effective: "wages paid in the calendar year" },
  fica: { title: "IRC 3101 (6.2% Social Security, 1.45% Medicare, 0.9% above $200,000) and the 22% optional flat rate for supplemental wages (Treas. Reg. 31.3402(g)-1)", url: "https://www.irs.gov/publications/p15", retrieved: R, effective: "wages paid in the calendar year (statutory, not indexed)" },
  ga2026: { title: "Georgia DOR, Important tax updates: 2026 flat rate 4.99%, standard deduction $15,000 single", url: "https://dor.georgia.gov/taxes/important-tax-updates", retrieved: R, effective: "tax year 2026" },
  gaHb463: { title: "Georgia HB 463 (2026), as passed: O.C.G.A. 48-7-20(a.1) (rate, 0.125-point steps delayed with the standard deduction's) and 48-7-27(a)(1), (a)(1.1) (standard deduction, $375 steps; delayed a year when any revenue condition fails as of December 1, determined and reported by the Office of Planning and Budget by December 1); signed May 11, 2026", url: "https://www.legis.ga.gov/api/legislation/document/20252026/249080", retrieved: R, effective: "taxable years beginning on or after January 1, 2026 (Section 5-1); later steps from January 1, 2027, each subject to the December 1 revenue conditions" },
  ncRates: { title: "NCDOR tax rate schedules: 3.99% for taxable years after 2025", url: "https://www.ncdor.gov/taxes-forms/tax-rate-schedules", retrieved: R, effective: "taxable years beginning in 2026" },
  ncSl202641: { title: "N.C. S.L. 2026-41 (S.B. 257), section 44.1: G.S. 105-153.7 rates 3.49% (2027-2029), 3.24% (2030-2032), 2.99% (after 2032)", url: "https://www.ncleg.gov/Sessions/2025/Bills/Senate/PDF/S257v8.pdf", retrieved: R, effective: "taxable years beginning in 2027 and later" },
  ncStd: { title: "NCDOR standard deduction: $12,750 single (G.S. 105-153.5(a)(1), not indexed)", url: "https://www.ncdor.gov/taxes-forms/individual-income-tax/north-carolina-standard-deduction-or-north-carolina-itemized-deductions", retrieved: R, effective: "every year until the statute changes" },
  ncWh: { title: "NCDOR NC-30 withholding: the income tax rate + 0.10 (4.09% on 2026 wages)", url: "https://www.ncdor.gov/taxes-forms/withholding-tax/withholding-tax-forms-and-instructions/nc-30-income-tax-withholding-tables-and-instructions-employers", retrieved: R, effective: "wages paid in the calendar year" },
  nyLaw: { title: "NY Tax Law 601(c)(1)(vii) (2026) and (viii) (2027-2032), single; 601(d-1) recapture (Ch. 59, Laws of 2025, Part A)", url: "https://www.nysenate.gov/legislation/laws/TAX/601", retrieved: R, effective: "taxable years beginning in 2026, and 2027 through 2032" },
  ny2105: { title: "NY IT-2105-I (2026): rate schedules, standard deduction $8,000 single, tax computation worksheets 7-11", url: "https://www.tax.ny.gov/pdf/current_forms/it/it2105i.pdf", retrieved: R, effective: "tax year 2026" },
  nyc: { title: "NYC resident tax rates, single (IT-2105-I (2026), page 10); no change enacted in the 2026-27 budget", url: "https://www.tax.ny.gov/pdf/current_forms/it/it2105i.pdf", retrieved: R, effective: "tax year 2026; later years under current law" },
} satisfies Record<string, TableSource>;

// ─── Federal ──────────────────────────────────────────────────────────────────────────────────

const FICA = { supplementalRate: 22, ssRate: 6.2, medicareRate: 1.45, addlMedicareThreshold: 200_000, addlMedicareRate: 0.9 };
const FEDERAL: Record<number, FederalTable> = {
  2026: {
    ...FICA,
    single: [
      { upTo: 12_400, rate: 10 },
      { upTo: 50_400, rate: 12 },
      { upTo: 105_700, rate: 22 },
      { upTo: 201_775, rate: 24 },
      { upTo: 256_225, rate: 32 },
      { upTo: 640_600, rate: 35 },
      { upTo: null, rate: 37 },
    ],
    standardDeduction: 16_100,
    ssWageBase: 184_500,
    basis: "published",
    note: null,
    sources: [SRC.irs2026, SRC.ssa, SRC.fica],
    staleAfter: null,
  },
  2027: {
    ...FICA,
    single: [
      { upTo: 12_800, rate: 10 },
      { upTo: 52_025, rate: 12 },
      { upTo: 109_125, rate: 22 },
      { upTo: 208_325, rate: 24 },
      { upTo: 264_550, rate: 32 },
      { upTo: 661_375, rate: 35 },
      { upTo: null, rate: 37 },
    ],
    standardDeduction: 16_600,
    ssWageBase: 192_300,
    basis: "published",
    note: null,
    sources: [SRC.irs2027, SRC.ssa, SRC.fica],
    staleAfter: null,
  },
};
const FEDERAL_YEARS = Object.keys(FEDERAL).map(Number).sort((a, b) => a - b);
/** The latest year with published federal figures (brackets, standard deduction, wage base). */
export const lastPublishedFederalYear = (): number => FEDERAL_YEARS[FEDERAL_YEARS.length - 1];

function federalFor(year: number): FederalTable {
  if (FEDERAL[year]) return FEDERAL[year];
  const first = FEDERAL_YEARS[0];
  if (year < first) return { ...FEDERAL[first], basis: "assumption", note: `${year} federal figures are not in the tables: ${first}'s are used.`, staleAfter: null };
  const last = lastPublishedFederalYear();
  return {
    ...FEDERAL[last],
    basis: "assumption",
    note: `${year} federal brackets, standard deduction and wage base are not published yet: ${last}'s are used.`,
    // The IRS revenue procedure comes out in October / November, the SSA wage base in October.
    staleAfter: `${year - 1}-11-30`,
  };
}

// ─── Georgia ──────────────────────────────────────────────────────────────────────────────────

function gaFor(year: number): GaTable {
  const published: GaTable = { rate: 4.99, standardDeduction: 15_000, basis: "published", note: null, sources: [SRC.ga2026, SRC.gaHb463], staleAfter: null };
  if (year === 2026) return published;
  if (year < 2026) return { ...published, basis: "assumption", note: `Georgia ${year} is not in the tables: 2026's 4.99% and $15,000 are used.` };
  return {
    ...published,
    basis: "assumption",
    note:
      `HB 463 schedules a 0.125-point rate cut and a $375 larger standard deduction each year from 2027 (down to 3.99% and up to $18,000), ` +
      `each step delayed a year when any of its three revenue conditions fails as of December 1 (O.C.G.A. 48-7-27(a)(1.1); the Office of Planning and Budget reports by December 1). ` +
      `Until the report for ${year} is entered here, ${year} uses 2026's 4.99% and $15,000 (the higher tax).`,
    staleAfter: `${year - 1}-12-15`,
  };
}

// ─── North Carolina ───────────────────────────────────────────────────────────────────────────

const NC_STD = 12_750;
const NC_RATES: { from: number; to: number; rate: number; source: TableSource }[] = [
  { from: 2026, to: 2026, rate: 3.99, source: SRC.ncRates },
  { from: 2027, to: 2029, rate: 3.49, source: SRC.ncSl202641 },
  { from: 2030, to: 2032, rate: 3.24, source: SRC.ncSl202641 },
  { from: 2033, to: 2034, rate: 2.99, source: SRC.ncSl202641 },
];
const ncWithholding = (rate: number): number => Math.round((rate + 0.1) * 100) / 100;
/** The latest year whose NC-30 (withholding tables) is issued. */
const NC_LAST_NC30 = 2026;

function ncFor(year: number): NcTable {
  const hit = NC_RATES.find((r) => year >= r.from && year <= r.to);
  if (hit) {
    // The rate is enacted; the withholding rate is published only in that year's NC-30, so after the latest NC-30
    // (2026) it is derived with the NC-30 rule (rate + 0.10) and says so.
    const wh = ncWithholding(hit.rate);
    const note = year > NC_LAST_NC30 ? `Withholding ${wh}% is derived as the rate + 0.10 (the NC-30 rule) until the NC-30 for ${year} is issued.` : null;
    return { rate: hit.rate, standardDeduction: NC_STD, supplementalRate: wh, basis: "published", note, sources: [hit.source, SRC.ncStd, SRC.ncWh], staleAfter: null };
  }
  const edge = year < NC_RATES[0].from ? NC_RATES[0] : NC_RATES[NC_RATES.length - 1];
  return {
    rate: edge.rate,
    standardDeduction: NC_STD,
    supplementalRate: ncWithholding(edge.rate),
    basis: "assumption",
    note: year < edge.from ? `North Carolina ${year} is not in the tables: ${edge.rate}% is used.` : `S.L. 2026-41 allows further trigger-based cuts from 2035 (down to 2.49%); ${year} uses ${edge.rate}%.`,
    sources: [edge.source, SRC.ncStd, SRC.ncWh],
    staleAfter: null,
  };
}

// ─── New York State and City ──────────────────────────────────────────────────────────────────

const NY_RECAPTURE: NyRecapture = { startAgi: 107_650, phaseIn: 50_000, flatAbove: 25_000_000, firstLevel: 4 };
const nyBrackets = (low: [number, number, number, number, number]): Bracket[] => [
  { upTo: 8_500, rate: low[0] },
  { upTo: 11_700, rate: low[1] },
  { upTo: 13_900, rate: low[2] },
  { upTo: 80_650, rate: low[3] },
  { upTo: 215_400, rate: low[4] },
  { upTo: 1_077_550, rate: 6.85 },
  { upTo: 5_000_000, rate: 9.65 },
  { upTo: 25_000_000, rate: 10.3 },
  { upTo: null, rate: 10.9 },
];
const NY_2026 = nyBrackets([3.9, 4.4, 5.15, 5.4, 5.9]);
const NY_2027_2032 = nyBrackets([3.8, 4.3, 5.05, 5.3, 5.8]);

function nyFor(year: number): NyTable {
  const base = { standardDeduction: 8_000, recapture: NY_RECAPTURE, staleAfter: null };
  if (year === 2026) return { ...base, single: NY_2026, basis: "published", note: null, sources: [SRC.nyLaw, SRC.ny2105] };
  if (year >= 2027 && year <= 2032) return { ...base, single: NY_2027_2032, basis: "published", note: null, sources: [SRC.nyLaw] };
  if (year < 2026) return { ...base, single: NY_2026, basis: "assumption", note: `New York ${year} is not in the tables: 2026's rates are used.`, sources: [SRC.nyLaw] };
  return { ...base, single: NY_2027_2032, basis: "assumption", note: `Tax Law 601(c)(1)(ix) lowers the top rate to 8.82% after 2032; ${year} uses the 2027-2032 table.`, sources: [SRC.nyLaw] };
}

const NYC_SINGLE: Bracket[] = [
  { upTo: 12_000, rate: 3.078 },
  { upTo: 25_000, rate: 3.762 },
  { upTo: 50_000, rate: 3.819 },
  { upTo: null, rate: 3.876 },
];
function nycFor(year: number): NycTable {
  return { single: NYC_SINGLE, basis: "published", note: year > 2026 ? "Current law (no change enacted); the instructions for this year are not issued yet." : null, sources: [SRC.nyc], staleAfter: null };
}

// ─── Lookup ───────────────────────────────────────────────────────────────────────────────────

/** Tables for a year, every jurisdiction with its provenance. Years without published figures are assumptions. */
export function taxTables(year: number): YearTables {
  const t = { year, federal: federalFor(year), ga: gaFor(year), nc: ncFor(year), ny: nyFor(year), nyc: nycFor(year) };
  const notes = [t.federal, t.ga, t.nc, t.ny, t.nyc].filter((x) => x.basis === "assumption" && x.note).map((x) => x.note as string);
  return { ...t, estimated: notes.length ? notes.join(" ") : null };
}

// ─── Arithmetic ───────────────────────────────────────────────────────────────────────────────

/** Tax on `income` dollars through a bracket list. */
export function bracketTax(income: number, brackets: readonly Bracket[]): number {
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    const upper = b.upTo ?? Infinity;
    if (income <= lower) break;
    tax += ((Math.min(income, upper) - lower) * b.rate) / 100;
    lower = upper;
  }
  return tax;
}
/** The top rate a taxable income reaches. */
export function marginalRate(income: number, brackets: readonly Bracket[]): number {
  for (const b of brackets) if (b.upTo === null || income <= b.upTo) return b.rate;
  return brackets[brackets.length - 1].rate;
}
/** Round to the fourth decimal place, as the New York worksheets and the IT-203 income percentage do. */
export const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * New York State resident tax on `taxable` dollars for a filer with `nyagi` dollars of NY AGI, including the tax
 * benefit recapture (tax computation worksheets 7-11 of IT-2105-I (2026), single). The worksheets' recapture base and
 * incremental benefit are derived from the brackets (within $2 of the published amounts, which round the schedule).
 */
export function nyResidentTax(nyagi: number, taxable: number, ny: Pick<NyTable, "single" | "recapture">): number {
  const b = ny.single;
  const sched = bracketTax(taxable, b);
  const rc = ny.recapture;
  if (!rc || taxable <= 0 || nyagi <= rc.startAgi) return sched;
  if (nyagi > rc.flatAbove) return (taxable * b[b.length - 1].rate) / 100;
  const k = b.findIndex((x) => x.upTo === null || taxable <= x.upTo);
  if (k <= rc.firstLevel) {
    // Worksheet 7: the first-level rate on all taxable income, phased in over NY AGI above startAgi.
    const flat = (taxable * b[rc.firstLevel].rate) / 100;
    if (nyagi >= rc.startAgi + rc.phaseIn) return flat;
    return sched + (flat - sched) * round4((nyagi - rc.startAgi) / rc.phaseIn);
  }
  // Worksheets 8-10: taxable income in bracket k above the first level, starting at `lower`.
  const { base, incremental, lower } = nyRecaptureAmounts(b, k);
  return sched + base + incremental * round4(Math.min(Math.max(0, nyagi - lower), rc.phaseIn) / rc.phaseIn);
}
/** A worksheet's recapture base and incremental benefit for taxable income in bracket `k` (k > the first level). */
export function nyRecaptureAmounts(brackets: readonly Bracket[], k: number): { base: number; incremental: number; lower: number } {
  const lower = brackets[k - 1].upTo as number;
  const base = (lower * brackets[k - 1].rate) / 100 - bracketTax(lower, brackets);
  const incremental = (lower * (brackets[k].rate - brackets[k - 1].rate)) / 100;
  return { base, incremental, lower };
}
