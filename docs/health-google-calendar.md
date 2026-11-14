# Google Calendar sync for Health & appointments

Status: built, **not connected**. Nothing in Onyx contacts Google until the two steps under "What Riley has to do" are done. Until then `/health` says "Google Calendar: not connected" and the Connect button is disabled.

## What it does once connected

- Onyx creates one calendar in your Google account, named **"Onyx care"**, and keeps one event on it for every active care item on `/health`.
- One way only: **Onyx to Google**. Onyx never reads events back into the planner. Edit items in Onyx; a change made to one of these events in Google Calendar is overwritten at the next sync.
- What is sent for each item: the label, the date, the time and its time zone (if it has a time), and whether it is booked. **Notes are never sent.**
  - Booked with a time: a normal 60-minute event that shows you as busy.
  - Booked without a time: an all-day event.
  - Not booked yet: an all-day (or timed) event titled "Book: <label>" that does not block your calendar. A due date is never shown as if it were an appointment.
- Archiving, completing a one-off, or removing an item takes its event off the calendar. Completing a repeating item moves its event to the new due date.
- Repeats are not sent as recurring events, because a repeat counts from the day you complete the item. Only the current due date is on the calendar.
- A sync runs in the background after every change on `/health`, and when you press **Sync now**. The card shows the last result (counts only).

## The one permission

Onyx asks Google for exactly one scope:

`https://www.googleapis.com/auth/calendar.app.created`

Google describes it as: "Make secondary Google calendars, and see, create, change, and delete events on them." With it Onyx can work only on calendars it created itself. It **cannot** see or change your main calendar, any other calendar, events other people invited you to, or anything in Gmail. That is why the "one chosen calendar" is a calendar Onyx makes rather than one you pick: no broader permission is needed, and there is no calendar picker to get wrong.

Two more guards in the code:

- If Google ever grants anything other than exactly that scope, Onyx revokes the grant on the spot and stores nothing.
- Every event Onyx writes carries a private tag naming its care item. Before Onyx changes or removes an event it reads it and checks the tag; an event without the matching tag is never touched.

## What Riley has to do (about 10 minutes, once)

### 1. In Google Cloud (console.cloud.google.com), signed in to the Google account whose calendar should show the events

1. Create a project (any name, for example "Onyx").
2. **APIs & Services > Library**: search "Google Calendar API", press **Enable**. Enable nothing else.
3. **APIs & Services > OAuth consent screen** (also called "Google Auth Platform"):
   - User type / Audience: **External**.
   - App name: Onyx. Support email and developer contact: your own address.
   - Data access / Scopes: add `https://www.googleapis.com/auth/calendar.app.created` and no other scope.
   - Publishing status: press **Publish app** so it is "In production". Do not leave it in "Testing": in Testing, Google expires the sign-in after 7 days and the sync would stop every week. No verification is needed for an app only you use; you will see a "Google hasn't verified this app" page once (step 3 below).
