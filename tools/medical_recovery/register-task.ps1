# Registers (or re-registers) the "Onyx Medical Backup" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# Do these first, or every run reports failed on /status (Medical Backup card):
#   1. winget install FiloSottile.age            (age and age-keygen)
#   2. python offsite_backup.py keygen           (once; then copy the private key into the password manager)
#   3. python offsite_backup.py backup --dry-run (counts only; nothing is written)
#
# Same settings as tools/kindle_harvest/register-task.ps1 and tools/ai_usage_harvest/register-task.ps1, but weekly:
#   - pythonw.exe            : Python's windowless build, so no console window pops up; age is started without
#                              one too (CREATE_NO_WINDOW). Its exit code still reaches "Last Run Result"
#                              (0 success, 2 partial, 1 failed)
#   - Logged-on only (Interactive), like the harvesters: the job reads ~/.onyx_supabase_secret and writes to the
#     signed-in user's OneDrive folder
#   - AllowStartIfOnBatteries / DontStopIfGoingOnBatteries : a laptop on battery still backs up
#   - StartWhenAvailable     : a run missed while asleep or off fires as soon as the PC is back
#   - ExecutionTimeLimit 1 h : every file is downloaded and encrypted on each run
#   - MultipleInstances IgnoreNew, no WakeToRun (never wake a closed laptop), below-normal priority
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx Medical Backup'

# The real interpreter, not the Microsoft Store alias in WindowsApps.
$pythonw = Get-Command pythonw.exe -All -ErrorAction SilentlyContinue |
  Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1 -ExpandProperty Source
if (-not $pythonw) { throw 'pythonw.exe not found on PATH (install Python from python.org).' }
if (-not (Test-Path (Join-Path $HOME '.onyx_backup_age_recipient'))) {
  throw 'No backup public key yet: run  python offsite_backup.py keygen  first.'
}

$action = New-ScheduledTaskAction -Execute $pythonw `
  -Argument "`"$here\offsite_backup.py`" backup" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At ([datetime]::Today.AddHours(11).AddMinutes(10))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1) -Priority 7
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
