# Local cleanup (RileyPC %TEMP%)

`tools/local_cleanup/local_cleanup.py` clears the leftovers that a dozen coding agents leave in
`%TEMP%` (`C:\Users\riley\AppData\Local\Temp`): Claude session scratch folders, frontend copies made
by UI test scripts, test temp folders, one-off edit scripts and Playwright profiles. A manual sweep
on 2026-11-14 freed about 5 GB of exactly these. It **sends them to the Recycle Bin**; it never
deletes anything permanently. Branches and git worktrees are not its job: the personal-agents
"Branch Cleanup" scheduled task owns those.

Standard library only (no pip install), Windows for `--apply`. It starts no child processes.

## What it does

A **dry run is the default**. It prints, per category, how many items it would recycle and their
size, then how many it keeps and why. Nothing changes on disk.

```powershell
python C:\Users\riley\Onyx\tools\local_cleanup\local_cleanup.py          # dry run
python C:\Users\riley\Onyx\tools\local_cleanup\local_cleanup.py --list   # dry run + every item and why it is kept
python C:\Users\riley\Onyx\tools\local_cleanup\local_cleanup.py --apply  # recycle what the dry run lists
```

It looks only in `%TEMP%`, and there only at these names:

| Category | Matches (in `%TEMP%`) | What it is |
|---|---|---|
| `claude-scratch` | `claude\<project>\<session-uuid>` folders | Claude Code session scratch (some over 1 GB) |
| `ui-copies` | `onyx-*-ui-XXXXXX` folders | frontend copies made by UI test scripts (~35 MB each) |
| `test-temp` | `onyx-wins-*`, `onyx-install-builds-*`, `onyx-supp-reminders-*` folders | test temp folders (hundreds) |
| `edit-scripts` | `edit_*.py`, `patch*.py` files | one-off agent edit scripts |
| `claude-cwd` | `claude-*-cwd` files | Claude Code shell working-directory files |
| `playwright` | `playwright-artifacts-*`, `playwright_chromiumdev_profile-*` folders | Playwright leftovers |

## What it never touches

An item is kept when any of these holds:

- **It is, or contains anywhere, something named `.git`.** Git worktrees belong to Branch Cleanup.
- **It is the scratch folder of a Claude session** listed in `~\.claude\sessions\*.json` (`sessionId`).
  If any of those files cannot be read, no scratch folder is touched that run. The `.key` files
  next to them are never opened.
- **Anything in it was modified or created in the last 12 hours.** The newest file decides, not the
  folder's own date, and a fresh copy of old files counts as new.
- **Its path, or any path inside it, is longer than 259 characters.** The Recycle Bin call cannot
  take those, and a half-recycled folder is worse than none.
- **It is a link or junction.** Links inside an item (the frontend copies link `node_modules` to a
  real checkout) are never followed: their target is not measured, read or recycled. On the same
  drive the Recycle Bin moves the link itself.
- **It is in `%LOCALAPPDATA%\Onyx` (automation runtime), `~\.codex` or `~\.claude\projects`
  (transcripts).** All three are outside `%TEMP%`; the tool checks anyway and refuses to start if
  `%TEMP%` overlaps one of them, is the home folder or is a drive root.
- **It is over 10 GB, or past the run's limit** (`--max-items`, default 2000; `--max-gb`, default 20).
  The oldest go first; the rest wait for the next run.

`--apply` checks every item again right before recycling it and skips it if anything changed since
the scan. It recycles one item at a time with the Windows shell (`SHFileOperationW`, `FO_DELETE` with
`FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI`), plus `FOF_WANTNUKEWARNING`: if
Windows ever could not put an item in the Recycle Bin, it asks instead of deleting it silently. Only
one run at a time (a named mutex).

## Schedule (Riley runs this once)

```powershell
pwsh -File C:\Users\riley\Onyx\tools\local_cleanup\register-task.ps1
```

This registers the Task Scheduler task **"Onyx Local Cleanup"**: every Sunday at 04:30 it runs
`pythonw.exe local_cleanup.py --apply` with no window, on battery too, catches up after sleep, never
wakes the laptop, stops after 1 hour. Re-run the script any time to reset the settings. No admin
needed.

- **Log:** `%LOCALAPPDATA%\Onyx\local-cleanup\cleanup.log`: each run's counts, every recycled path with
  its size, skips and failures (no file contents). Kept to about 1 MB plus one older file.
- **Undo:** open the Recycle Bin, sort by "Date deleted", select, Restore. Items go back to their
  original place.
- **Disk space** comes back when the Recycle Bin is emptied (by hand, or by Storage Sense if it is set
  to empty it after some days); until then Windows trims the oldest bin items itself when it is full.
- **Pause / stop:** `Disable-ScheduledTask -TaskName 'Onyx Local Cleanup'`, or
  `Unregister-ScheduledTask -TaskName 'Onyx Local Cleanup'` to remove it.

## Changing the rules

The categories are `TOP_LEVEL` (and the `claude\<project>\<uuid>` scratch rule) at the top of
`local_cleanup.py`; the keep rules are in `evaluate()`. Add a category only for something agents
create and nobody needs after 12 hours; never widen it to `%TEMP%` as a whole, the home folder or a
project checkout. Update `tests/test_local_cleanup.py` with every rule change (synthetic temp tree;
nothing is recycled in tests).
