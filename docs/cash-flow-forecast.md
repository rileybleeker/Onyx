# Cash flow forecast, tax planning and what-if scenarios: design

Status (2026-11-14): design only, nothing built. Roadmap row: "Cash flow forecast + tax planning" (Tasks DB,
`Source = "Onyx Roadmap"`). This file holds no personal figures (the repo is public); every real amount lives in the
service-role tables proposed below and is entered through the page.

## 1. Result first

Onyx gets a **Forecast** tab on `/financials` that answers four questions, each as one headline number with its reason:

1. **Lowest cash point:** the lowest balance the cash accounts reach in the next 13 weeks, and the date it happens.
2. **Safe to move:** how much can go to savings or investments today and still stay above the buffer line on the
   low-cash path for the whole horizon.
3. **Tax position for the year:** projected tax for the year minus what is being withheld or paid, so the amount
   owed in April (or the refund), and whether the safe harbour is met (so whether a penalty is likely).
4. **What if:** the same three numbers under a scenario (bonus later, move earlier, more 401(k), extra withholding,
   consulting income, a big purchase), shown side by side with the base plan.

It must work before Riley configures anything (Section 6.1), and every number on it must say where it came from.

## 2. Requirements (Riley, 2026-11-14)

| Requirement | Where it is met |
|---|---|
| Forecast cash flows using best practices | Sections 3 and 4 |
| Configurable and easy to use | Sections 5 and 6 |
| Outside inputs / drivers | Section 5.3 |
| Plan for taxes | Section 7 |
| Run what-if scenarios | Section 8 |

## 3. Best practices it follows

These come from corporate treasury and FP&A practice, scaled down to one person.

1. **Direct method, by date.** The forecast is cash in and cash out on the day it hits the account, not income and
   expense by month. A card purchase does not move cash; the card payment does.
2. **Two horizons, rolling.** 13 weeks by day and week (the treasury standard: accurate enough to act on) and 12 months
   by month (planning). Both are recomputed from the latest ledger every time the page loads, so there is never a
   stale "version" to maintain.
3. **Driver-based.** Every projected line is computed from named drivers (pay per check, bonus amount and date, rent,
   move date, withholding rate, spending multiplier). Change a driver and every line that uses it changes. The driver
   list doubles as the **assumption register**: each driver carries its source, the date it was last checked and a note.
4. **Layered by certainty.** Each line is tagged *committed* (known amount and date: rent, a paycheck), *detected*
   (a pattern found in the ledger: a subscription, a card payment), *baseline* (statistical everyday spending) or
   *planned* (an event Riley entered: bonus, move, trip). The page can show any layer on its own.
5. **Actuals replace forecast.** When a planned item happens, the matching transaction takes its place (Section 4.5).
   A planned item is never counted twice and never silently projected after its date.
