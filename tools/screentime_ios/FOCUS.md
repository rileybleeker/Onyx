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
  LinkedIn and its website as allowed exceptions. Opaque tokens mean Onyx cannot
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

## Signing gates (not performed by this change)

The existing signed export workflow supports ONE profile. Do not run it expecting
a working Focus build. A Focus signed workflow must instead use this spec and:

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

App Store/TestFlight distribution additionally needs Apple's Family Controls
approval for the app and each Screen Time extension. Personal development signing
is separate from that distribution approval.

## Official references

- https://developer.apple.com/videos/play/wwdc2022/110336/
- https://developer.apple.com/documentation/familycontrols/familyactivitypicker
- https://developer.apple.com/documentation/managedsettings/shieldsettings/activitycategorypolicy
- https://developer.apple.com/documentation/deviceactivity/deviceactivityschedule
- https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement
