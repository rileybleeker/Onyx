# iPhone app updates (2026-11-17)

Goal: one tap. Today shows **Update everything** when the iPhone app or the Onyx web app is behind; the app itself shows
**Update to X (N)** at the top when a newer signed build exists.

## How it works
- CI (`screentime-ios.yml`, `focus-ios-signed.yml`) signs and publishes on every merge under `tools/screentime_ios/**`.
  `CURRENT_PROJECT_VERSION` is minutes since 2026-01-01 UTC, so every build number is distinct, increasing and
  comparable across both workflows.
- The Focus build is a superset (same sources and bundle id, plus the Focus extension), so when it is published it is
  the one offered; otherwise the Screen Time build.
- On every open the app POSTs `{variant, app_version, build}` to `/api/screen-time/latest-build` (CI-token, exact path,
  the app's 3rd) which writes `pds.iphone_app_installs` and answers `{version, build, install_url, needs_trust}`.
  Today reads the newest of that table and `pds.phone_usage_sync_runs`; its button is the `itms-services` link itself.
- On open the app also runs its Screen Time sync (first launch of a build, then at most every 30 min); the Shortcut is
  an optional background trigger only.
- The web app reloads onto the newest deployment by itself when idle (`UpdateChecker`); the Today button reloads it at once.

## Signing invariant (no re-trust, Developer Mode stays on)
Every build must use the same development certificate (`IOS_DEV_CERT_B64` / key), team and bundle ids, so iOS installs over
the installed app with no trust step. A new certificate (or the 2027-11-10 expiry renewal) is the only case that needs one.
`publish_build.py` records `signing` (hash) and `signing_since_build` in `latest.json`; the extra Settings line and button
appear only when the installed build predates `signing_since_build`.

The `App-Prefs:General&path=ManagedConfigurationList` link is not a documented scheme; it is unverified on iOS 26. The app
falls back to its own Settings page, and on the web the visible text gives the path in plain words.
