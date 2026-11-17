# Registers (or re-registers) the "Onyx YouTube History" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# Apply sql/youtube_watch_history_schema.sql first. Runs once a day: a Takeout export lands every 2 months, but
# OneDrive may sync it any day, and a daily look costs nothing (a run with nothing new reads no file contents).
# Same settings as tools/ai_usage_harvest/register-task.ps1 (pythonw.exe: no console window; battery OK;
# a run missed while asleep fires when the PC is back; never wakes the PC).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx YouTube History'

$pythonw = Get-Command pythonw.exe -All -ErrorAction SilentlyContinue |
  Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1 -ExpandProperty Source
if (-not $pythonw) { throw 'pythonw.exe not found on PATH (install Python from python.org).' }

$action = New-ScheduledTaskAction -Execute $pythonw `
  -Argument "`"$here\youtube_history.py`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(10).AddMinutes(10))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