6. **Asymmetric caution.** An expected inflow that is late is dropped from the forecast and flagged ("did the bonus
   arrive?"); an expected outflow that is late is kept and moved to today. Late money in is not counted; late money
   out still is.
7. **A range, not one line.** Everyday spending is uncertain, so the balance is drawn as a likely line with a low and a
   high band (Section 4.4). Alerts use the low band.
8. **Measured accuracy.** Each week the forecast is saved, and later compared with what happened (Section 9). The
   method is backtested on history before it ships.
9. **Buffer line.** One number Riley picks: the balance never to go below. Everything warns against it.
10. **Taxes are cash events.** Withholding, estimated payments, the April balance and refunds are dated cash lines in
    the same forecast, not a separate report.
11. **Rule-based and explainable.** No model reads finance data (the existing Onyx rule). Every line is code with a
    reason string a person can check.

## 4. The model

### 4.1 Cash pool

The forecast tracks a **cash pool**: the account(s) Riley pays bills from (default: every account whose
`account_type` is Cash; Riley can untick any). A transfer between two pool accounts nets to zero. Money leaving the
pool for a card, a brokerage or an outside account is an outflow, even though `/financials` files it under
`NON_SPENDING_CATEGORIES` (spending reports ask "what did I buy", the forecast asks "where did cash go").

Opening balance = the latest `finance_balance_snapshots` row per pool account. A balance older than
`STALE_BALANCE_HOURS` puts a stale badge on the whole forecast.

### 4.2 Sign convention

The ledger is expense-positive. Forecast lines use **balance-positive** amounts (money in is +, money out is −).
The conversion happens in exactly one function, `toBalanceDelta()`, so the two conventions never mix.

### 4.3 Lines, in the order they are built

| Layer | Line | How it is projected |
|---|---|---|
| committed / detected | **Paychecks** | Recurring deposits into the pool, detected by cadence (weekly, biweekly, semimonthly, monthly), amount = median of the last 3 net deposits. A pay date on a weekend or a US federal holiday moves to the business day before. Drivers can override amount, schedule, raise date and raise %. |
| detected | **Bills and subscriptions** | `procurement-recurring.ts` (already built) for purchases, extended with the same rules for pool debits such as rent and utilities. Only high and medium confidence rows are projected; low ones are listed as "not projected". |
| detected | **Card payments** | For each card: the day of month it is usually paid from the pool (from past Credit Card Payment pairs) and the amount = card spending in the statement window before it. Card spending itself comes from the baseline below. Apple Card data arrives monthly, which this handles because only the payment touches the pool. |
| baseline | **Everyday spending** | Weekly variable spending per account (cards and pool debits), excluding everything already modeled as a line above or a planned item below. Likely value = median of the last 26 weeks, times an inflation driver, times an optional per-category multiplier. Modeled in total, with categories for display only, because SimpleFIN rows are often Uncategorized. |
| planned | **Events** | Riley's items from templates (Section 6.3), expanded by their schedule. |
| planned | **Taxes** | Generated by the tax plan (Section 7): estimated payments, the April balance or refund, state refunds. |
| planned | **Sweeps** | Optional rule: "move anything above $X to savings on payday". |

Daily path: opening balance + the sum of lines per day → weekly and monthly rollups.

### 4.4 The range

The low and high bands come from a **block bootstrap** of past weekly variable spending (4-week blocks, 500 paths,
seeded so the page is stable), the same family of method Onyx uses for HRV. Planned items add their own spread
through their certainty:

| Certainty | Likely line | Low-cash path |
|---|---|---|
| confirmed | included | included |
| likely | included | inflows slip past the horizon, outflows included |
| possible | left out | outflows included, inflows left out |

The low band is the 10th percentile of the paths. "Lowest cash point" and "safe to move" use it.

### 4.5 Matching actuals

A planned item is *realized* when a pool transaction with the same direction lands within its window (default ±5
days for a dated item, ±10% of the amount, configurable per item). The match is stored on the item
(`matched_txn_key`) and shown ("arrived on Mar 14, $X, 3% under plan"). Riley can unmatch it with one tap.

## 5. Drivers and outside inputs

### 5.1 What a driver is

A driver is one named input: `key`, `label`, `value` (amount, %, date, count or yes/no), `group` (Income, Housing,
Taxes, Spending, Savings, Settings), `effective_from` / `effective_to`, `source`, `source_ref`, `pinned`,
`reviewed_at`, `note`. A scenario overrides drivers; it never edits the base.

### 5.2 Precedence

Riley (pinned) > document (a value Riley entered from a pay stub, offer letter or tax return, with its date) >
Onyx-derived (detected from the ledger or another Onyx table) > default. An automatic source never overwrites a
pinned value, the same rule as manual weight over Tanita and `is_excluded` over the ETL.

### 5.3 Where drivers can come from

| Source | Examples | How |
|---|---|---|
| Riley, on the page | buffer line, bonus date, move month, NYC rent, 401(k) % | inline edit or a template |
| Documents (entered once, dated) | pay per period, year-to-date withholding, bonus target and pay month, last year's total tax | the "From your documents" form (Section 7.3); the value shows "from pay stub of Oct 31" |
| The ledger (automatic) | net pay and pay schedule, rent, subscriptions, card payment days, everyday spending | detectors in Section 4.3 |
| Other Onyx tables (suggestions) | trips from `pds.calendar_events` and `pds.flights` → "add a trip?"; a chosen NYC lead's rent → "use this as NYC rent?"; renewals from `/procurement` | shown as suggestions Riley accepts with one tap, never added silently |
| Public data | tax brackets, standard deductions, wage bases, state rates per year; optionally CPI for the inflation default | versioned tables in the code with their sources (Section 7.2) |
| File import | a CSV of drivers or events (`key,value,date,note`), e.g. exported from a comp sheet | upload on the page, preview, then save |

Agents never write drivers. Whether an agent may *suggest* one through `/agents` is decision D3 (Section 12).

### 5.4 Keeping drivers honest

Each driver has a review interval (default 90 days; 45 for year-to-date pay stub figures). An overdue driver gets a
"check this" chip. A document value whose year has ended (for example last year's pay stub) stops being used.

## 6. Easy to use

### 6.1 Works with no setup

On the first visit the forecast is drawn from the ledger alone: pool, opening balance, paychecks, bills, card
payments, everyday spending. A short list says what it assumed ("Paychecks: $X every other Friday, from your last 3
deposits") and what would make it better ("Add your latest pay stub numbers: 2 minutes").

### 6.2 One screen

- Top: the four headlines from Section 1.
- Chart: projected balance (likely line, low-high band, buffer line), actuals to the left of today.
- Next 30 days: every line with date, amount, layer and a "why" link.
- **Assumptions:** the drivers as plain sentences with editable values ("A bonus of **$X** paid on **Mar 15**, about
  **$Y** after tax"). Editing recomputes at once in the browser; Save keeps it.
- **Scenarios:** tabs (Base, then saved scenarios) and a Compare view (Section 8).
- **Taxes:** Section 7.

### 6.3 Templates for planned events

Bonus, Raise, Move (old rent ends, new rent starts, deposit, broker fee, movers), Trip, Big purchase, Tax payment or
refund, Transfer to savings or investments, Custom (one-off or repeating). Each asks only for what it needs and
fills the rest from drivers (a Bonus asks for gross and date; withholding comes from the tax drivers).

### 6.4 Configuration

On the page: cash pool, buffer line, horizon (13 weeks / 12 months), how cautious the low band is (10th or 25th
percentile), lookback for everyday spending (13 / 26 / 52 weeks). Method constants that Riley does not need day to
day (match window, bootstrap size, review intervals) live in one file, `lib/cash-forecast-config.ts`.

### 6.5 Alerts (only when Riley can act)

Following the "only surface what needs Riley" rule, the forecast speaks up only when:
- the low band crosses the buffer line within 30 days;
- a safe-harbour shortfall exists and a payment deadline is within 30 days;
- a planned inflow is late (did it arrive?).

Shown on Today as a panel when one is true; an `/agents` card only if D3 says so.

## 7. Tax planning

### 7.1 What it computes

For the current tax year and the next:

1. **Projected income:** pay to date (pay stub) + remaining paychecks (forecast) + bonuses and other planned income
   + other income drivers (consulting, interest, dividends, capital gains), minus pre-tax deductions (401(k), HSA,
   health premiums).
2. **Federal tax:** brackets and standard deduction for the year and filing status; Social Security up to the wage
   base; Medicare plus the additional 0.9% above the threshold; self-employment tax on consulting income (only the
   Medicare part once wages pass the wage base).
3. **State tax, by residency period:** resident state for each part of the year (driver: move date), work-state days
   (driver: share of work days physically in another state), the other state's tax on that share, and the resident
   state's credit for it. Part-year rules for a move (for example Georgia to New York, including New York City tax).
4. **Withholding to year end:** year-to-date withholding from the pay stub + per-paycheck withholding for the rest of
   the year + supplemental withholding on bonuses (federal flat rate, state supplemental rate), per state as it is
   actually withheld (which can differ from the state of residence).
5. **The gap:** tax − withholding − estimated payments = owed in April or refunded, per jurisdiction.
6. **Safe harbour:** required payments = the smaller of 90% of this year's tax or 100% / 110% (above the AGI
   threshold) of last year's tax (driver from last year's return), checked per quarter.
7. **Fix options**, each priced in cash and dates: (a) extra withholding per remaining paycheck (a new W-4 / state
   form), (b) an estimated payment by the next due date, (c) do nothing and pay in April (with the expected penalty).
   Extra withholding is listed first when there is a shortfall from earlier quarters, because withholding counts as
   paid evenly through the year while an estimated payment counts from the day it is made.

The results become dated lines in the forecast (Section 4.3): estimated payments on their due dates, the April
balance on April 15, a refund about 3 weeks after the planned filing date (driver).

### 7.2 Tax tables

`lib/tax-tables/<year>.ts`: one file per year with every number and the URL it came from (IRS revenue procedure,
SSA wage base, state revenue department). Tests check the engine against worked examples published by the IRS and
the states. When next year's figures are not published yet, the year runs on this year's tables with a visible
"estimated with <year> tables" label.

### 7.3 Inputs from documents (entered once, refreshed rarely)

| Document | Fields | Refresh |
|---|---|---|
| Latest pay stub | pay frequency, gross per period, pre-tax deductions per period, year-to-date gross, year-to-date federal, state (and which state), Social Security and Medicare withheld | every quarter, and after a bonus paycheck |
| Offer letter / comp plan | base, bonus target and whether it is guaranteed, bonus pay month, signing bonus and its repayment terms, profit share timing, 401(k) match | when it changes |
| Last year's return | filing status, AGI, total federal tax, total state tax per state | once a year |
| Withholding forms | federal W-4 and state forms on file (often printed on the pay stub) | when changed |
| Other income | expected consulting income, last year's interest / dividends / capital gains as a default | yearly |

The form asks for these fields only, never the document itself, and stores them as document drivers with the
document's date. No document file is stored in Onyx. Entering them by hand keeps them out of any model; Claude
reading a document in a chat sends it to Anthropic and is Riley's choice each time (D5).

### 7.4 Limits (said on the page)

Planning estimates, not a filed return and not tax advice. Not modeled at first: itemized deductions, AMT, credits,
equity compensation, the qualified-dividend rate, state-specific deductions beyond the standard exemption. A
preparer files the return (D6).

## 8. What-if scenarios

- **Quick what-if:** sliders and toggles over the main drivers (bonus % of target, bonus month, move month, NYC rent,
  401(k) %, extra withholding per check, consulting income, one big purchase). Nothing is saved; the headlines and
  chart update in the browser as they move.
- **Saved scenarios:** "Save as scenario" stores the overrides under a name. The base plan is never edited by a
  scenario.
- **Compare:** up to three scenarios side by side: lowest cash point and date, safe to move, cash at 13 weeks and 12
  months, tax owed or refunded, safe harbour met or not.
- **Sensitivity (later):** which driver moves the lowest cash point most, as a ranked list (a tornado chart).

Because the engine is pure and runs in the browser on aggregates the server sends (Section 10), a what-if never
needs a round trip and never reads the raw ledger in the browser.

## 9. Accuracy

- **Backtest before shipping:** run the engine "as of" each Monday of the past 18 months on the ledger as it stood
  then (the engine takes `today` as an argument). Measure the error of the 1-, 4- and 13-week balance forecast
  (median absolute error, bias, and how often the actual balance fell below the low band; it should be about 10%).
  The script prints these aggregates only.
- **Live tracking:** a weekly job saves each week's forecast (likely, low, high balance per future week) to
  `pds.finance_forecast_snapshots`, and the page shows forecast versus actual for the last 8 weeks.
- The job writes a `finance_forecast|snapshot` heartbeat on every run, and `/status` gets a Cash Forecast card
  (the "every integration on /status" rule).

## 10. Architecture (follows the existing finance pattern)

- **Pure libraries, no I/O:** `lib/cash-forecast.ts` (pool, lines, path, range, matching), `lib/tax-plan.ts`,
  `lib/tax-tables/<year>.ts`, `lib/cash-forecast-config.ts`. They run on the server, in the browser for what-ifs,
  and in offline tests with synthetic data.
- **Server loader:** `lib/cash-forecast-server.ts` (`server-only`, service role, explicit columns) reads the ledger,
  balances, drivers, items and scenarios, and sends the browser **aggregates** (weekly spend series, detected
  streams, balances, drivers), never the transaction list.
- **Tables** (one SQL file, `sql/finance_forecast_schema.sql`, service role only like the rest of finance: RLS on, no
  policies, no grants to anon or authenticated):
  - `pds.finance_plan_scenarios` (id, name, is_base, created_at, archived_at)
  - `pds.finance_plan_drivers` (id, scenario_id null = base, key, group, value jsonb, unit, effective_from,
    effective_to, source, source_ref, pinned, reviewed_at, note)
  - `pds.finance_plan_items` (id, scenario_id, template, label, params jsonb, schedule jsonb, certainty, status
    planned / realized / cancelled, matched_txn_key, created_at, updated_at, removed_at)
  - `pds.finance_forecast_snapshots` (as_of, scenario_id, week_start, likely_cents, low_cents, high_cents)
- **Routes:** `/api/finance/forecast/*`, owner session only, same-origin JSON, size-capped, strict about unknown
  fields, error codes only in logs (same as `/api/care/*`). Never in `isCiRoute()` unless D3 adds one exact claim
  path.
- **Page:** a tab on `/financials`, `force-dynamic` and `noindex` like the rest of it (never ISR).
- **Snapshot job:** a small Node script run weekly by GitHub Actions with the Supabase secrets (no HTTP route); the
  Actions log is public, so it prints counts only.
- **Never moves money.** No route, button or job pays, transfers or files anything, the same rule as `/procurement`.
- **No real figures in the repo:** tests, fixtures, logs, PR text and commit messages use synthetic numbers only.

## 11. Build plan

| Phase | Builds | Done when |
|---|---|---|
| 1. Engine | `cash-forecast.ts` with paychecks, bills, card payments, baseline, range, matching; backtest script | backtest error and band coverage reported; Riley sees the numbers |
| 2. Page | Forecast tab, zero-setup forecast, assumptions as sentences, templates, settings, tables + routes | Riley can enter a bonus and a move and see the lowest cash point |
| 3. Taxes | `tax-plan.ts`, tax tables for the current and next year, documents form, tax lines in the forecast, fix options | the tax gap and safe harbour match a hand check on synthetic cases and Riley's own numbers |
| 4. What-if | quick sliders, saved scenarios, compare view | three scenarios compare on one screen |
| 5. Tracking and alerts | snapshot job, heartbeat, `/status` card, forecast vs actual, Today panel, outside-input suggestions, CSV import | first 4 weeks of snapshots recorded |

## 12. Decisions for Riley

| # | Decision | Recommendation |
|---|---|---|
| D1 | Cash pool: checking only, or checking + savings? | Checking only; savings shown as a reserve line |
| D2 | Buffer line amount | Riley picks; one month of fixed costs is a common rule |
| D3 | May the forecast post an `/agents` card (buffer breach, tax deadline, late inflow)? It needs one exact CI path, like renewals, carrying no amounts | Yes, with no amounts in the card |
| D4 | Pay stub numbers: type them in each quarter, or automate the payroll site later? | Type them in quarterly; revisit only if it becomes a chore |
| D5 | For the first setup, should Claude read the documents and fill the form? (Sends them to Anthropic.) | Riley's call; typing the ~15 fields is the private route |
| D6 | Tax scope: planning only, with a preparer filing | Yes |
