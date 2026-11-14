# Native Focus development build

Device test steps, what is proven and what is not built yet: `docs/focus-device-test.md`.

Status: opt-in implementation, not an installed or verified blocker. The standard
`project.yml` export app does not include Focus. Generate `project-focus.yml` to
compile the app with its Device Activity monitor. Focus starts disabled and
requires explicit Enable confirmation on the phone. No backend or production
checks are needed for policy tests or unsigned compilation.

## Behavior

- User chooses time-only, tasks-only, time AND tasks, or time OR tasks. There is
  no silently selected combination. The time defaults to noon, local iPhone time.
- Daily tasks are configured and self-reported in the native Onyx app. Real Onyx
  habits can unlock too: see "Onyx habit unlock" below. Once habits are chosen in
  Onyx they replace this "Unlock when" choice and the on-phone task list.
- Select social apps/categories/websites with Apple's picker. Separately select
  LinkedIn and its website as allowed exceptions. Enabling requires at least one
  app AND one website exception plus explicit confirmation of both. App-only
  exceptions are rejected. Opaque tokens mean Onyx cannot
  verify that the chosen token is really LinkedIn. Category exceptions alone do
  not override direct selections, so allowed tokens are subtracted from both.
- A named store isolates Onyx Focus restrictions. Other Screen Time apps can
  still impose stricter restrictions. Individual authorization can be revoked
  and the app removed: this is voluntary friction, not a tamper-proof lock.
- Daily monitor start reconciles task completion dates; cutoff callback and
  on-device task completion reconcile immediately. iOS controls callback timing.
  Reopen Onyx after a time-zone change to reconcile; cross-time-zone scheduling
  while the phone/app is inactive needs device validation before release.
