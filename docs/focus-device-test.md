# Focus rules: device test and readiness

Written 2026-11-11 (evening ET). Scope: can the Onyx "Focus" feature block social apps on the iPhone before noon, and what is left before that can be called done.

Rule for the roadmap row "Enforce configurable iPhone focus rules": it is NOT done until a blocked app is observed blocked before noon on the phone. Nothing in this file is evidence of that. It lists what exists, what has been seen, and what Riley has to look at.

## Verdict

READY for the device test. Nothing in the build chain blocks it: the signed Focus build exists, was checked in CI, and is on `/install`. Three things are unproven because only the phone can show them:

1. The block lifting at the "Not before" time with Onyx closed (background Device Activity monitor).
2. The block coming back at midnight with Onyx closed (same monitor), i.e. the real "blocked before noon" morning.
3. Unlocking from real Onyx habits (built 2026-11-13, tests H1 to H6 below; not yet run on the phone). A status card is not built (see "Not built yet").

The roadmap row's log records that on the evening of 2026-11-11 Riley saw a blocked social app show the iOS restriction screen while the LinkedIn app and linkedin.com in Safari opened. That was written by another agent; I could not check the phone, so treat it as reported, not as verified here.

## What is built and installed (checked 2026-11-11, read-only)

| Fact | Evidence |
|---|---|
| Signed Focus build published as `1-e7526dd` | Actions run "Focus iOS signed build" 43139068207, success, every step green; storage object `ios-builds/screentime-focus/1-e7526dd/OnyxScreenTime.ipa` (224,713 bytes) created 02:07Z 2026-11-12 (9:07 PM ET 2026-11-11) |
| Both profiles carry Family Controls, the App Group, the phone and the signing certificate | Same run: `focus_signing_check.py profiles` printed "all signing checks passed" before the build, and `... signed` passed on the exported .app and embedded .appex |
| Build stops opening | 2027-11-11 04:16Z (profile expiry printed by the run) |
| Install links last 30 days | `publish_build.py` default; the exact expiry is on the `/install` card. After that, run "Focus iOS signed build" again |
| `/install` has a second card "Onyx with Focus (development build)" | Code in `frontend/src/app/install/page.tsx`; production deploy `70499d1` (success) contains PR #50. The page is behind login, so I did not view it |
| `/install` first card is the export-only app | `screentime/latest.json` was updated 02:41Z by export build #12 (no Focus). Installing it REPLACES the Focus build (same bundle ID) |
| No Focus data in Onyx | No `focus`/`block`/`shield`/`rule` tables in `pds` or `public`; 0 rows in `pds.sync_log` mentioning focus; no web route or page. Rules live only in a JSON file inside the app's App Group on the phone |
| Screen Time access works on this phone with a development build | The export app's `screen_time\|usage` heartbeats are `success`, newest 2026-11-11 15:00Z |

### What the build contains

- Target `OnyxScreenTime` (app, `com.rileybleeker.onyxscreentime`): entitlements Family Controls, Family Controls app-and-website-usage, App Group `group.com.rileybleeker.onyxscreentime.focus`. Compile flag `ONYX_FOCUS` adds a "Focus" section at the top of the app's list ("Configure social media rules").
- Target `OnyxFocusMonitor` (Device Activity monitor extension, `com.rileybleeker.onyxscreentime.focusmonitor`): Family Controls plus the same App Group. Its only job is to call `FocusEnforcement.reconcile()` when the daily interval starts (00:00) and ends (the "Not before" time).
- Package `FocusCore`: the pure rule (`FocusRule.shouldShield`), with unit tests (`swift test`, run by "Focus iOS checks" on PRs).
- Workflows: `focus-ios.yml` (unsigned compile + tests, PRs), `focus-ios-signed.yml` (manual, signed, publishes to `screentime-focus/`), `screentime-ios.yml` (export app only, no Focus).

### How a rule works

