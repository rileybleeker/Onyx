# Registers (or re-registers) the "Onyx Uber Eats Harvest" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# Run `node harvest.mjs --login` once BEFORE registering, or every run reports "signed out".
#
# Same settings as the Kindle harvester's task (see tools/kindle_harvest/register-task.ps1 for why):
# hidden launcher, runs on battery, catches up after sleep, 20-minute limit, never wakes the laptop.
# Every 6 hours: an order's items do not change after delivery, so there is no rush.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx Uber Eats Harvest'

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" `
  -Argument "//B //Nologo //E:JScript `"$here\run-hidden.js`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours(9).AddMinutes(40)) `
  -RepetitionInterval (New-TimeSpan -Hours 6)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