- Configuration lives only in the shared App Group file. It is not transmitted
  to Onyx servers, logs, or review prompts. Corrupt/missing state clears this
  feature's shields. Turn off stops its schedule and clears its named store.
  The habit check sends nothing but the token header; what it receives (the
  chosen habits' names and done flags) is stored in the same App Group.

## Onyx habit unlock (2026-11-13)

Built and compiled; NOT yet seen working on the phone. Test steps:
`docs/focus-device-test.md`, tests H1 to H6.

What it does. Riley picks a few habits and a rule in Onyx on the web (the
"Focus: unlock with habits" card on `/install`, stored in
`pds.focus_unlock_config`). The phone asks `GET /api/focus/unlock-status` with
the token the app already holds and gets the Onyx behavioral day, the rule and,
for each chosen habit, whether it is answered Yes for that day.

| Rule (set in Onyx) | Before the unlock time | After the unlock time |
|---|---|---|
| Habits OR time (default) | Blocked until the phone learns every chosen habit is Yes | Open |
| Habits AND time | Blocked | Blocked until the phone learns every chosen habit is Yes |
| No habits chosen (default) | The phone's own rule, exactly as before | Same |
| A check today failed (see below) | Blocked | Open: the time alone decides |

The unlock time, the blocked apps and the LinkedIn exception stay on the phone.

When the phone checks. Only when the app can run:

1. The Onyx Screen Time app comes to the foreground (any screen), or is launched.
2. "Check now" on the Focus screen.
3. The Shortcuts action "Check Onyx Focus habits" runs (optional, below).

It does NOT check in the background. The Device Activity monitor extension
(00:00 and the unlock time) never uses the network: it re-applies the rule
with the last answer the app stored. So:

- OR rule: ticking the habits in Onyx does not unlock anything by itself. Open
  the Onyx Screen Time app afterwards; the block lifts within a few seconds
  if the phone is online. Without that, the block lifts at the unlock time.
- AND rule: "not asked yet today" counts as not done. At the unlock time the
  monitor leaves the block on, and it stays on until the app is opened after
  the habits are done (or until a check fails, next section). So under AND the
  app has to be opened once every day, after the unlock time or after the
  habits, whichever is later. Nothing on Apple's block screen says so.
- A change made on `/install` (other habits, the other rule, no habits)
  reaches the phone at its next check, not before.

Failure behaviour (deliberate trade-off). If a check cannot get the status (no
token, offline, timeout, token refused, server error, unreadable answer), the
phone records the failure, says so on the Focus screen ("Last check failed:
...") and uses the unlock time alone for the rest of that day, or until a
check succeeds:

- A failed check never keeps apps blocked past the unlock time, under either
  rule. Under AND this means opening the app offline after the unlock time
  lifts the block even though the habits are not done. That is accepted: Focus
  is voluntary friction (there is also a "Turn off" button), and the opposite
  choice would let an outage lock the phone all day.
- The one case where being offline still leaves apps blocked past the unlock
  time: AND rule and the app not opened yet that day. The phone has not tried,
  so nothing has failed. Opening the app once ends it, online (habits done)
  or offline (the check fails, time-only).
- A failed check cannot unlock early (OR rule): before the unlock time the
  block stays.
- A failed check does not undo a "done" that Onyx already confirmed today.

Which day counts. A habit counts only when Onyx's behavioral day equals the
phone's calendar day. Onyx's day runs 06:00 to 06:00, so between midnight and
06:00 Onyx still reports yesterday; the phone treats an answer fetched then
as "not asked yet today". From 06:00 the two agree. At midnight the stored
answer stops counting and the block returns (next-day reset). If Onyx answers
after 06:00 for a different day than the phone's (a trip where Onyx has not
learned the new time zone yet), the phone uses the unlock time alone.

Other limits.

- "Done" means an explicit Yes in Onyx for that day (`/habits`, `/check-in` or
  chat). No and unanswered both count as not done.
- A chosen habit that is later switched off in Notion can no longer be
  answered. Under AND that blocks until midnight every day. The `/install`
  card marks such a habit in red; untick it there.
- Optional automation: Shortcuts, Automation, Time of Day (or "When Onyx is
  closed" if the Onyx web app shows up in the app list), action "Check Onyx
  Focus habits", Run Immediately. Untested; whether iOS applies the shield
  change from a background shortcut run has to be seen on the phone.
- No heartbeat and no `/status` card: the route is read-only and the phone
  reports nothing back.

Code: `FocusCore/Sources/FocusCore/OnyxHabits.swift` (pure rule, parsing;
`swift test`), `FocusShared/FocusConfiguration.swift` (`FocusHabitStorage`,
`focus-habits.json`), `FocusUI/FocusHabitSync.swift` (fetch, shared model,
shortcut action), `frontend/src/lib/focus-unlock.ts` (same decision table in
TypeScript, `frontend/tests/focus-unlock.test.cjs`).

## Build and test

`cd FocusCore && swift test` tests the pure policy, noon boundary, all AND/OR
combinations, daily resets, DST, validation and Codable round trips.

From this directory, run `xcodegen generate --spec project-focus.yml`, then the
unsigned xcodebuild command in `.github/workflows/focus-ios.yml`. That workflow
uses no signing secrets, no data and no production service. Windows cannot
compile the iOS target; passing policy tests is not a signed-install/device test.

## Signing gates

The signed export workflow (`screentime-ios.yml`) supports ONE profile. Do not
run it expecting a working Focus build. The Focus signed workflow (see Signed
build below) uses this spec and:

1. Register App Group `group.com.rileybleeker.onyxscreentime.focus` and associate
   it with the existing app and extension IDs, subject to account authorization.
2. Register `com.rileybleeker.onyxscreentime.focusmonitor`, enable Family Controls
   development and App Groups, and provision the registered test device.
3. Refresh the main app development profile to include the App Group, retaining
   both its current Family Controls and app/website usage entitlements.
4. Supply separate profile specifiers per target (NEVER a global main-app profile
   override), and both bundle-ID mappings in ExportOptions provisioningProfiles.
5. Verify signed app AND embedded .appex entitlements, device inclusion, team,
   expiry and matching App Group before publishing to the private install bucket.
   Keep identities, device IDs, profiles, signed links and credentials private.
6. On the real iPhone: install, retain/export authorization, configure LinkedIn,
   and explicitly enable. Test direct and category exception overlaps, LinkedIn
   app and web, blocked app/web, before/at/after cutoff with app terminated,
   completion/next-day reset, restart, offline use, time-zone change, permission
   revocation and Turn off. Do not claim active enforcement until these pass.

## Signed build

`.github/workflows/focus-ios-signed.yml` (manual only) implements gates 4 and 5.
Secrets (portal downloads; no App Store Connect API path):

- `IOS_DEV_KEY_B64`, `IOS_DEV_CERT_B64`: the same key and Apple Development
  certificate as the export app (README.md).
- `IOS_PROFILE_B64`: the main app profile for `com.rileybleeker.onyxscreentime`,
  regenerated after step 3 (App Group plus both Family Controls entitlements).
  The export workflow keeps working with it.
- `IOS_FOCUS_MONITOR_PROFILE_B64` (new): the iOS App Development profile for
  `com.rileybleeker.onyxscreentime.focusmonitor` (step 2), with a different
  name from the main profile.
- `IPHONE_UDID` (required here), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

```powershell
$d = "$HOME\.onyx-ios-signing"   # wherever the downloads were saved
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$d\profile.mobileprovision")) | gh secret set IOS_PROFILE_B64
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$d\focusmonitor.mobileprovision")) | gh secret set IOS_FOCUS_MONITOR_PROFILE_B64
gh workflow run focus-ios-signed.yml
```

Before building it checks both profiles, and before publishing the signed .app
and embedded .appex (`ci/focus_signing_check.py`). Each failure names the
missing portal step. It publishes to `ios-builds/screentime-focus/` (links in
`screentime-focus/latest.json`), never over the export app's
`screentime/latest.json`. `/install` shows it as a second card, "Onyx with Focus
(development build)" (`/api/screen-time/build?variant=focus`). Both builds use
the same bundle ID, so installing one replaces the other on the phone (upgrade
in place).

App Store/TestFlight distribution additionally needs Apple's Family Controls
approval for the app and each Screen Time extension. Personal development signing
is separate from that distribution approval.

## Official references

- https://developer.apple.com/videos/play/wwdc2022/110336/
- https://developer.apple.com/documentation/familycontrols/familyactivitypicker
- https://developer.apple.com/documentation/managedsettings/shieldsettings/activitycategorypolicy
- https://developer.apple.com/documentation/deviceactivity/deviceactivityschedule
- https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement
