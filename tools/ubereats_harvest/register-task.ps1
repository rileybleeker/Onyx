# Registers (or re-registers) the "Onyx Uber Eats Harvest" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# Run `node harvest.mjs --login` once BEFORE registering, or every run reports "signed out".
#
# Same settings as the Kindle harvester's task (see tools/kindle_harvest/register-task.ps1 for why):
# hidden launcher, runs on battery, catches up after sleep, 20-minute limit, never wakes the laptop.
# Every 10 minutes (Riley 2026-11-15: a meal must be loggable right after it arrives). A run with nothing new reads
# one page of order history and stops, so frequent runs are cheap.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx Uber Eats Harvest'

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" `
  -Argument "//B //Nologo //E:JScript `"$here\run-hidden.js`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours(9).AddMinutes(40)) `
  -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
