# Onyx Screen Time (iPhone app)

Reads Apple's Screen Time export (iOS 26.4+ `DeviceActivityData.activityData`)
and sends hourly usage to Onyx (`POST /api/screen-time/usage`). Personal,
development-signed, never published. There is no Mac: GitHub Actions compiles
and signs it (`.github/workflows/screentime-ios.yml`).

**This repository is public.** Workflow logs and artifacts are world-readable,
so the signed job uploads no artifacts and prints no device ID or links. The
build goes to a private Supabase Storage bucket and the install links are shown
on the Onyx page `/install`, behind the normal login.

## What Apple requires

- A paid Apple Developer Program membership (individual is fine).
- Outside the EU the export API works only in a **development-signed** build
  (not TestFlight, App Store or Ad Hoc).
- Only one app per device can hold data access (`approvedWithDataAccess`).
- The certificate and the profile each last about a year. Treat the earlier
  date as the deadline (`/install` shows it). Apple does not document what an
  expired development certificate does to an installed app; reports say it
  stops opening.
  - Portal path: re-running the job renews nothing. Create a new Apple
    Development certificate (upload the same `onyx_dev.certSigningRequest`)
    and a new profile, update `IOS_DEV_CERT_B64` and `IOS_PROFILE_B64`, then
    run the job and reinstall.
  - API path: run the job during the last 30 days (it then makes a new
    certificate and profile), then reinstall from `/install`. The date on
    `/install` belongs to the newest published build, not to whatever is on
    the phone.
- A new process always starts with Screen Time access "not determined", so
  the app asks again on every launch (silent once approved). If the daily
  sync stops, open the app once.

## One-time setup

The development private key already exists at `~/.onyx-ios-signing/onyx_dev.key`
(outside OneDrive and the repo) and is stored as the `IOS_DEV_KEY_B64` secret.
Its certificate request is `~/.onyx-ios-signing/onyx_dev.certSigningRequest`.

In the developer portal (`developer.apple.com/account` → Certificates,
Identifiers & Profiles):

1. **Identifiers → + → App IDs → App.** Explicit Bundle ID
   `com.rileybleeker.onyxscreentime`. Tick **Family Controls (Development)** and,
   if the list shows it, **Family Controls App And Website Usage** (not yet
   confirmed that the portal lists it separately). The API cannot tick these.
   If it is not listed, create the profile anyway and run the job: the
   "Install provisioning profile" step reports, before the build starts,
   whether the profile carries both entitlements.
2. **Devices → +.** Register the iPhone by its UDID. On Windows, with the phone
   plugged in and unlocked:
   ```powershell
   Get-PnpDevice -PresentOnly |
     Where-Object { $_.InstanceId -match '^USB\\VID_05AC&PID_12[0-9A-F]{2}\\' -and $_.InstanceId -notmatch '&MI_' } |
     ForEach-Object { $s = ($_.InstanceId -split '\\')[-1]; if ($s.Length -eq 24) { $s.Insert(8,'-') } else { $s } }
   ```
3. **Certificates → + → Apple Development.** Upload `onyx_dev.certSigningRequest`,
   download the `.cer`.
4. **Profiles → + → iOS App Development.** Pick the App ID, the certificate and
   the iPhone; download the `.mobileprovision`.

Then store the two downloads as secrets (PowerShell, from the repo folder):

```powershell
$d = "$HOME\.onyx-ios-signing"
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$d\development.cer")) | gh secret set IOS_DEV_CERT_B64
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$d\profile.mobileprovision")) | gh secret set IOS_PROFILE_B64
```

Optional: `gh secret set IPHONE_UDID` lets the job confirm the phone is in the
profile.

Database: `sql/phone_usage_schema.sql` (tables `phone_usage_segments`,
`phone_usage_items`, view `phone_usage_daily`). Service role only: they hold
every app and web domain used, so unlike most `pds` tables they are not
anon-readable. Re-run the file after any change to it (safe to re-run). It
must be re-run once after 2026-11-10: the first version, which is what the
database got, granted anon read. `/status` card: "Screen Time app"
(heartbeat `screen_time|usage`).

### Alternative: App Store Connect API (no portal downloads)

If `IOS_DEV_CERT_B64` / `IOS_PROFILE_B64` are absent and `ASC_KEY_ID`,
`ASC_ISSUER_ID`, `ASC_KEY_P8` (a **Team** key, Admin role) and `IPHONE_UDID` are
set, `ci/asc_signing.py` registers the App ID and device and creates the
certificate and a fresh profile itself. The capabilities in step 1 must still
be ticked by hand. Untested against a real account.

## Build and install

1. `gh workflow run screentime-ios.yml` (signed build + publish).
2. On the iPhone, open `<Onyx>/install` in Safari and tap **Install**.
3. Tap the app; when iOS asks, turn on Settings → Privacy & Security →
   Developer Mode, restart, confirm.
4. Open the app online and approve the Screen Time prompt (tap **Grant access**
   if it does not appear), paste the Onyx CI token, **Sync**.
5. Shortcuts → Automation → Time of Day (daily) → **Sync Screen Time to Onyx**.

Failed syncs (from the build after 2026-11-11): when Screen Time cannot be read,
or Onyx cannot be reached or answers with an error, the app POSTs
`{ failure: { stage, message } }` to `/api/screen-time/usage` before showing
the error, and the "Screen Time app" card on `/status` turns red on that run.
Stages: `access`, `read`, `encode`, `network`, `http`. A missing token or one
Onyx refuses (401) cannot be reported; the card catches those when the last
heartbeat is more than 36 h old. Builds before this one report nothing.

If neither install link works, download the `.ipa` from `/install` on the PC and
install over USB with `pymobiledevice3 apps install <file>` (it also prints the
phone's real error). `pymobiledevice3 amfi reveal-developer-mode` shows the
Developer Mode switch if it never appears.

## Files

- `project.yml` — XcodeGen spec; the `.xcodeproj` is generated in CI.
- `OnyxScreenTime/` — the app (SwiftUI, App Intent, exporter, Keychain token).
- `ci/asc_signing.py` — App Store Connect API path for certificate + profile.
- `ci/publish_build.py` — uploads the build and writes `screentime/latest.json`
  (private bucket `ios-builds`; manifests for the alternative link sit at
  unguessable paths in `ios-builds-public`).
