# Registers (or re-registers) the "Onyx PC Activity Logger" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# Apply sql/pc_activity_schema.sql BEFORE registering, or every hourly upload reports failed on /status.
#
# Unlike the harvesters this is one long-running process (it samples every 30 s and uploads every hour),
# so the settings differ from tools/kindle_harvest/register-task.ps1 in two places:
#   - no time limit (ExecutionTimeLimit 0): the logger runs for the whole Windows session
#   - a trigger every 10 minutes: starts the logger within 10 minutes of sign-in or wake-up, and restarts it
#     if it ever stopped; while it runs, MultipleInstances=IgnoreNew makes the trigger a no-op (and the
#     logger also refuses to run twice). No logon trigger: those need admin rights.
# Shared with the harvesters: pythonw.exe has no console window (Python's own windowless build, the same
# effect as their wscript run-hidden.js launcher), runs on battery, catches up after sleep
# (StartWhenAvailable), never wakes the laptop, below-normal priority (the Task Scheduler default).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx PC Activity Logger'

# The real interpreter, not the Microsoft Store alias in WindowsApps.
$pythonw = Get-Command pythonw.exe -All -ErrorAction SilentlyContinue |
  Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1 -ExpandProperty Source
if (-not $pythonw) { throw 'pythonw.exe not found on PATH (install Python from python.org).' }

$action = New-ScheduledTaskAction -Execute $pythonw `
  -Argument "`"$here\activity_logger.py`" run" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddMinutes(3)) `
  -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
