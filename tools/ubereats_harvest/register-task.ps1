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

# Run from a stable copy under LOCALAPPDATA, not from this checkout: a temporary git worktree that is later
# removed would otherwise leave the task pointing at a deleted folder (0x8007010B). Re-run this script after
# code changes. node_modules, .git, logs, locks and state files are not copied. state.json and the log live
# beside the script, so they now live in the copy (an existing state.json is seeded once); the sign-in
# profile and token stay where they were (LOCALAPPDATA\Onyx\ubereats-harvest-profile, ~).
$stable = Join-Path $env:LOCALAPPDATA 'Onyx\scheduled\ubereats_harvest'
New-Item -ItemType Directory -Force -Path $stable | Out-Null
Get-ChildItem -LiteralPath $here -Force -Exclude 'node_modules', '.git', '*.log', '*.lock', 'state.json', 'probe.png' |
  Copy-Item -Destination $stable -Recurse -Force
if ((Test-Path "$here\state.json") -and -not (Test-Path "$stable\state.json")) { Copy-Item "$here\state.json" "$stable\state.json" }
if ((Test-Path "$here\package.json") -and (Test-Path "$here\node_modules") -and -not (Test-Path "$stable\node_modules")) {
  Copy-Item "$here\node_modules" "$stable\node_modules" -Recurse -Force   # the script imports playwright from here
}
Write-Host "Stable copy registered: $stable"

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" `
  -Argument "//B //Nologo //E:JScript `"$stable\run-hidden.js`"" -WorkingDirectory $stable
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours(9).AddMinutes(40)) `
  -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
