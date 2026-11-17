# Kindle harvester

Turns Kindle reading into Onyx `/reading` data with nothing to type. For each book in
the private `~/.onyx_kindle_books.json` (or ignored legacy `books.json`) it opens the book in **Kindle for Web** (read.amazon.com) inside a signed-in Chrome
profile and intercepts what the reader fetches:

| Captured | Used for |
|---|---|
| `getAnnotations` JSON | every highlight + note, with Kindle **position** and a real **timestamp** |
| first `renderer/render` tar → `toc.json` | chapter → start position (`pds.book_chapters`) |
| … → `location_map.json` | print page labels (`p. 9`) |
| … → `metadata.json` | book length (`total_positions`) |
| page HTML `mostRecentPositionRead` | the Whispersync reading position |

It posts all of it to Onyx (`POST /api/reading/highlights/import`, `x-onyx-ci-token` auth).
Onyx upserts the highlights (idempotent on passage), stores the chapter map + position, and
**derives sessions** (`lib/reading-kindle.ts`): a highlight on a chapter's last page completes the
chapter, a highlight inside chapter N proves N-1, the reading position does the same, and any day
with a new highlight or note gets a `source='kindle'` session whose recall is the notes verbatim.
New highlights and sessions mirror to the book's Notion reading-log page.

Runs on the collector PC (Task Scheduler, every 3 hours while logged on), like the StreetEasy
harvester in `browse-proxy/local/`. It needs a real Chrome with a signed-in Amazon session,
which is why it does not run in GitHub Actions.

## One-time setup

Copy `books.example.json` to `~/.onyx_kindle_books.json`, set your app URL and
private book mappings there. The home file takes precedence over the ignored
legacy `books.json`; preserve an existing local config before updating a checkout.
Never commit reading targets. An invalid private config fails visibly rather
than falling back to stale targets.

```powershell
cd C:\Users\riley\Onyx\tools\kindle_harvest
npm install                                   # playwright (uses the installed Google Chrome, channel "chrome")
Set-Content -NoNewline ~\.onyx_ci_token "<ONYX_CI_TOKEN>"   # same secret as GitHub Actions / Vercel; never commit it
node harvest.mjs --login                      # sign in to Amazon in the window; exits when the Notebook renders
node harvest.mjs --dry-run                    # prints what it would post (chapters mapped, position, highlights)
```

Register the schedule (done; re-run after a reinstall or to reset the settings — no admin needed):

```powershell
pwsh -File C:\Users\riley\Onyx\tools\kindle_harvest\register-task.ps1
```

The task runs every 3 hours from 08:10 with **no visible window**: Task Scheduler starts
`wscript.exe run-hidden.js`, which launches node with a hidden console and passes node's exit code
back as the task's Last Run Result (0 ok, 1 harvest error, 2 Amazon signed out, 3 no Onyx token).
Chrome itself stays headful but parked off-screen, because Amazon challenges headless Chrome.
It also runs on battery, catches up a run missed while the PC was asleep or off as soon as it is
back (`StartWhenAvailable`), and is killed after 20 minutes so a hung Chrome cannot block later runs.
It never wakes the PC. (Before 2026-11-09 the task was a bare `schtasks … node.exe harvest.mjs`:
it popped a console window, refused to start on battery — result `0x800710E0` — and skipped every
run missed during sleep, which left the heartbeat 32 h stale.)

## Run now (from Onyx)

The Kindle card on `/status` has a **Run now** button. It is event driven: nothing on the PC polls.

1. The button calls `POST /api/kindle/run` (owner session only), which inserts a row into
   `pds.pc_run_requests` (`sql/pc_run_requests.sql`, service-role only).
2. Supabase Realtime pushes that INSERT to `run-listener.mjs`, one idle Node process on the PC that
   holds a single websocket (its only traffic is Realtime's keep-alive every 25 s).
3. The listener starts the "Onyx Kindle Harvest" task (so a pressed run and a scheduled run never
   collide on the Chrome profile) and writes back on the row: started / already running, then the
   harvester's exit code when it ends. The button shows each step.

If the PC is asleep or off, the button says so after 15 s; a press up to 2 minutes old is still
answered when the PC reconnects. Set up (or restart after a code change), no admin needed:

```powershell
pwsh -File C:\Users\riley\Onyx\tools\kindle_harvest\register-listener.ps1
```

It puts a shortcut in the Startup folder (runs the listener hidden at every sign-in) and starts it
now. Needs `~/.onyx_supabase_secret` (the same service key file as the PC activity logger). The log
is `listener.log` (times, events and request ids only).

## Adding a book

1. Create the `pds.books` row (slug, total_chapters, dates, Notion page, habit name).
2. Add `{ "slug", "asin", "titleMatch" }` to `~/.onyx_kindle_books.json`. The ASIN is in the Kindle store URL
   (`/dp/<ASIN>`) and is the element id of the book in read.amazon.com/notebook; it is optional
   when the title regex matches the Notebook library entry (which only exists once something is
   highlighted).
3. Only **numbered** TOC entries become chapters (`1`, `Chapter 12`, `12. Title`); front/back
   matter is skipped. A book without numbered chapters still gets highlights + position, but no
   automatic chapter completion.

## Operating

- `/status` has a **Kindle** card fed by the heartbeat the import route writes on every harvester
  call (`pds.sync_log`, `source='kindle'`, `data_type='highlights'`): healthy within 12 h, degraded
  after, red after 48 h or on an error (expired Amazon session says so in the error text).
- Signed out? `node harvest.mjs --login`. Amazon sessions last months in a persistent profile.
- Amazon occasionally answers the reader with a `/checkpoint/…` redirect or a "Website Temporarily
  Unavailable" page; the run retries once after 30 s, then reports a failed heartbeat and the next
  3-hour run picks it up.
- Opening the book in the web reader does not move the reading position (no navigation happens),
  so the phone/Kindle never gets a "sync to furthest page" prompt from the harvester.
- Logs in `harvest.log`, last-run summary in `state.json` (both gitignored).
- Session attribution uses the highlight's own timestamp → behavioral day (−6h rule, TZ-aware);
  the reading position is attributed to the harvest day (approximate, used only when there are no
  highlights that day). Manual `/reading` and chat sessions are never touched by the sync and are
  what audiobook listening still needs (unless Whispersync for Voice moves the Kindle position).

## Offline reliability tests

Run: node --test tools/kindle_harvest/harvest.test.mjs. These tests use synthetic responses and browser stubs, without credentials, Amazon, or production writes. CI runs them on harvester changes.

Imports time out after 60 seconds and HTTP errors, malformed responses, and partial imports fail the run. Browser startup/navigation failures attempt a generic failed heartbeat; login and dry-run modes never post failure heartbeats. If Onyx itself cannot be reached, the local log and nonzero task exit remain the fallback.
