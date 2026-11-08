# Kindle harvester

Turns Kindle reading into Onyx `/reading` data with nothing to type. For each book in
`books.json` it opens the book in **Kindle for Web** (read.amazon.com) inside a signed-in Chrome
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

Runs on Riley's PC (Task Scheduler, every 3 hours while logged on), like the StreetEasy
harvester in `browse-proxy/local/`. It needs a real Chrome with a signed-in Amazon session,
which is why it does not run in GitHub Actions.

## One-time setup

```powershell
cd C:\Users\riley\Onyx\tools\kindle_harvest
npm install                                   # playwright (uses the installed Google Chrome, channel "chrome")
Set-Content -NoNewline ~\.onyx_ci_token "<ONYX_CI_TOKEN>"   # same secret as GitHub Actions / Vercel; never commit it
node harvest.mjs --login                      # sign in to Amazon in the window; exits when the Notebook renders
node harvest.mjs --dry-run                    # prints what it would post (chapters mapped, position, highlights)
```

Register the schedule (already done 2026-11-07; re-run after a reinstall):

```powershell
schtasks /Create /F /TN "Onyx Kindle Harvest" /SC HOURLY /MO 3 /ST 08:10 `
  /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\Users\riley\Onyx\tools\kindle_harvest\harvest.mjs\""
```

## Adding a book

1. Create the `pds.books` row (slug, total_chapters, dates, Notion page, habit name).
2. Add `{ "slug", "asin", "titleMatch" }` to `books.json`. The ASIN is in the Kindle store URL
   (`/dp/B0DFD2C9F9`) and is the element id of the book in read.amazon.com/notebook; it is optional
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