- Unlock when: choose one of time only / tasks only / time AND tasks / time OR tasks. No default is picked for you.
- Time-only rule: the shield is on from 00:00 until the "Not before" time (default 12:00) every day, iPhone local time. The monitor is scheduled 00:00 to that time, repeating.
- Blocked apps/sites/categories come from Apple's picker. "Allowed" (LinkedIn) must contain at least one app AND one website, and you must tick the confirmation. The exception is subtracted from direct picks and passed as `except:` for categories.
- Enabling applies the shield immediately from the app, so the first block does not depend on the monitor. The monitor only handles the scheduled changes (unlock at the time, re-block at midnight).
- Tasks are typed and ticked on the phone. They are not Onyx tasks or habits.
- Until the 2026-11-13 build, opening the Onyx app did NOT re-check the rule (only returning to the foreground with the Focus screen already showing did). From that build on, launching the app or bringing it to the foreground on any screen re-applies the rule and asks Onyx about the chosen habits (see "Habit unlock tests"). "Save and enable Focus" also re-applies. Keep the build in mind when reading a result.

### The hold on PR #50

PR #50 was titled "(hold)" and said "do not merge until the portal steps and one new secret exist". It was merged at 02:03Z 2026-11-12. The hold's conditions were then met: the App Group and the focusmonitor App ID were registered with Family Controls, the regenerated main profile and the new monitor profile were stored as `IOS_PROFILE_B64` and `IOS_FOCUS_MONITOR_PROFILE_B64` (set 02:06Z), `IPHONE_UDID` and the other secrets were already present, and the workflow was run once and published. Nothing is left to release. The PR text's "known gap" (Focus links not on `/install`) is fixed in the merged diff.

## Apple requirements: certain vs uncertain

Certain (Apple documentation, fetched 2026-11-11):

- The app needs the `com.apple.developer.family-controls` capability before it calls `requestAuthorization(for:)` ("Family Controls" framework page).
- Apple approval is described only for distribution: "Before submitting your app to the App Store, you must request permission to use the entitlement", and the article "Requesting the Family Controls entitlement" says the account holder requests it "before you distribute", through the `family-controls-distribution` form, and "submit the same request for the extension" if there is a Device Activity Monitor or similar extension. Neither page says development signing needs that request.
- `.individual` authorization is approved by the device owner with Face ID/Touch ID. Apple says to call it at first launch, it shows once, and afterwards the user can delete the app or sign out of iCloud (it is not a lock).
- `startMonitoring` replaces an existing schedule for the same activity name, and "may begin receiving callbacks as soon as the system calls this method if the activity's scheduled interval is ongoing".
- ManagedSettings: setting a value to `nil` removes your app's configuration; "the system doesn't guarantee that the settings you specify govern the device's behavior" (it merges all sources, so other Screen Time restrictions can be stricter).
- A shielded app gets a dimmed icon with an hourglass, and the system covers it when it launches.

