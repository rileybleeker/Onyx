# Registers (or re-registers) the "Onyx AI Usage Harvest" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# Apply sql/ai_tool_usage_schema.sql BEFORE registering, or every run reports failed on /status.
#
# Same settings as tools/kindle_harvest/register-task.ps1 (a short run every 3 hours), with the PC activity
# logger's launcher:
#   - pythonw.exe            : Python's own windowless build, so no console window pops up (the same effect
#                              as the harvesters' wscript run-hidden.js); its exit code still reaches Task
#                              Scheduler's "Last Run Result"
#   - AllowStartIfOnBatteries / DontStopIfGoingOnBatteries : a laptop on battery still harvests
#   - StartWhenAvailable     : a run missed while asleep/off fires as soon as the PC is back
#   - ExecutionTimeLimit 20 m: the first run reads every log (about 10 s for 1.2 GB on 2026-11-14); later
#                              runs only read files changed since the last finished day
#   - MultipleInstances IgnoreNew, no WakeToRun (never wake a closed laptop), below-normal priority
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx AI Usage Harvest'

# The real interpreter, not the Microsoft Store alias in WindowsApps.
$pythonw = Get-Command pythonw.exe -All -ErrorAction SilentlyContinue |
  Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1 -ExpandProperty Source
if (-not $pythonw) { throw 'pythonw.exe not found on PATH (install Python from python.org).' }

$action = New-ScheduledTaskAction -Execute $pythonw `
  -Argument "`"$here\ai_usage_harvest.py`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours(7).AddMinutes(20)) `
  -RepetitionInterval (New-TimeSpan -Hours 3)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
