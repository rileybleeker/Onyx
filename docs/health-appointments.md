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
- Calendar connection card: Google Calendar is "not connected" until it is set up and connected (see [health-google-calendar.md](health-google-calendar.md)); until then the connect button is disabled and Google is never contacted. This card is about copying care items OUT to a calendar Onyx created.
- Calendar events (since 2026-11-13, read-only, the other direction): the events on Riley's own calendars, copied into Onyx once an hour, are drawn in the month grid and the agenda after each day's care items and labelled "Google Calendar: <calendar label> (read-only)". Month cells show the title (time, location and calendar in the tooltip and for screen readers); the agenda shows the time or "All day", "Tentative" where the calendar says so, the location and the calendar label. Times are in the device's time zone. An all-day event uses its own dates. A timed event is listed on the day it starts; only one that lasts 24 hours or more is also listed on the later days it covers. Cancelled events are left out. These entries carry no care-item id: they cannot be edited, completed, archived or saved here, and they never appear in Due soon.
- "Your calendar events" card (under the connection card): the real state of that hourly sync, from what `GET /api/calendar/events` answered. `synced (read-only)`: each synced calendar's label, how many events are stored for it, and how long ago the last sync ran. `not synced yet`: the table or the first sync run does not exist. `sync failing`: the last run failed or is more than 8 hours old (the last good copy is still shown, with the run's own error text). A partial run, or one more than 3 hours old, is flagged as late. `couldn't be checked`: Onyx could not read its own copy just now. The card has no button: there is no sign-in and nothing to grant.

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

## Calendar events sync (read-only, Google Calendar to Onyx)

This is separate from the connection in [health-google-calendar.md](health-google-calendar.md) and runs in the opposite direction. That one copies care items out to a calendar Onyx created (OAuth, one narrow write permission). This one only reads Riley's own calendars, without any sign-in.

- `google_calendar_etl.py` runs hourly on GitHub Actions (`google-calendar-etl.yml`, `55 * * * *`). It reads the feeds listed in the `GOOGLE_CALENDAR_ICS_SECRET` secret, a JSON list of `{"account": "<label>", "calendar": "<label>", "url": "<secret iCal address>"}`. The labels are short names Riley picks (letters, digits, space, `_ . -`), not addresses; they are what the page shows. Any ICS feed works, so a published Outlook calendar can be added as one more entry.
- It expands recurring events inside ET today minus 400 days to plus 400 days and writes one row per event instance to `pds.calendar_events` (service-role only; `sql/calendar_events_schema.sql`). Stored: title, start / end, all-day flag, inclusive dates, time zone, location, status, the two labels, whether it is part of a series. Not stored: description, attendees, organizer, conference links, the event's UID, the feed URL.
- An event that disappears from the feed is removed on the next run, but only after that calendar was fetched and parsed in full. A failed fetch never removes anything, and a run that would remove more than half of a calendar's events is refused (re-run the workflow with `allow_large_removal` if the calendar really was cleared). A calendar taken out of the secret has its rows removed.
- The page reads through `GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD` (owner session only, `force-dynamic`, `no-store`; reader `frontend/src/lib/calendar-events-server.ts`). The browser never queries the table. Nothing on this path writes: not to Google, and not to `pds.care_items`.
- The secret address is a password for the whole calendar (read-only, no expiry). It lives only in the GitHub secret and in `~/.onyx_gcal_ics.json` on Riley's PC. It is not a public feed, and it must never be pasted into the repo, a log, chat or OneDrive. The ETL keeps it out of logs, exceptions and `pds.sync_log`, and its logs print counts only.
- One-time setup per calendar: Google Calendar, Settings, the calendar, "Integrate calendar", copy "Secret address in iCal format" into the secret's JSON. To rotate (or if it leaks): press Reset next to that address, then update the secret and the dotfile. Until the secret is updated every run reports HTTP 404 for that calendar, and the `/status` Google Calendar card says so.
- Do not add the calendar Onyx created for care items (the "Onyx care" calendar of the other connection) to the secret: its events are copies of care items that the page already shows, so each would appear twice.
- Known limits: an invitation Riley declined still shows (the feed marks a decline only on the attendee line, which is not read); working-location, out-of-office and focus-time entries cannot be told apart from ordinary events; a one-off timed event is shown in the calendar's own time zone setting, not the zone it was created in.

## Not done

- Google Calendar sync is built but not connected: it needs two values in Vercel and one consent click from Riley ([health-google-calendar.md](health-google-calendar.md)). Until then nothing on the page writes to a calendar (the read-only calendar events above are a separate, one-way copy into Onyx).
- Today does not show care items.
- No reminders are sent.

## Verification

- `cd frontend; node scripts/test-care-planner.mjs` (date math, DST changes, month-end repeats, items across midnight, the browser-copy offer, calendar layout, sample data).
- `cd frontend; node --test tests/care-items.test.cjs` (body checks, the three routes against an in-memory table, same-origin and size checks, optimistic helpers, the owner-session boundary, the additive service-role-only schema).
- `cd frontend; node --test tests/care-google.test.cjs` (Google Calendar sync against a fake Google).
- `cd frontend; node --test tests/calendar-events.test.cjs tests/health-calendar.test.cjs` (the read-only calendar events: row parsing, range rules, day bucketing, ordering, the merge with care entries, the card's states, the rendered month view, route access rules, and that this path only reads).
- `python tests/test_google_calendar.py` (the hourly ETL: time zones, recurrence, keys, removal rules, heartbeat, no URL or title in logs; synthetic ICS only).
- All three run in CI with synthetic data only. The smoke test loads `/health` in production and fails if the list did not load.
- Not covered by an automated test: clicking through the page in a real browser against the live table.