4. **APIs & Services > Credentials > Create credentials > OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URI (exactly, no trailing slash): `https://frontend-six-alpha-69.vercel.app/api/care/google/callback`
     If you open Onyx at a different address, use that address instead (the part before `/api/...` must be exactly what is in the browser's address bar on `/health`).
   - Press Create. Keep the **Client ID** and **Client secret** on screen for the next step. Do not paste them into chat, a file under OneDrive, or the repository.

### 2. In Vercel (project "frontend" > Settings > Environment Variables, Production)

Add two variables, then redeploy (Deployments > the latest > Redeploy):

| Name | Value |
|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` | the Client ID from step 1.4 |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | the Client secret from step 1.4 |

Nothing else is needed: no GitHub secret, no local file, no database step (the tables already exist).

### 3. The one consent click

Open `/health`, press **Connect Google Calendar**. On Google's page choose your account; on the "Google hasn't verified this app" page press **Advanced**, then **Go to Onyx**; then **Continue**. You land back on `/health`, which now says "Google Calendar: connected", and the "Onyx care" calendar appears in Google Calendar within a minute.

## Turning it off

- **Disconnect** on `/health` revokes Onyx's access at Google and forgets the stored sign-in. The "Onyx care" calendar and its events stay in Google Calendar; remove that calendar there if you do not want it. Connecting again reuses the same calendar.
- You can also remove Onyx under myaccount.google.com > Security > Third-party connections. The next sync then reports that access was lost and the card tells you to disconnect and connect again.
- Removing the two Vercel variables turns the whole feature back to "not set up".

## How it is built

| Piece | Where |
|---|---|
| Sign-in URL, state + PKCE, the event an item becomes, the sync algorithm (pure, no I/O) | `frontend/src/lib/care-google.ts` |
| Credentials, stored sign-in, calls to Google, the sync run (server only) | `frontend/src/lib/care-google-server.ts` |
| Routes (owner session only; never reachable with the CI token) | `/api/care/google/status` (GET), `/start` (POST), `/callback` (GET), `/sync` (POST), `/disconnect` (POST) |
| Card on the page | `frontend/src/app/health/CalendarConnectionCard.tsx` |
| Tables (service-role only, `sql/care_calendar_sync_schema.sql`) | `pds.care_calendar_sync` (one row: calendar id, connected-at, last result), `pds.care_calendar_links` (item to event id + a digest of what was written) |
| Stored sign-in | `pds.ci_tokens`, `service = 'google_calendar'` (the refresh token only; access tokens are never stored) |

Sign-in flow: `POST /start` (same origin) answers Google's consent URL and sets a 10-minute httpOnly cookie, scoped to the callback path, holding a random `state` and the PKCE verifier. `GET /callback` refuses unless the `state` in the URL equals the one in that cookie, then exchanges the code (with the verifier), checks the granted scope, finds or creates the calendar, stores the refresh token, and redirects to `/health?calendar=connected`. Every failure redirects to `/health?calendar=error&reason=<short code>` and stores nothing.

Sync rules (`runSync`): an active item with no event gets one; an event whose content changed is read, checked for Onyx's tag, then rewritten; an item that was archived or removed has its event read, checked, then taken off; an unchanged item costs no Google call (a digest of the last written event is kept). If an id Onyx would use is occupied by something that is not Onyx's, or the event was removed by hand in Google, the item moves to a fresh id. One failing item does not stop the others; lost access or a missing calendar stops the run and is shown on the card.

Errors, stored results and logs carry short codes only (for example `google_auth`, `calendar_missing`, `google_500`): never a token, never an item's label.

## Verification

- `cd frontend; node --test tests/care-google.test.cjs`: the consent URL (one scope, state, PKCE test vector), the event mapping, the sync against a fake Google (create, no-op, rewrite, take off, foreign events never touched, events removed in Google, partial failure, lost access), and the routes with a fake database and fake Google endpoints (not set up: no call anywhere; set up but not connected: no call; state mismatch refused before any call; wrong scope revoked and not stored; disconnect; logs carry no token or label).
- `cd frontend; node scripts/test-care-planner-ui.mjs` (local, needs a browser): the card's states and buttons.

## Not proven, and what remains

- **No real Google account has been used.** The first real connection is the first end-to-end run. The endpoints, the scope and the event fields follow Google's published Calendar API reference (checked 2026-11-13), but "works against the fake" is all the tests show. Things to look at on the first connection: the calendar appears, a timed item lands at the right local time, archiving an item removes its event.
- A `/status` card for the sync is not added: the feature is inert until connected, and the card on `/health` shows the last result. Add one (heartbeat age of `pds.care_calendar_sync.last_sync_at`) once it is connected and in use.
- There is no scheduled catch-up sync. A sync that fails is retried at the next change or with **Sync now**.
- Reading Google Calendar into Onyx (for example to warn about a clash) is deliberately not built; it would need a broader permission.
