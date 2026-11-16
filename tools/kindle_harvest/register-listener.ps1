# Sets up (or restarts) the Run now listener for the Kindle harvester. Safe to re-run; no admin needed.
#   pwsh -File register-listener.ps1
#
# The listener (run-listener.mjs) is one idle process holding a websocket to Supabase Realtime: the
# /status Kindle card's Run now button inserts a pds.pc_run_requests row, Realtime pushes it here,
# and the listener starts the "Onyx Kindle Harvest" scheduled task. Nothing polls on a schedule.
#
# Started at sign-in by a shortcut in the Startup folder (a Task Scheduler logon trigger needs admin
# rights), hidden through wscript run-hidden.js like the harvest task. This script also starts it
# now, after stopping a listener that is already running so a code update takes effect.
# Needs ~/.onyx_supabase_secret (the service key file the PC activity logger uses) and Node 22+.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$wscript = "$env:WINDIR\System32\wscript.exe"
$arguments = "//B //Nologo //E:JScript `"$here\run-hidden.js`" run-listener.mjs"

if (-not (Test-Path "$env:USERPROFILE\.onyx_supabase_secret")) { throw 'Missing ~/.onyx_supabase_secret (the Supabase service key file).' }

# Startup-folder shortcut: runs the listener at every sign-in.
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'Onyx Kindle Run Listener.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = $wscript
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $here
$shortcut.WindowStyle = 7
$shortcut.Description = 'Onyx: answers the Run now button on the /status Kindle card'
$shortcut.Save()

# Stop a listener that is already running (only processes running this folder's run-listener.mjs).
$mine = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$here\run-listener.mjs*" }
foreach ($p in $mine) { Stop-Process -Id $p.ProcessId -Force }
if ($mine) { Start-Sleep -Seconds 1 }

Start-Process -FilePath $wscript -ArgumentList $arguments -WorkingDirectory $here
Start-Sleep -Seconds 4
$running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$here\run-listener.mjs*" }
"Startup shortcut: $lnk"
"Listener running: $([bool]$running) (restarted $(@($mine).Count))"
Get-Content "$here\listener.log" -Tail 3 -ErrorAction SilentlyContinue
