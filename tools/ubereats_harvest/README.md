# Uber Eats item harvester

Reads your Uber Eats order history (what was in each order, and exactly when it arrived) from a
signed-in Chrome profile on this PC and posts it to Onyx, which estimates calories and macros per
dish. Receipt emails cannot do this: they do not list the items.

## Status: built, not scheduled

Two things stand between this and an unattended run:

1. **Sign-in.** The harvester uses its own Chrome profile, which has never signed in to Uber.
   Run this once and sign in yourself in the window that opens:

       node harvest.mjs --login

2. **Headless is blocked.** Uber's bot protection answers headless Chrome with a
   "Just a moment…" challenge (HTTP 403). A normal visible Chrome window is served normally.
   The script defaults to headless and does not try to get around the challenge. To run it in a
   visible window add `--headed`. Scheduling it unattended would mean a visible window parked
   off-screen, the way the Kindle harvester runs. That has not been set up.

## Commands

| Command | What it does |
|---|---|
| `node harvest.mjs --login` | One-time sign-in (visible window). |
| `node harvest.mjs --dry-run --headed` | Fetch and print the newest orders. Posts nothing. |
| `node harvest.mjs --full --headed` | Page through the whole order history and import it. |
| `node harvest.mjs --headed` | Normal run: stops at the first page it has already harvested. |
| `pwsh -File register-task.ps1` | Schedule it every 6 hours (only useful once the two points above are settled). |

Needs `~/.onyx_ci_token` (the same token the Kindle harvester uses). `npm install` once in this folder.

## What it writes

- `pds.delivery_order_items`: one row per cart line.
- `pds.delivery_item_nutrition`: one estimate per distinct dish (store + name + customizations).
- `pds.delivery_nutrition_daily`: estimated kcal and macros per day from restaurant orders.
- A `ubereats|items` heartbeat, shown as the "Uber Eats Items" card on `/status`.

The numbers are estimates from dish names. They overcount when an order was shared or not finished.
To correct a dish, update its row in `pds.delivery_item_nutrition`; it will not be re-estimated.
