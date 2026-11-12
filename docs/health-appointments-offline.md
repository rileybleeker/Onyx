# Health and recurring appointments: offline stage

Route: `/health` (behind the normal Onyx login); navigation: Tools, Health & appointments.

This is a care-planning surface, not a medical record or booking integration. It starts empty, distinguishes dates needing booking from user-confirmed appointments, supports editing and monthly recurrence, and archives/restores items. Completing a recurring item sets its next due date relative to the local completion day and clears booked status. Month-end dates clamp to the last valid day. Undo restores the previous planner state.

## What the page shows

- Due soon: overdue items and anything due in the next 30 days, soonest first, each with a plain status (overdue, past appointment to confirm, due and needs booking, booked by you).
- Calendar: a month grid and an agenda list of the same month, with previous/next/today navigation. Each active item appears on its real date. Repeating items also show italic "projected" dates (where the next ones land if the visit happens on schedule). For an item already past due the projection counts from today, because repeats count from completion.
- Sample data: an unchecked-by-default checkbox adds five invented, clearly labelled "Sample:" items to the calendar and due-soon list. They are display-only: never added to the editable list, never saved, never sent anywhere.
- Calendar connection card: Google Calendar is shown as not connected, both permissions it would ask for (read calendars, write events to one chosen calendar) are listed as not granted, and the connect button is disabled with an explanation.

Records remain in memory by default. Browser persistence is explicit opt-in with a plaintext/shared-profile warning. Turning persistence off removes the saved copy. Storage errors are surfaced rather than reported as successful saves. No records are sent to an API, analytics, provider or calendar. Existing authentication is unchanged. No database table or migration is involved.

## Not done (needs Riley)

Google Calendar is explicitly disconnected. This stage does not satisfy the requested personal-calendar sync. That requires an approved OAuth connection, explicit calendar selection, private read/write boundaries, safe token storage, cancellation/update reconciliation, recurrence/timezone handling and a live integration status. Do not represent a due item as a booking or silently convert health labels into calendar entries. Do not use a public calendar feed for private health data.

## Verification

- `node frontend/tests/care-planner.test.mjs` (date math, storage parsing, status, due-soon window, month grid, projections, sample data, disconnected connection state).
- `cd frontend; npx --no-install tsc --noEmit` and `npx --no-install next build --experimental-build-mode compile` (the two required CI checks).
- Browser UI, multi-tab storage behaviour and any connected-calendar flow still need a real-browser check before relying on them.

Corrupt storage blocks saving instead of overwriting; cross-tab storage changes pause persistence and require reload, with compare-before-write protection. Archived items can be removed and undone. Completion intentionally means 'complete today' (explicit button and explanation), rather than assuming an old booked date was attended.
