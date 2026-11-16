/**
 * Method constants for the cash flow forecast (lib/cash-forecast.ts). Riley does not need these day to day;
 * the settings Riley can change on the page (cash pool, buffer line, horizon, lookback, how cautious the low
 * band is) are ForecastSettings and override the matching defaults here. Design: docs/cash-flow-forecast.md.
 */
export const FORECAST = {
  /** Days projected (12 months). */
  horizonDays: 365,
  /** The "13 weeks" window used for the lowest point and safe-to-move. */
  shortHorizonDays: 91,
  /** Weeks of history the everyday-spending baseline uses. */
  lookbackWeeks: 26,
  /** Days of history the stream detectors read. */
  detectWindowDays: 400,
  /** Bootstrap paths per band, and weeks per resampled block. */
  paths: 500,
  blockWeeks: 4,
  /** Percentiles of the low and high bands. */
  lowPercentile: 0.1,
  highPercentile: 0.9,
  /** Fixed seed, so the same ledger always draws the same bands. */
  seed: 20261114,
  /** Planned items: a matching transaction within this many days before (or up to lateMatchDays after) the date, within this share of the amount. */
  matchWindowDays: 5,
  lateMatchDays: 31,
  matchTolerance: 0.1,
  /** A pool balance older than this marks the forecast stale (and withholds the safe-to-move amount). */
  staleBalanceHours: 48,
  /** A pool balance smaller than this never marks the forecast stale (a small account that rarely updates). */
  smallBalanceCents: 10_000,
  /** A pool balance dated more than this far after `now` is not valid (clock skew allowance). */
  futureBalanceSkewMs: 3_600_000,
  /** Pairing windows: transfers between two pool accounts, and a pool payment to a card. */
  internalPairDays: 3,
  cardPairDays: 5,
  /** Streams: occurrences needed, share of gaps inside the cadence band, amount band around the usual amount. */
  minOccurrences: 3,
  minInBand: 0.7,
  amountBand: 0.4,
  /** A stream is stopped when its last occurrence is older than this many cycles. */
  lapseCycles: 1.6,
  /** Card payments: a card's monthly total paid = mean of the last N complete months; the range samples the last M months.
   *  6 / 12 since the 2026-11-14 backtest: payments are lumpy, and a 3-month mean raised the 13-week error. */
  cardMeanPayments: 6,
  cardSamplePayments: 12,
  /** One-off rows (left out of the everyday baseline): above max(this, 3 x the 95th percentile row). */
  oneOffMinCents: 100_000,
  oneOffP95Multiple: 3,
  /** Weeks of history below which the everyday baseline is not projected. */
  minBaselineWeeks: 4,
  /** Net worth side: default expected annual return of investment accounts, and the APR assumed after a promo when the standard APR is unknown. */
  defaultReturnPct: 5,
  defaultStandardAprPct: 24,
  /** Months of card spending used for the card-balance projection. */
  cardSpendMonths: 6,
} as const;
