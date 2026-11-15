# Registers (or re-registers) the "Onyx Local Cleanup" scheduled task. Safe to re-run; no admin needed.
#   pwsh -File register-task.ps1
# See what it would do first (a dry run, the default; changes nothing):
#   python local_cleanup.py --list
#
# Weekly, Sunday 04:30: `pythonw.exe local_cleanup.py --apply` sends the agent scratch and test temp leftovers in
# %TEMP% that match its rules to the Recycle Bin (never a permanent delete; rules and recovery: docs/local-cleanup.md).
# Settings follow tools/pc_activity_logger/register-task.ps1 and the harvesters:
#   - pythonw.exe : Python's windowless build, so no console window opens. The script starts no child process;
#                   one added later must pass creationflags=subprocess.CREATE_NO_WINDOW.
#   - AllowStartIfOnBatteries / DontStopIfGoingOnBatteries : runs on battery too
#   - StartWhenAvailable : a run missed while asleep or off fires as soon as the PC is back
#   - ExecutionTimeLimit 1 h + MultipleInstances IgnoreNew : a stuck run cannot pile up (the script also holds
#                   a single-run lock, and a stopped run leaves every item it had not reached in place)
#   - no WakeToRun on purpose : never wake the laptop for this
# Log: %LOCALAPPDATA%\Onyx\local-cleanup\cleanup.log. Stop it: Disable-ScheduledTask -TaskName 'Onyx Local Cleanup'
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Onyx Local Cleanup'

# The real interpreter, not the Microsoft Store alias in WindowsApps.
$pythonw = Get-Command pythonw.exe -All -ErrorAction SilentlyContinue |
  Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1 -ExpandProperty Source
if (-not $pythonw) { throw 'pythonw.exe not found on PATH (install Python from python.org).' }

$action = New-ScheduledTaskAction -Execute $pythonw `
  -Argument "`"$here\local_cleanup.py`" --apply" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At ([datetime]::Today.AddHours(4).AddMinutes(30))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
