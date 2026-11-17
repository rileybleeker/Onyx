# goPuff item harvester

Reads your goPuff order history (which products were in each order and when it arrived) from a
signed-in Chrome profile on this PC and posts it to Onyx. goPuff has no API and no export, and its
emails are not read for items. Snacks, groceries and alcohol show up in about 11 of the last 14
months of spending, so the items matter for nutrition.

## Status: built, waiting for the one-time sign-in (2026-11-17)

Nothing is scheduled yet and the response format has not been checked against a signed-in session.
The harvester was written from what was seen on 2026-11-13: the orders page runs a GraphQL query
named `OrdersByUserId`. It captures the page's own request and replays it with the paging variable
moved forward. Because the field names are not confirmed, it reads them tolerantly and has a
`--probe` mode. The first signed-in run decides whether it works as is.

## What you do once (phone in hand)

1. Sign in to goPuff in a plain Chrome window on the harvester profile (phone number, then the SMS
   code), wait until your past orders show, then **close that window**:

        & "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:LOCALAPPDATA\Onyx\gopuff-harvest-profile" https://www.gopuff.com/orders

2. `npm install` once in this folder, then `node harvest.mjs --probe` (writes `probe-shape.json`:
   key names and value types only, no values) and `node harvest.mjs --dry-run` (prints the newest
   orders, posts nothing). If `--dry-run` shows items, run `node harvest.mjs --full` once to backfill,
   then `pwsh -File register-task.ps1`.
3. If `--dry-run` says "orders were found but none mapped to items" or "paging variable was not
   recognised", the field names differ: the shape in `probe-shape.json` says which, and `lib.mjs`
   (`mapOrder`, `findPagingSlot`) is the one place to adjust.

## Risks accepted (decided 2026-11-17, same class as Uber Eats and Rocket Money)

- goPuff's terms ban robots and data-gathering tools. This reads only your own orders, once per run,
  at human pace, from your own signed-in session.
- The site sits behind a Cloudflare challenge that an ordinary automated Chrome passed without
  interaction on 2026-11-13. The harvester uses a normal off-screen Chrome window and never uses
  stealth flags; if the challenge blocks it, the run says so and stops.

## Privacy

Only product name, quantity, price, order id, delivery time and cancelled state are copied (an
allow-list in `lib.mjs`). The delivery address, phone number, email and payment details in the
response are never read into the posted data, and request headers and cookies are never logged.

## Commands

| Command | What it does |
|---|---|
| `node harvest.mjs` | Normal run: stops at the first page it has already harvested. |
| `node harvest.mjs --full` | Page through the whole available history again. |
| `node harvest.mjs --dry-run` | Fetch and print the newest orders. Posts nothing. |
| `node harvest.mjs --probe` | Write the response's shape (no values) to `probe-shape.json`. Posts nothing. |
| `node harvest.mjs --headed` | Same as a normal run, with the window on screen. |
| `pwsh -File register-task.ps1` | Register (or re-register) the "Onyx goPuff Harvest" task. |

Needs `~/.onyx_ci_token` (the same token the other harvesters use).

## What it writes

- `pds.delivery_order_items` rows with `provider = 'gopuff'` and `merchant_kind = 'store'`, through the
  existing `/api/delivery/items/import` route (`provider: "gopuff"`; no new open route).
- Per-product nutrition estimates in `pds.delivery_item_nutrition` (the estimator queue is shared with
  Uber Eats). goPuff lines are store lines: they are not shown as meals, not in
  `pds.delivery_nutrition_daily` and not asked about on Log, because an ordered multi-pack is not one
  day's intake.
- A `gopuff|items` heartbeat, shown as the "goPuff Items" card on `/status`.

## When the card on /status goes red

| Message | What to do |
|---|---|
| "goPuff session missing or expired" | Sign in again (step 1). |
| "bot check blocked the request" | Nothing to fix here; goPuff has started challenging the window. |
| "response format differs; run --probe" | Run `--probe` and adjust `lib.mjs`. |
| "stopped early: page N failed" | Usually a blip; the next run pages through the same orders again. |
