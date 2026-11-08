# Kindle notebook harvester

Pulls highlights + notes for the books in `books.json` from the Kindle Notebook web app
(read.amazon.com/notebook) and posts them to Onyx (`POST /api/reading/highlights/import`,
`x-onyx-ci-token` auth). New highlights land on `/reading`, enter the spaced-repetition
review queue, and mirror to the book's Notion reading-log page. Idempotent on (book, passage).

Runs on Riley's PC (Task Scheduler, every 3 hours while logged on), like the StreetEasy
harvester in `browse-proxy/local/`. It needs a real Chrome with a signed-in Amazon session,
which is why it does not run in GitHub Actions.

## One-time setup

```powershell
cd C:\Users\riley\Onyx\tools\kindle_harvest
npm install                                   # playwright (uses the installed Google Chrome, channel "chrome")
Set-Content -NoNewline ~\.onyx_ci_token "<ONYX_CI_TOKEN>"   # same secret as GitHub Actions / Vercel; never commit it
node harvest.mjs --login                      # sign in to Amazon in the window; exits when the library renders
node harvest.mjs --dry-run                    # prints what it would post
```

Register the schedule (already done 2026-11-07; re-run after a reinstall):

```powershell
schtasks /Create /F /TN "Onyx Kindle Harvest" /SC HOURLY /MO 3 /ST 08:10 `
  /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\Users\riley\Onyx\tools\kindle_harvest\harvest.mjs\""
```

## Operating

- `/status` has a **Kindle** card fed by the heartbeat the import route writes on every harvester
  call (`pds.sync_log`, `source='kindle'`, `data_type='highlights'`): healthy within 12 h, degraded
  after, red after 48 h or on an error (expired Amazon session says so in the error text).
- Signed out? `node harvest.mjs --login`. Amazon sessions last months in a persistent profile.
- Selectors (`.kp-notebook-library-each-book`, `#kp-notebook-annotations`, `#highlight`, `#note`,
  `#annotationHighlightHeader`) are the long-stable Kindle Notebook DOM; if Amazon redesigns the
  page the run logs `0 highlights` for a book that has some — fix the selectors in `harvest.mjs`.
- Logs in `harvest.log`, last-run summary in `state.json` (both gitignored).
- Chapter numbers are not on the Notebook page; tag concepts on `/reading`. The Kindle app's
  "Export notebook" email does carry chapters and can still be pasted on `/reading`.
