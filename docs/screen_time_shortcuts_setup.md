# iPhone screen time → Onyx (Shortcuts setup)

> **RETIRED 2026-11-13. Do not follow these steps.** This Shortcuts open/close
> path was never set up and never recorded an event. Screen time now comes from
> the Onyx Screen Time iPhone app (`tools/screentime_ios/README.md`), shown on
> `/screen-time`. The endpoint below (`POST /api/screen-time/event`) has been
> removed, so the automations described here would get a 404. The empty
> `pds.phone_app_events` table and its two views still exist; dropping them is a
> separate, approved step. The text below is kept only as a record.

Apple keeps Screen Time data on the phone (Opal too — no API, no export), so
Onyx records app use itself: two Shortcuts automations post every app open and
close to `POST /api/screen-time/event`. Onyx pairs them into sessions
(`pds.phone_app_sessions`) and daily totals (`pds.phone_screen_daily`).

One-time setup, about 10 minutes. You need the Onyx CI token (the contents of
`~/.onyx_ci_token` on the PC). Move it to the phone through your password
manager — never through chat, email or notes.

## Automation 1 — app opened

1. Shortcuts → **Automation** → **+** → **App**.
2. **Choose** → tick every app **except Shortcuts** (it would trigger itself).
3. Tick **Is Opened** only (untick Is Closed). Select **Run Immediately**,
   turn **Notify When Run** off → **Next** → **New Blank Automation**.
4. Add **Get Contents of URL**:
   - URL: `https://frontend-six-alpha-69.vercel.app/api/screen-time/event`
   - Method: **POST**
   - Headers: `x-onyx-ci-token` = *(paste the token)*
   - Request Body: **JSON**, three Text fields:
     - `event` = `opened`
     - `app` = the **Shortcut Input** variable
     - `time` = the **Current Date** variable → tap it → Date Format **ISO 8601**, Include Time on

## Automation 2 — app closed

Repeat with the same app selection, **Is Closed** only, and `event` = `closed`.
(Long-press Automation 1 → Duplicate saves retyping, then change the trigger and the event value.)

## Check it worked

Open and close a couple of apps, then visit
`https://frontend-six-alpha-69.vercel.app/api/screen-time/event` while logged in.
You should see the events. If `app` is `null` everywhere, iOS isn't passing the
app name — totals still work, per-app minutes won't. The `/status` page has a
**Screen Time** card (red after 36 h with no events).

## Upkeep

- Apps installed later must be ticked in **both** automations.
- If the CI token is rotated, update the header in both automations.