Certain (this repo's own evidence):

- Riley's paid developer account was issued Family Controls (Development) and App Groups on both App IDs without a distribution request: the CI check reads them out of the downloaded profiles and again out of the signed .app and .appex.
- A development-signed build of the export app already gets Screen Time authorization and syncs on this phone.

Uncertain (not shown by anything I could read):

- Whether the monitor extension is actually launched by iOS on this phone and iOS version. Developers report `intervalDidStart`/`intervalDidEnd` not firing, including a thread on iOS 26.3.1 with a development build, an App Group and a successfully registered schedule (extension never launched, no Apple fix posted). Other threads report it works when the schedule uses only hour/minute components, which is what this app does. Treat the background path as unproven until Test D and Test E pass.
- The minimum schedule length. The code only accepts a "Not before" of 00:15 or later, on the belief that the minimum interval is 15 minutes (a comment in `FocusRule.swift`); Apple's schedule page states no number and I did not confirm it.
- Whether website shields cover browsers other than Safari or in-app browsers. Apple's page only says websites get "a shielding view".
- Whether the picker lists linkedin.com before it has been opened in Safari (believed to list visited sites; not confirmed).
- What happens to the shield if the app is deleted (Apple's pages do not say). Use "Turn off and unblock" first.
- Free/Personal Teams cannot add the capability (forum, Apple DTS). Not relevant to a paid account.
- TestFlight/App Store would need Apple's approval for the app AND the extension. Not needed for this personal install.

## Device test (about 5 minutes of work, plus a wait)

Before you start (once): LinkedIn and the apps to block (for example Instagram, X) are installed. Open linkedin.com in Safari once so the website can show up in the picker. Do not paste or type any token for this test.

### T0. Make sure you are on the Focus build (1 min)

Open "Onyx Screen Time". If the first row is a "Focus" section with "Configure social media rules", you have it. If not: on the iPhone open `/install` in Safari, scroll to the SECOND card "Onyx with Focus (development build)", tap Install with Focus (or the alternative link), then confirm. Do not tap the first card afterwards, it replaces Focus with the export-only app. If the Focus card says the links expired, run the "Focus iOS signed build" workflow (Actions, Run workflow) and reload.

### T1. Enable one rule (2 min)

Pick a time of day first: "Not before" = now + 20 minutes for tonight's mechanism test (for example 10:00 PM now, set 10:20 PM).

1. Onyx Screen Time, Focus, Configure social media rules.
2. Unlock when: "Time reached only".
3. Not before: the time you chose.
4. "Choose social apps to block": tick Instagram and X (the app and, if listed, the website), Done.
5. "Allowed: choose LinkedIn app and website": tick LinkedIn (app) and linkedin.com (website), Done. Then switch on "I selected BOTH LinkedIn app and website". (Changing the Allowed selection switches it off again.)
6. "Save and enable Focus", Enable. Expect the status line "Focus enabled".

If Save is greyed out, the grey line above it names the missing piece (rule choice, time, LinkedIn exception, nothing to block).

### T2. Observe the block (1 min)

| Do | Expect |
|---|---|
| Home screen | Instagram and X icons dimmed with an hourglass |
| Open Instagram, X | Apple's restriction screen instead of the app |
| Safari: instagram.com, x.com | A shield page (unsure for sites you did not tick) |
| Open LinkedIn app, linkedin.com in Safari | Opens normally |

### T3. Turn it off again, any time

Onyx Screen Time, Focus, "Turn off and unblock". Status becomes "Focus is off." and the named store is cleared. If the app will not open: Settings, Screen Time, apps with Screen Time access (path from memory, check it), remove Onyx Screen Time. Last resort: delete the app.

Always tap "Turn off and unblock" before changing a rule and enabling again. Re-enabling over a running schedule is a known flaky area (Apple forum, iOS 18 beta).

### T4. Timed unlock with the app closed (the wait)

Right after T2: swipe Onyx Screen Time away in the app switcher and do not open it again. At the "Not before" time plus two minutes, open Instagram.

| You see | Meaning |
|---|---|
| Instagram opens | PASS: the background monitor fired and lifted the block |
| Still blocked at +5 minutes; it lifts after you open Onyx, Focus, go Home and reopen Onyx | FAIL for the background path (monitor callback not delivered). The foreground path works. Write down the iPhone iOS version and go to build item 2 |
| Still blocked even after that foreground round trip | A real bug. Do not guess: copy the status line from the Focus screen and leave it for the next session |

### T5. The real rule: blocked before noon (the row's done test)

1. Onyx, Focus, "Turn off and unblock". Set "Not before" to 12:00 PM. "Save and enable Focus", Enable. If it is already past noon the status says "your rule would allow now": that is correct, nothing is blocked tonight. (If you do this before noon, the block applies right away and you can run T2 on the real rule at once.)
2. Close Onyx (swipe away). Do not open Onyx or its Focus screen again.
3. Tomorrow morning before noon, first thing: open Instagram. Expect the restriction screen. Open LinkedIn: opens.
4. After 12:00 (give it two minutes) with Onyx still unopened: Instagram opens.

| Result | Meaning |
|---|---|
| Blocked in the morning, open after noon | PASS. This is the observation the row asks for. Mark the row Done after noting the iOS version |
| Not blocked in the morning; blocked once you do the Focus-screen foreground round trip (T4 note) | The 00:00 re-arm is not delivered in the background |
| Blocked in the morning, still blocked after noon until that round trip | The noon unlock is not delivered (or fired a few seconds early, see build item 1) |

### T6. Optional, 2 minutes: task unlock (phone-only tasks)

Turn off. Unlock when "All tasks done only", add a task "test", pick the same apps and LinkedIn exception, Enable. Apps are blocked whatever the time. Tap "Mark done" in the Focus screen: the block lifts at once. Next day the task shows "Mark done" again and the block returns after 00:00. Other checks from `tools/screentime_ios/FOCUS.md` (restart, offline, time-zone change, revoking access) are listed there; do them after T4 and T5 pass.

### How to check the monitor and heartbeat

There is no heartbeat. Focus sends nothing to Onyx, so `/status` has no Focus card and `pds.sync_log` has no Focus rows. The only evidence is what the phone does while Onyx is closed (T4, T5). The "Screen Time app" card on `/status` is the usage export, unrelated to blocking.

If T4/T5 fail and you want logs: with the phone plugged in, `pymobiledevice3 syslog live` and look for lines from `deviceactivityd` around the unlock time (the forum threads use that filter on a Mac; not tried here). An empty log at the scheduled time is the "extension never launched" signature.

## Habit unlock tests (added 2026-11-13)

What changed: the habits Riley picks in Onyx (web, `/install`, card "Focus: unlock with habits") can unlock the block. Rule and limits: `tools/screentime_ios/FOCUS.md`, "Onyx habit unlock". Built and compiled in CI; nothing below has been run on the phone. The row "Unlock iPhone Focus when today's Onyx habits are done" is NOT done until H2 and H3 are seen on the phone.

Two things to keep in mind while testing:

- The phone only asks Onyx when the Onyx Screen Time app is opened (any screen), when "Check now" is tapped, or when the "Check Onyx Focus habits" shortcut runs. Ticking a habit in Onyx changes nothing on the phone until then.
- Habits count from 06:00. Before 06:00 Onyx still reports the previous day, so run these tests between 06:00 and midnight.

Use one or two habits you can tick and untick freely. Tick and untick them on `/habits` (the Yes circle; tap it again to clear). Clear them again when you are done so the day's record stays true.

### H0. Install the new build and pick habits (3 min)

1. iPhone, Safari, `/install`, second card "Onyx with Focus (development build)", Install with Focus. The build must be newer than 2026-11-13 (the card shows the build time).
2. Open Onyx Screen Time, Focus, "Configure social media rules". A new section "Onyx habits" is at the top. With nothing chosen yet it says "No habits are chosen in Onyx. This phone's own rule applies." If it says "No Onyx token is saved in this app", go back one screen, paste the token (Copy Onyx token on `/install`) and Save.
3. On `/install` (phone or PC), card "Focus: unlock with habits": tick one or two habits, leave the rule on "Habits OR time", Save. The "Today, as the phone sees it" block lists them with To do.
4. Phone: Focus screen, "Check now". Expect the habits listed with "To do", "Rule from Onyx: habits OR time", and "Last checked" = now.
5. If Focus is not enabled yet, do T1 (time-only rule, apps, LinkedIn exception, Enable). For H1 and H2 the "Not before" time must be at least 20 minutes away.

### H1. Nothing chosen behaves as before (1 min, optional)

On `/install` untick everything, Save. Phone: Check now. Expect "No habits are chosen in Onyx" and the block exactly as in T2/T4 (blocked until the time, open after). Then tick the habits again, Save, Check now.

### H2. OR rule: finishing the habits unlocks early (3 min)

Before the "Not before" time, with the habits not ticked:

| Do | Expect |
|---|---|
| Open a blocked app | Apple's restriction screen |
| Tick every chosen habit Yes in Onyx (`/habits`), then open a blocked app WITHOUT opening Onyx Screen Time | Still blocked. This is the known limit, not a bug |
| Open Onyx Screen Time (any screen), wait about 5 seconds, open the blocked app | Opens. The Focus screen shows the habits "Done" and "All chosen habits are done: unlocked early." |
| Clear one habit in Onyx, open Onyx Screen Time, wait, open the blocked app | Blocked again (the time has not come) |
| Wait for the "Not before" time with that habit still clear, Onyx Screen Time closed | The app opens at the time (OR: the time unlocks regardless). Same background path as T4 |

### H3. AND rule: stays blocked after the time until the habits are done (5 min plus a short wait)

1. `/install`: rule "Habits AND time", Save. Clear the chosen habits in Onyx.
2. Phone: Onyx Screen Time, Focus, set "Not before" to now + 16 minutes (Turn off and unblock first, then Save and enable), then Check now. Expect "... to do. Stays blocked after the unlock time until done." Close Onyx Screen Time.

| Do | Expect |
|---|---|
| Before the time: tick every habit, open Onyx Screen Time, wait, open a blocked app | Still blocked (AND: habits alone do not unlock early). Clear the habits again and reopen Onyx Screen Time |
| After the time, habits not ticked, Onyx Screen Time closed: open a blocked app | Still blocked. If it opens, either the last check had failed (time-only) or the unlock-time callback misbehaved: note the text of the "Onyx habits" section |
| Tick every habit in Onyx, open the blocked app without opening Onyx Screen Time | Still blocked (known limit) |
| Open Onyx Screen Time, wait about 5 seconds, open the blocked app | Opens |

### H4. Offline fallback (3 min)

Run under the AND rule, after the "Not before" time, with a chosen habit NOT ticked and the apps blocked (end of H3 before ticking, or clear a habit and reopen Onyx Screen Time).

| Do | Expect |
|---|---|
| Airplane mode on (Wi-Fi off too). Open Onyx Screen Time, Focus | "Last check failed: No answer from Onyx (...). Using the unlock time only until a check succeeds." |
| Open a blocked app | Opens: a failed check never blocks past the unlock time. This is the documented trade-off |
| Airplane mode off, Onyx Screen Time, Check now | Habits listed "To do" again, and the app is blocked again |

Before the time (either rule), airplane mode on, open Onyx Screen Time: the block must stay (a failed check cannot unlock early), and the screen must say the check failed.

Token refused: only if you want to see it. In the app's main list paste a wrong token and Save, then Focus, Check now: "Onyx refused the token (HTTP 401)" and time-only behaviour. Paste the right token again afterwards (Copy Onyx token on `/install`), or the Screen Time export stops syncing.

### H5. Next-day reset (overnight)

Leave the habits ticked and the phone unlocked-early (OR) or unlocked (AND) in the evening. Do not open Onyx Screen Time again.

| Next morning | Expect |
|---|---|
| Before the time, Onyx Screen Time not opened: open a blocked app | Blocked: yesterday's ticks do not count (also needs the 00:00 monitor callback, as in T5) |
| Open Onyx Screen Time, Focus | Habits listed as "To do" (after 06:00), or "No answer for today yet" (before 06:00) |
| OR rule: tick today's habits, open Onyx Screen Time | Unlocks early |
| AND rule: do not open Onyx Screen Time; after the time open a blocked app | Still blocked until Onyx Screen Time is opened with the habits done |

### H6. Optional: the shortcut (2 min)

Shortcuts app, new shortcut, add action "Check Onyx Focus habits" (under Onyx Screen Time). With the habits ticked and the apps still blocked (OR rule, before the time), run it. Expect a result line such as "All chosen habits are done: unlocked early." and the blocked app opens. If the result is right but the app stays blocked until Onyx Screen Time is opened, iOS did not apply the change from the background run: write that down, the automation idea in `FOCUS.md` then does not work.

### What to write down

For each of H2 to H5: pass or fail, the iPhone's iOS version, and on a fail the full text of the "Onyx habits" section (summary line and "Last checked").

## Not built yet

| Wish | State |
|---|---|
| No social media before noon | Built. Needs T4/T5 to be believed |
| LinkedIn allowed | Built as a picker exception (app AND website, you confirm). Onyx cannot check the choice is really LinkedIn: Apple's tokens are opaque |
| Habit completion unlocks | Built 2026-11-13: chosen Onyx habits, rule OR / AND set on `/install`. Needs H2/H3 to be believed. The phone only learns about a finished habit when the app is opened (no background check, no push) |
| Configurable in Onyx | The habits and the OR / AND rule are set on `/install`. The unlock time, the blocked apps and the LinkedIn exception are still set on the phone only (the app/site picks can never move to the web: tokens exist only on the device) |
| Visible in Onyx | No `/status` card, no heartbeat, no last-run time even on the phone |
| Reliable timing | Unknown until T4/T5. Nothing re-arms the schedule if iOS drops it |

## Ranked build plan (rough effort for one agent session)

1. Make the test self-explaining (small, about half a day). Show "last reconcile: time, by monitor or by app" and the build id in the Focus screen. Call `reconcile()` from the app root on every foreground, not only when the Focus screen is already showing (this also makes the "reopen Onyx after a time-zone change" line in `FOCUS.md` true). Call `stopMonitoring` before `startMonitoring` in `enable()`. Re-arm the schedule on foreground if iOS dropped it. Do not re-read the clock inside `intervalDidEnd` (a callback a few seconds early would leave the shield on past noon; hypothesis, not seen).
2. Second trigger for noon and midnight (small, about half a day; only if T4 or T5 fails, but cheap enough to do anyway). An App Intent "Reconcile Focus" and two Shortcuts personal automations (Time of Day 00:00 and 12:00, run immediately). The export already proves this pattern runs with the phone locked.
3. Heartbeat and `/status` Focus card (small to medium, about 1 day). The phone posts the last reconcile result with the existing CI-token route pattern; the card goes red when the last result is old or failed. Fits the "every integration appears on /status" rule.
4. Task-completion unlock from real Onyx tasks (medium to large, 3 to 5 days). First decide the source of truth (check-in answers, a habit, or Notion tasks). Then a CI-token route that returns "required tasks done today", polled on foreground, by the App Intent, and by the automations from item 2. Open design problem: Onyx cannot push to a native app (the Worker only sends Web Push to the PWA), so unlock lag is the polling gap unless an APNs push is added (large).
5. Configure time, mode and tasks in Onyx (medium, 2 to 3 days). Table plus `/focus` page plus route; the phone pulls it. App/site selection stays on the phone.
6. Nice to have (small each, order by want): weekday schedules, several rules, a spike on `Application(bundleIdentifier:)` to select LinkedIn without relying on the user's confirmation, "category exceptions".

## Unknowns I could not settle from here

- What the phone shows right now (I never touched it).
- The installed iOS version and whether the monitor extension launches on it.
- Whether the first `/install` card was tapped after the Focus build (it would have replaced it; T0 tells you).
- Whether the production `/install` page renders the Focus card (code deployed, page behind login).

## Sources

- Family Controls framework: https://developer.apple.com/documentation/familycontrols
- Requesting the Family Controls entitlement: https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement
- AuthorizationCenter.requestAuthorization(for:): https://developer.apple.com/documentation/familycontrols/authorizationcenter/requestauthorization(for:)
- DeviceActivityCenter.startMonitoring: https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter/startmonitoring(_:during:events:)
- DeviceActivityMonitor: https://developer.apple.com/documentation/deviceactivity/deviceactivitymonitor
- ManagedSettingsStore: https://developer.apple.com/documentation/managedsettings/managedsettingsstore
- Forum, callbacks not delivered on iOS 26.3.1: https://developer.apple.com/forums/thread/819224
- Forum, schedule not firing without opening the app: https://developer.apple.com/forums/thread/826133
- Forum, extension profiles and per-extension entitlement: https://developer.apple.com/forums/thread/795646
