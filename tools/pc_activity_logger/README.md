# PC activity logger

Passive signal for the daily check-in: how much Riley was at the PC each hour and which programs
were in front. Runs on Riley's Windows PC as one hidden background process.

## What it records (and what it never does)

Every 30 seconds, one sample on the PC:

| Kept | How |
|---|---|
| seconds since the last keyboard / mouse input | `GetLastInputInfo` (a timestamp only) |
| the foreground program's executable name, e.g. `excel`, `code`, `chrome` | process image name, cut to the file name, lower case, no `.exe` |

**Never read or stored:** window titles, URLs, document or file names, keystrokes, mouse positions,
the clipboard, screenshots or anything on the screen. A sample is *active* when there was input in
the last 3 minutes and the screen is not locked; otherwise it is *idle*. Only active time is given
to a program. Put a program name in `%LOCALAPPDATA%\Onyx\pc-activity\exclude.txt` (one per line) and
its time is still counted as active but stored as `other`.

Samples stay in `%LOCALAPPDATA%\Onyx\pc-activity\samples-YYYY-MM-DD.jsonl` (not OneDrive) and are
removed 30 days after the day was uploaded in full.

## Where it goes

Every hour the logger turns each pending day's file into hourly totals and upserts them with the
service-role key in `~/.onyx_supabase_secret` (the same file the Rocket Money harvester reads; never
printed or logged):

- `pds.pc_activity_hours` - per UTC hour: active and idle seconds
- `pds.pc_activity_apps` - per UTC hour and program: active seconds
- `pds.pc_activity_daily` (view) - per behavioral day: active / idle minutes, minutes from 21:00 on,
  after midnight, first / last active hour, minutes per program (all day and from 21:00 on)

All three are service-role only (`sql/pc_activity_schema.sql`). Each upload writes a
`pc_activity|usage` heartbeat to `pds.sync_log`, success or failure, and `/status` shows it as
"PC Activity". A crash writes a failed heartbeat too.

## Setup (once)

1. Apply `sql/pc_activity_schema.sql` in the Supabase SQL editor (or the Supabase MCP).
2. Check it works: `python activity_logger.py probe` prints the idle seconds and the program in front.
3. Register the task (no admin needed; re-run any time to reset the settings):

```powershell
pwsh -File C:\Users\riley\Onyx\tools\pc_activity_logger\register-task.ps1
```

The task "Onyx PC Activity Logger" starts `pythonw.exe activity_logger.py run` (no window) within
10 minutes of signing in or waking up, keeps it running for the session, and restarts it if it
stopped. Only one logger runs at a time.

## Commands

```powershell
python activity_logger.py probe             # one sample, printed
python activity_logger.py upload --dry-run  # per pending day: hours, app rows, active minutes; writes nothing
python activity_logger.py upload            # upload now (the running logger does this every hour)
```

Log: `%LOCALAPPDATA%\Onyx\pc-activity\logger.log` (counts and errors only). Stop logging: disable
the task in Task Scheduler and end `pythonw.exe` in Task Manager.

Tests: `tests/test_pc_activity_aggregation.py` (synthetic samples only).
The scheduled task runs from a copy under `%LOCALAPPDATA%\Onyx\scheduled\pc_activity_logger`, so re-run `register-task.ps1` after code changes.
