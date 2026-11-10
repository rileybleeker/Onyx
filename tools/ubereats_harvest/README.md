# Uber Eats item harvester

Reads your Uber Eats order history (what was in each order, and exactly when it arrived) from a
signed-in Chrome profile on this PC and posts it to Onyx, which estimates calories and macros per
dish. Receipt emails cannot do this: they do not list the items.

## Status: running

- Scheduled task **"Onyx Uber Eats Harvest"**, every 6 hours, registered 2026-11-10. It runs
  hidden: no console and no window on the desktop.
- First full run 2026-11-10: 220 orders, 583 item lines, 267 distinct dishes estimated.
- Uber's order-history endpoint only goes back about nine months (the first run reached
  2026-02-15). Older orders exist only as receipt emails, which have no items.

## It does not run headless

Uber's bot protection answers headless Chrome with a "Just a moment…" challenge (HTTP 403). The
script does not try to get around that. A scheduled run uses a normal Chrome window parked far
off-screen instead, which Uber serves normally. `--headless` is kept only to re-test the block.

## When the card on /status goes red

| Message | What to do |
|---|---|
| "Uber session missing or expired" | Sign in again (below). |
| "Uber's bot check blocked the request" | Nothing to fix here. If it persists, Uber has started challenging the off-screen window too. |
| "stopped early: page N failed…" | Usually a blip. The next run pages through the same orders again. |
| "N dish(es) still without a nutrition estimate" (amber) | The estimator failed for some dishes; the next run retries them. |

### Signing in again

Use a plain Chrome window on the harvester's profile. That is the route that worked on 2026-11-10;
signing in inside the harvester's own automated window (`--login`) has not been confirmed to work.

    & "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:LOCALAPPDATA\Onyx\ubereats-harvest-profile" https://www.ubereats.com/orders

Sign in ("Log in with QR code" from the phone app needs no password), wait until your past orders
show, then **close that window**. The harvester cannot start while it is open.

## Commands

| Command | What it does |
|---|---|
| `node harvest.mjs` | Normal run: stops at the first page it has already harvested. |
| `node harvest.mjs --full` | Page through the whole available history again. |
| `node harvest.mjs --dry-run` | Fetch and print the newest orders. Posts nothing. |
| `node harvest.mjs --headed` | Same as a normal run, with the window on screen. |
| `pwsh -File register-task.ps1` | Register (or re-register) the scheduled task. |

Needs `~/.onyx_ci_token` (the same token the Kindle harvester uses). `npm install` once in this folder.

## What it writes

- `pds.delivery_order_items`: one row per cart line.
- `pds.delivery_item_nutrition`: one estimate per distinct dish (store + name + customizations).
- `pds.delivery_nutrition_daily`: estimated kcal and macros per day from restaurant orders.
- A `ubereats|items` heartbeat, shown as the "Uber Eats Items" card on `/status`.

The numbers are estimates from dish names. They overcount when an order was shared or not finished
(a whole pizza counts as eaten). To correct a dish, update its row in
`pds.delivery_item_nutrition`; it will not be re-estimated.
