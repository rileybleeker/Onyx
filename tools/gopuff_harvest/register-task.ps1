# Registers (or re-registers) the "Onyx goPuff Harvest" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# Sign in to goPuff on the harvester profile ONCE before registering (README, "What you do once"), or every
# run reports "session missing or expired".
#
# Same settings as the Uber Eats and Kindle harvesters (see tools/kindle_harvest/register-task.ps1):
# hidden launcher, runs on battery, catches up after sleep, 20-minute limit, never wakes the laptop.
# Every 6 hours: orders arrive a few times a month, and a run with nothing new reads one page and stops.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx goPuff Harvest'

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" `
  -Argument "//B //Nologo //E:JScript `"$here\run-hidden.js`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours(9).AddMinutes(20)) `
  -RepetitionInterval (New-TimeSpan -Hours 6)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
