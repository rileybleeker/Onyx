/**
 * Tax tables for planning (docs/cash-flow-forecast.md, Section 7.2). Planning estimates, not filing values.
 * Every figure names its source; a year whose official figures were not known when this was written runs on
 * the previous year's numbers and says so (`estimated`).
 */

export interface Bracket {
  upTo: number | null; // dollars of taxable income; null = no upper bound
  rate: number; // percent
}
export interface YearTables {
  year: number;
  estimated: string | null; // why a figure is an estimate, or null
  federal: {
    single: Bracket[];
    standardDeduction: number;
    supplementalRate: number;
    ssWageBase: number;
    ssRate: number;
    medicareRate: number;
    addlMedicareThreshold: number;
    addlMedicareRate: number;
    sources: string[];
  };
  ga: { rate: number; exemption: number; note: string; sources: string[] };
  nc: { rate: number; standardDeduction: number; supplementalRate: number; sources: string[] };
  ny: { single: Bracket[]; standardDeduction: number; note: string; sources: string[] };
  nyc: { single: Bracket[]; sources: string[] };
}

const FED_2026: Bracket[] = [
  { upTo: 12_400, rate: 10 },
  { upTo: 50_400, rate: 12 },
  { upTo: 105_700, rate: 22 },
  { upTo: 201_775, rate: 24 },
  { upTo: 256_225, rate: 32 },
  { upTo: 640_600, rate: 35 },
  { upTo: null, rate: 37 },
];
// NY single brackets before the 2026 budget's small cuts to the lower rates (slightly conservative).
const NY_SINGLE: Bracket[] = [
  { upTo: 8_500, rate: 4 },
  { upTo: 11_700, rate: 4.5 },
  { upTo: 13_900, rate: 5.25 },
  { upTo: 80_650, rate: 5.5 },
  { upTo: 215_400, rate: 6 },
  { upTo: 1_077_550, rate: 6.85 },
  { upTo: 5_000_000, rate: 9.65 },
  { upTo: 25_000_000, rate: 10.3 },
  { upTo: null, rate: 10.9 },
];
const NYC_SINGLE: Bracket[] = [
  { upTo: 12_000, rate: 3.078 },
  { upTo: 25_000, rate: 3.762 },
  { upTo: 50_000, rate: 3.819 },
  { upTo: null, rate: 3.876 },
];

const Y2026: YearTables = {
  year: 2026,
  estimated: null,
  federal: {
    single: FED_2026,
    standardDeduction: 16_100,
    supplementalRate: 22,
    ssWageBase: 184_500,
    ssRate: 6.2,
    medicareRate: 1.45,
    addlMedicareThreshold: 200_000,
    addlMedicareRate: 0.9,
    sources: ["IRS Rev. Proc. 2025-32 (2026 brackets, standard deduction)", "SSA 2026 contribution and benefit base"],
  },
  ga: {
    rate: 5.09,
    exemption: 12_000,
    note: "Flat rate 5.09% used; 4.99% if the 2026 cut (HB 463) applies. Check the Georgia DOR rate.",
    sources: ["Georgia HB 1437 / HB 111 flat-tax schedule; standard exemption $12,000 single"],
  },
  nc: { rate: 3.99, standardDeduction: 12_750, supplementalRate: 4.09, sources: ["NC flat rate 3.99% for 2026 (2022 schedule)", "NC standard deduction $12,750 single"] },
  ny: {
    single: NY_SINGLE,
    standardDeduction: 8_000,
    note: "Pre-2026-cut brackets; the high-income recapture is not modeled.",
    sources: ["NY Tax Law 601 single brackets", "NY standard deduction $8,000 single"],
  },
  nyc: { single: NYC_SINGLE, sources: ["NYC resident income tax rates (Form IT-201 instructions)"] },
};

const Y2027: YearTables = {
  ...Y2026,
  year: 2027,
  estimated: "2027 federal brackets, standard deduction and Social Security wage base use the 2026 figures until the 2027 ones are entered.",
  ga: { ...Y2026.ga, rate: 4.99, note: "4.99% (the scheduled floor of the phase-down). Check the Georgia DOR rate." },
  nc: { ...Y2026.nc, rate: 3.49, supplementalRate: 3.59, sources: ["NC S.B. 257 (2026): 3.49% for 2027 to 2029"] },
};

const TABLES: Record<number, YearTables> = { 2026: Y2026, 2027: Y2027 };

/** Tables for a year; a later year falls back to the latest known with an `estimated` note. */
export function taxTables(year: number): YearTables {
  if (TABLES[year]) return TABLES[year];
  const latest = Math.max(...Object.keys(TABLES).map(Number));
  return { ...TABLES[latest], year, estimated: `${year} uses the ${latest} tables (not updated yet).` };
}

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
