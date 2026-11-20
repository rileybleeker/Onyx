# Registers (or re-registers) the "Onyx Kindle Harvest" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
#
# Why these settings (2026-11-09 — the laptop slept 29 h and the task then refused to start on battery,
# so the Kindle heartbeat went stale with nobody noticing until /status turned amber):
#   - wscript + run-hidden.js : no console window pops up every 3 hours; node's exit code still lands
#                               in Task Scheduler's "Last Run Result"
#   - AllowStartIfOnBatteries / DontStopIfGoingOnBatteries : a laptop on battery still harvests
#   - StartWhenAvailable      : a run missed while asleep/off fires as soon as the PC is back
#   - ExecutionTimeLimit 20 m : a hung Chrome can't block every later run (MultipleInstances=IgnoreNew)
#   - no WakeToRun on purpose : never wake a closed laptop in a bag
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx Kindle Harvest'

# Run from a stable copy under LOCALAPPDATA, not from this checkout: a temporary git worktree that is later
# removed would otherwise leave the task pointing at a deleted folder (0x8007010B). Re-run this script after
# code changes. node_modules, .git, logs, locks and state files are not copied. state.json and the log live
# beside the script, so they now live in the copy (an existing state.json is seeded once); the sign-in
# profile and token stay where they were (LOCALAPPDATA\Onyx\kindle-harvest-profile, ~).
$stable = Join-Path $env:LOCALAPPDATA 'Onyx\scheduled\kindle_harvest'
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
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours(8).AddMinutes(10)) `
  -RepetitionInterval (New-TimeSpan -Hours 3)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
