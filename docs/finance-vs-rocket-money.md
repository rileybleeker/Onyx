# Onyx finance vs Rocket Money: feature comparison

Status 2026-11-14. Pages: `/financials` (ledger), `/financials/budgets`, `/financials/forecast`, `/procurement`,
Today's Money panel. Rocket Money features are taken from its public product pages (budgeting, subscriptions,
net worth, credit score, bill negotiation, Smart Savings, cancellation concierge).

| Rocket Money feature | Onyx | Where / how |
|---|---|---|
| Account aggregation (banks, cards, investments) | Yes | SimpleFIN Bridge every 6 hours (Rocket Money history before 2026-11-14). Apple Card monthly, Apple Cash not offered. |
| Transactions list, search, filters | Yes | `/financials` |
| Automatic categories | Partly | Categories from the source and learned from history; about 30% of SimpleFIN rows arrive uncategorized. |
| Recategorize a transaction, merchant rules | Yes | Click a category on `/financials` ("This one" / "All from this merchant"); uncategorized merchants queue on `/financials/budgets`. |
| Budgets by category, overall budget | Yes | `/financials/budgets`: spent, pace, projected month end, suggested budgets (3-month median), starter budgets set. |
| Spending insights (vs last month, top merchants) | Yes | Budgets: "spending more than usual" (same days of the month vs the 3-month average), biggest merchants, income vs spending. |
| Subscriptions detected | Yes | Budgets (and `/procurement`): cadence, next charge, monthly cost; price increases, duplicates and unused apps flagged on `/procurement`. |
| Subscription cancellation concierge | Equivalent without acting | Onyx never cancels for you (decision 2026-11-11). Budgets has "How to cancel" (a search for the merchant's cancel page) and "I cancelled it", then checks the ledger: waiting, stopped, or still charging. |
| Bill negotiation | No (by design) | Onyx does not contact providers. Price-increase flags on `/procurement` show where to push back. |
| Upcoming bills and renewals | Yes | Forecast "Next 30 days", renewal alerts on Today and in /agents. |
| Net worth | Yes, plus projection | `/financials` (today) and `/financials/forecast` (24-month projection: cash forecast, investments at an assumed return plus contributions such as the SEP IRA, card balances after payments, interest and promo ends). |
| Savings goals | Yes (tracking) | Forecast page: progress from real balances, monthly amount needed, forecast check. |
| Smart Savings (automatic transfers) | Equivalent without acting | Onyx never moves money. "Safe to move" (and the weekly amount) says how much can go to savings without dipping below your line on the cautious path. |
| Alerts (low balance, over budget, large charges) | Yes | Today's Money panel: low cash ahead (forecast), budget over / heading over, 0% promo ending, tax payment due. |
| Credit score | No | No data source connected. |
| **Not in Rocket Money** | | |
| Cash flow forecast with a range | Yes | 13 weeks / 12 months, likely line + 10-90% band; backtested (below). |
| 0% promo deadlines | Yes | Read from balance-transfer rows; milestones on the chart, payment that clears it in time. |
| Tax planning (federal, GA, NC, NY, NYC) | Yes | Withholding vs liability, safe harbour, estimated payments and refunds as dated cash lines. |
| Life-event plan (move, rent change, deposits) and account assumptions | Yes | Plan & assumptions on the forecast page: every value editable; the move date also drives the tax residency change. |
| What-if scenarios | Yes | Bonus size/timing, move date, rent, moving costs, spending, card payoff, 1099 income, 401(k); compare and save. |
| Forecast accuracy tracking | Yes | Weekly snapshots vs actual; `/status` card. |

## Forecast accuracy (backtest, 64 weekly as-of dates over 18 months)

| Horizon | Median error (share of a month's outflows) | Bias | Actual below low band | Actual above high band |
|---|---|---|---|---|
| 1 week | 13.5% | -6.4% | 12.5% | 18.8% |
| 4 weeks | 17.0% | -1.2% | 15.6% | 6.3% |
| 13 weeks | 31.9% | +1.6% | 14.1% | 1.6% |

On average the forecast is now unbiased (it was 10-16% pessimistic before paychecks with changing bank references
were grouped). Deposits with no schedule (transfers in, refunds) are still not forecast until they happen. The history includes a job change (April 2026), which no forecast made before it could know.

## Inputs Onyx derived itself (2026-11-14)

- Job start: the first payroll (April) was a full month, so April 1.
- Pre-tax deductions: about $484 a month, solved from the observed net pay.
- Days worked in North Carolina: about 2%, from calendar events and flights (two Charlotte / Winston-Salem trips).
- Promo end dates: Discover from the balance-transfer row; Citi Diamond estimated (21 months from the 2025-09-17
  transfer) because no document states it.
- Starter budgets: the 3-month median of each category with at least $50 a month.
