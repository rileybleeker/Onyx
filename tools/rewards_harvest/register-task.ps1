# Registers (or re-registers) the "Onyx Rewards Harvest" scheduled task: every 12 hours. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# Same settings as the Uber Eats / Kindle harvesters: hidden launcher, runs on battery, catches up after sleep,
# 20-minute limit, never wakes the PC. A run with nobody signed in just writes a partial heartbeat.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx Rewards Harvest'

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" `
  -Argument "//B //Nologo //E:JScript `"$here\run-hidden.js`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours(7).AddMinutes(20)) `
  -RepetitionInterval (New-TimeSpan -Hours 12)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
