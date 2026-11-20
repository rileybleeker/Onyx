# Registers (or re-registers) the "Onyx Rewards Harvest" scheduled task: every 12 hours. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# Same settings as the Uber Eats / Kindle harvesters: hidden launcher, runs on battery, catches up after sleep,
# 20-minute limit, never wakes the PC. A run with nobody signed in just writes a partial heartbeat.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx Rewards Harvest'

# Run from a stable copy under LOCALAPPDATA, not from this checkout: a temporary git worktree that is later
# removed would otherwise leave the task pointing at a deleted folder (0x8007010B). Re-run this script after
# code changes. node_modules, .git, logs, locks and state files are not copied. State and the sign-in profile
# stay where the script already keeps them (LOCALAPPDATA\Onyx\..., ~); any state.json/log that lives beside
# the script lives in the copy (an existing state.json is seeded once).
$stable = Join-Path $env:LOCALAPPDATA 'Onyx\scheduled\rewards_harvest'
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
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours(7).AddMinutes(20)) `
  -RepetitionInterval (New-TimeSpan -Hours 12)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
