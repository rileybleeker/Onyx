# Registers (or re-registers) the "Onyx Rocket Money Harvest" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# Run `node harvest.mjs --login` once BEFORE registering, or every run reports "login required".
#
# Same settings as the Kindle and Uber Eats harvesters' tasks (see tools/kindle_harvest/register-task.ps1 for why):
# hidden launcher, runs on battery, catches up after sleep, 20-minute limit, never wakes the laptop.
# Daily: balances move slowly, and harvest.mjs itself refuses a second run within 20 hours unless --force.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx Rocket Money Harvest'

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" `
  -Argument "//B //Nologo //E:JScript `"$here\run-hidden.js`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(7).AddMinutes(20))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
