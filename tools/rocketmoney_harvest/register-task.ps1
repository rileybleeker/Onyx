# Registers (or re-registers) the "Onyx Rocket Money Harvest" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1              every 2 hours (the default)
#   pwsh -File register-task.ps1 -Hours 1     a shorter interval, if harvest.log warns that the app session is shorter
#   pwsh -File register-task.ps1 -Wake        also wake the laptop for each run (read the warning below first)
#
# Why every 2 hours, when the data is only imported once a day: Rocket Money's web sign-in is a short rolling
# session (reported as about 3 h 48 min after the app was last used). A daily visit found itself signed out
# every time. harvest.mjs imports once 20 hours have passed since the last import; the runs in between only
# open the app so the session is renewed, and write nothing. See the README, "Staying signed in".
#
# Same settings as the Kindle and Uber Eats harvesters' tasks (see tools/kindle_harvest/register-task.ps1 for why):
# hidden launcher, runs on battery, catches up after sleep, 20-minute limit.
#
# -Wake is off by default, like the other harvesters: a keep-alive cannot run while the laptop is asleep, so a
# sleep longer than the session's lifetime ends the session, and only the silent renewal (README) can bring it
# back. -Wake makes Task Scheduler wake the laptop for each run. WARNING: where Windows allows wake timers on
# battery as well as on mains (Power Options > Sleep > Allow wake timers), a closed laptop in a bag then wakes
# up every 2 hours. Use -Wake only if harvest.log shows the sign-in ending after sleep gaps, and switch wake
# timers off on battery first.
param(
  [ValidateRange(1, 12)][int]$Hours = 2,
  [switch]$Wake
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx Rocket Money Harvest'

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" `
  -Argument "//B //Nologo //E:JScript `"$here\run-hidden.js`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours(7).AddMinutes(20)) `
  -RepetitionInterval (New-TimeSpan -Hours $Hours)
$settingsArgs = @{
  AllowStartIfOnBatteries    = $true
  DontStopIfGoingOnBatteries = $true
  StartWhenAvailable         = $true
  MultipleInstances          = 'IgnoreNew'
  ExecutionTimeLimit         = (New-TimeSpan -Minutes 20)
}
if ($Wake) { $settingsArgs.WakeToRun = $true }
$settings = New-ScheduledTaskSettingsSet @settingsArgs
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
