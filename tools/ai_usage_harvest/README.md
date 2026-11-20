# AI tool usage harvester

How much Riley works with Claude Code and Codex, and when (late-night sessions as a behavior signal
next to screen time). Runs on Riley's Windows PC every 3 hours as a hidden scheduled task.

## What it keeps (and what it never does)

Both tools keep their session logs on the PC: Claude Code in `~/.claude/projects/<project>/<session>.jsonl`
(about 30 days), Codex in `~/.codex/sessions/YYYY/MM/DD/*.jsonl[.zst]`. Those files hold whole
conversations, file contents, command output and possibly secrets. The harvester reads each line in
memory and keeps only:

| Kept | From |
|---|---|
| when it happened | the record's time (Codex: its turn / item event times) |
| prompts typed, tool calls | record and block types (never their text) |
| tokens (input, output, cache read / write), model names | each reply's usage block |
| the project | the working folder's **name** only (`C:\Users\riley\Onyx` -> `onyx`; a Claude Code worktree -> its repo; the home folder -> `home`) |

**Never kept, printed, logged or uploaded:** prompt or reply text, thinking, tool inputs or outputs,
file paths or contents, branch names, titles, session ids. Every row is checked against an allow-list
before upload (`check_row`); a row that fails stops the upload and writes a failed `GUARD privacy:`
heartbeat. Put a project folder name in `%LOCALAPPDATA%\Onyx\ai-usage\exclude.txt` (one per line) and
its sessions are still counted but stored as `other`.

Left out entirely: SDK-driven Claude Code runs (`entrypoint` `sdk-*`) and Codex `exec` runs (automation,
not Riley). Subagent transcripts add their tokens and tool calls and are counted as subagents, not as
sessions, prompts or active minutes.

## Where it goes

One row per (device, behavioral day, tool, project) in `pds.ai_tool_usage_daily`
(`sql/ai_tool_usage_schema.sql`; owner read, service role write), upserted with the service-role key in
`~/.onyx_supabase_secret` (the PC activity logger's write path; never printed or logged): sessions
started, subagents, prompts, tool calls, active minutes (distinct minutes with activity) and how many of
them were late (21:00-05:59) or after midnight, session minutes, tokens, models, first / last activity.
The behavioral day follows ADR-0001 in the PC's time zone (00:00-05:59 belongs to the day before).

Each run writes an `ai_usage|sessions` heartbeat to `pds.sync_log`, success or failure; `/status` shows it
as "AI Tool Usage" (>26 h degraded, >72 h or a failed row red). `partial` means some log files could not
be read; their days stay open and are read again next run.

A day is re-sent on every run until it has ended (plus an hour), then it is final and never sent again,
so Claude Code deleting old logs cannot shrink a stored day. On the first run Claude Code days older than
25 days are not sent (some of their logs may already be gone); Codex keeps its logs, so all of its
history is sent. State: `%LOCALAPPDATA%\Onyx\ai-usage\state.json`.

## Setup (once)

1. Apply `sql/ai_tool_usage_schema.sql` in the Supabase SQL editor (or the Supabase MCP).
2. Check it: `python ai_usage_harvest.py --dry-run` prints aggregate counts only and writes nothing.
3. Register the task (no admin needed; re-run any time to reset the settings):

```powershell
pwsh -File C:\Users\riley\Onyx\tools\ai_usage_harvest\register-task.ps1
```

The task "Onyx AI Usage Harvest" runs `pythonw.exe ai_usage_harvest.py` (no window) every 3 hours,
on battery too, and catches up after sleep. Standard library only; reading Codex's older `.zst` logs
needs Python 3.14+ (without it they are skipped and the run reports `partial`).

Log: `%LOCALAPPDATA%\Onyx\ai-usage\harvest.log` (counts and error types only). Stop: disable the task.

Tests: `tests/test_ai_usage_harvest.py` (synthetic logs only; fails if any log content reaches the rows,
the printed summary, the upload or the log).
The scheduled task runs from a copy under `%LOCALAPPDATA%\Onyx\scheduled\ai_usage_harvest`, so re-run `register-task.ps1` after code changes.
