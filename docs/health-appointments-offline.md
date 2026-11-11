# Health and recurring appointments: offline stage

Route: `/health`; navigation: Tools, Health & appointments.

This is a care-planning surface, not a medical record or booking integration. It starts empty, distinguishes dates needing booking from user-confirmed appointments, supports editing and monthly recurrence, and archives/restores items. Completing a recurring item sets its next due date relative to the local completion day and clears booked status. Month-end dates clamp to the last valid day. Undo restores the previous planner state.

Records remain in memory by default. Browser persistence is explicit opt-in with a plaintext/shared-profile warning. Turning persistence off removes the saved copy. Storage errors are surfaced rather than reported as successful saves. No records are sent to an API, analytics, provider or calendar. Existing authentication is unchanged.

Google Calendar is explicitly disconnected. This stage does not satisfy the requested personal-calendar sync. That requires an approved OAuth connection, explicit calendar selection, private read/write boundaries, safe token storage, cancellation/update reconciliation, recurrence/timezone handling and an integration status card. Do not represent a due item as a booking or silently convert health labels into calendar entries. Do not use a public calendar feed for private health data.

Offline verification: `node frontend/tests/care-planner.test.mjs`, `cd frontend; npx tsc --noEmit --incremental false`, focused ESLint with the existing legacy config. No production build, production smoke or database query during the outage. Browser UI and connected-calendar flows still require verification before release.

Claude source review completed. Corrupt storage blocks saving instead of overwriting; cross-tab storage changes pause persistence and require reload, with compare-before-write protection. Archived items can be removed and undone. Completion intentionally means 'complete today' (explicit button and explanation), rather than assuming an old booked date was attended. Full browser/multi-tab QA remains outstanding.
