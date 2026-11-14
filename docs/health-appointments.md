# Health and recurring appointments

Route: `/health` (behind the normal Onyx login); navigation: Tools, Health & appointments.

A care-planning surface, not a medical record or a booking integration. It separates dates that still need booking from appointments Riley confirmed, supports repeats counted from the day an item is completed, and archives / restores items.

## Where the data lives (since 2026-11-13)

Items are stored in Onyx, in `pds.care_items` (`sql/care_items_schema.sql`). Before that they lived only in the browser (see "Copying the old browser planner" below).

| Column | Meaning |
|---|---|
| `title` | short label, 1 to 100 characters, one line |
| `kind` | medical, dental, vision, wellness, personal or other |
| `due_date` | calendar day, in `time_zone` |
| `due_time` | wall-clock time in `time_zone`, or empty for "no time" |
| `time_zone` | IANA zone the date and time are written in (the zone of the appointment) |
| `repeat_months` | 0 (does not repeat) or 1, 3, 6, 12, 24 months after completion |
| `booked` | Riley confirmed an appointment exists |
| `notes` | optional note, up to 1000 characters |
| `archived` | hidden from the active list and the calendar |
| `last_completed_on` | the day it was last marked complete |
| `removed_at` | soft removal: the app never physically removes a row, so Undo can bring it back |
| `import_key` | the id an item had in a browser's old planner; makes the one-time copy idempotent |

Privacy boundary:

- The table is service-role only: row-level security on, no policies, nothing granted to `anon` or `authenticated`. The browser cannot query it.
- The page (`force-dynamic`, never cached, `noindex`) reads it on the server through `lib/care-items-server.ts`.
- The browser writes through `/api/care/items` (GET list, POST), `/api/care/items/[id]` (PATCH, DELETE) and `/api/care/items/import`. These need the owner session (middleware), a same-origin `Origin`, a JSON body under a small size cap, and only known fields. They are not reachable with the CI token.
- Errors and server logs carry a database error code only. Item text is never logged, never written to `sync_log`, and never put in an error message.
- No chat / LLM tool reads this table.

## What the page shows

- Due soon: overdue items and anything due in the next 30 days, soonest first, each with a plain status (overdue, past appointment to confirm, due and needs booking, booked by you).
- Calendar: a month grid and an agenda list of the same month. Each active item appears on its real date; repeating items also show italic "projected" dates. For an item already past due the projection counts from today, because repeats count from completion.
- Add / edit form: label, kind, date, optional time (plus the time zone of the appointment when a time is set), repeat, booked, note.
- Sample data: an unchecked-by-default checkbox adds five invented, clearly labelled "Sample:" items to the calendar and due-soon list. They are display-only: never saved, never sent, and the API refuses them.
- Calendar connection card: Google Calendar is "not connected" until it is set up and connected (see [health-google-calendar.md](health-google-calendar.md)); until then the connect button is disabled and Google is never contacted.

Saving is optimistic: a change shows at once and is sent to Onyx; if Onyx does not confirm it, that one item goes back to what it was and a message says so. "Undo last change" sends the opposite change. While an item is being saved its buttons are disabled.

The page keeps four states apart: loading, load failed (a panel with "Try again"; it says explicitly that this is not an empty list), empty, and data.

## Dates, repeats and time zones

All of this is pure code in `frontend/src/lib/care-planner.ts`.

- An item's date and time are the clock where the appointment happens. They are stored as written and never converted, so a 9:00 appointment stays 9:00 when clocks change.
- When the reader's device is in another zone, a timed item also shows the time (and the day, if it differs) on the reader's clock. An 11:30 PM New York appointment is 5:30 AM the next day in Madrid.
- A time the clocks skip in spring (02:30) resolves to 03:30; a time that happens twice in autumn resolves to the first one. This only matters for ordering and for showing a time in another zone.
- Repeats are "N months after the day it was completed", clamped to the last day of a short month (Jan 31 + 1 month = Feb 28 or 29). Projections count from the original date so they do not drift.
- Marking a repeating item complete moves its due date, keeps its time of day, and clears "booked". Marking a one-off complete archives it.

## Copying the old browser planner

The first version of the page saved items in the browser only (opt-in, `localStorage`). If the browser still holds such items, the page shows one button to copy them into Onyx. The copy is idempotent (pressing it twice, or from two tabs, adds nothing), sample items are never included, and afterwards the page stops offering it and offers to remove the browser copy instead. A damaged browser copy is left untouched and is not used.

## Not done

- Google Calendar sync is built but not connected: it needs two values in Vercel and one consent click from Riley ([health-google-calendar.md](health-google-calendar.md)). Until then nothing on the page reads from or writes to a calendar.
- Today does not show care items.
- No reminders are sent.

## Verification

- `cd frontend; node scripts/test-care-planner.mjs` (date math, DST changes, month-end repeats, items across midnight, the browser-copy offer, calendar layout, sample data).
- `cd frontend; node --test tests/care-items.test.cjs` (body checks, the three routes against an in-memory table, same-origin and size checks, optimistic helpers, the owner-session boundary, the additive service-role-only schema).
- `cd frontend; node --test tests/care-google.test.cjs` (Google Calendar sync against a fake Google).
- All three run in CI with synthetic data only. The smoke test loads `/health` in production and fails if the list did not load.
- Not covered by an automated test: clicking through the page in a real browser against the live table.
