# Native Focus development build

Status: opt-in implementation, not an installed or verified blocker. The standard
`project.yml` export app does not include Focus. Generate `project-focus.yml` to
compile the app with its Device Activity monitor. Focus starts disabled and
requires explicit Enable confirmation on the phone. No backend or production
checks are needed for policy tests or unsigned compilation.

## Behavior

- User chooses time-only, tasks-only, time AND tasks, or time OR tasks. There is
  no silently selected combination. The time defaults to noon, local iPhone time.
- Daily tasks are currently configured and self-reported in the native Onyx app.
  Existing web/Notion tasks are NOT imported, verified, or synced yet.
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
