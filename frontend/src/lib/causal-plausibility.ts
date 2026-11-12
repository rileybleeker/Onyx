// Plausibility guard for the causal AIPW rows on /analytics/hrv.
//
// causal_inference.py (plausibility_flags) writes `implausible` + `implausible_reasons`
// on every row it produces. Rows stored before that guard existed carry neither, so this
// module re-derives the two rules that only need stored fields. Keep the thresholds in
// step with PLAUSIBLE_MAX_ATE_SD / PLAUSIBLE_DISAGREE_SD in causal_inference.py.
//
// Why: the 2026-11-11 retrain stored AIPW effects of -130 ms ("viewed a screen in bed",
// naive +3, PSM +6) against a nightly HRV SD of ~36 ms. Those were estimator blow-ups,
// not effects, and the chart showed them as the headline findings.

export const PLAUSIBLE_MAX_ATE_SD = 1.0;
export const PLAUSIBLE_DISAGREE_SD = 0.5;

export type CausalRowLike = {
  aipw_ate?: unknown;
  naive_ate?: unknown;
  psm_ate?: unknown;
  pooled_outcome_sd?: unknown;
  implausible?: unknown;
  implausible_reasons?: unknown;
};

export type Plausibility = { implausible: boolean; reasons: string[] };

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function signed(n: number): string {
  const r = Math.round(n);
  return `${r > 0 ? "+" : ""}${r}`;
}

export function causalPlausibility(row: CausalRowLike): Plausibility {
  if (typeof row.implausible === "boolean") {
    const reasons = Array.isArray(row.implausible_reasons)
      ? row.implausible_reasons.filter((r): r is string => typeof r === "string")
      : [];
    return { implausible: row.implausible, reasons };
  }
  const reasons: string[] = [];
  const ate = num(row.aipw_ate);
  const sd = num(row.pooled_outcome_sd);
  if (ate !== null && sd !== null && sd > 0) {
    if (Math.abs(ate) > PLAUSIBLE_MAX_ATE_SD * sd) {
      reasons.push(`AIPW ${signed(ate)} ms is larger than one SD of nightly HRV (${Math.round(sd)} ms)`);
    }
    const naive = num(row.naive_ate);
    const psm = num(row.psm_ate);
    const tol = PLAUSIBLE_DISAGREE_SD * sd;
    if (naive !== null && psm !== null && Math.abs(ate - naive) > tol && Math.abs(ate - psm) > tol) {
      reasons.push(
        `AIPW ${signed(ate)} ms is more than ${Math.round(tol)} ms from both naive (${signed(naive)}) and PSM (${signed(psm)})`,
      );
    }
  }
  return { implausible: reasons.length > 0, reasons };
}

// Split rows into the ones a chart may draw and the ones it must hide (with reasons).
export function splitPlausible<T extends CausalRowLike>(rows: T[]): {
  shown: T[];
  hidden: { row: T; reasons: string[] }[];
} {
  const shown: T[] = [];
  const hidden: { row: T; reasons: string[] }[] = [];
  for (const row of rows) {
    const p = causalPlausibility(row);
    if (p.implausible) hidden.push({ row, reasons: p.reasons });
    else shown.push(row);
  }
  return { shown, hidden };
}
