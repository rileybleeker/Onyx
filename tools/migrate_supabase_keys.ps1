# Swap Onyx's legacy JWT-style Supabase keys for the new sb_publishable_ / sb_secret_ keys.
#
#   pwsh -File tools\migrate_supabase_keys.ps1            # do it
#   pwsh -File tools\migrate_supabase_keys.ps1 -CheckOnly # just test the new keys, change nothing
#
# You do the two things only you can: create the keys in the Supabase dashboard
# (Project settings -> API Keys -> "Publishable and secret API keys") and run this script.
# Keys are typed into hidden prompts. They are never printed, logged or sent anywhere except
# Supabase (verification) and GitHub (the one secret, over stdin). Old values are backed up
# under ~\.onyx-key-backup\<timestamp> (your home folder, not OneDrive).
#
# Why it is safe to run: the new keys are verified against the live API BEFORE anything is
# changed, and the legacy keys keep working until the end of 2026, so nothing breaks if you
# stop halfway. supabase-py 2.31 and supabase-js ^2.99 already accept the new format.
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$localFile = Join-Path $root 'frontend\.env.local'

function Read-Secret([string]$prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Get-EnvValue([string]$file, [string]$name) {
  if (-not (Test-Path $file)) { return $null }
  $m = Select-String -Path $file -Pattern "^\s*$name\s*=\s*(.*)$" | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'") }
}
function Set-EnvValue([string]$file, [string]$name, [string]$value) {
  if (-not (Test-Path $file)) { return $false }
  $lines = Get-Content $file
  $hit = $false
  $out = foreach ($l in $lines) { if ($l -match "^\s*$name\s*=") { $hit = $true; "$name=$value" } else { $l } }
  if ($hit) { Set-Content -Path $file -Value $out -Encoding utf8 }
  return $hit
}
function Probe([string]$url, [hashtable]$headers) {
  try { (Invoke-WebRequest -Uri $url -Headers $headers -Method Get -SkipHttpErrorCheck -TimeoutSec 30).StatusCode } catch { 0 }
}

$url = Get-EnvValue $envFile 'SUPABASE_URL'
if (-not $url) { throw "SUPABASE_URL not found in $envFile" }
$url = $url.TrimEnd('/')

$pub = Read-Secret 'New publishable key (sb_publishable_...)'
$sec = Read-Secret 'New secret key (sb_secret_...)'
if ($pub -notmatch '^sb_publishable_' -or $sec -notmatch '^sb_secret_') { throw 'Keys have the wrong prefix; nothing was changed.' }

# 1. verify BEFORE touching anything
$auth = Probe "$url/auth/v1/settings" @{ apikey = $pub }
$rest = Probe "$url/rest/v1/sync_log?select=source&limit=1" @{ apikey = $sec; Authorization = "Bearer $sec"; 'Accept-Profile' = 'pds' }
"publishable key  -> auth settings HTTP $auth (want 200)"
"secret key       -> pds.sync_log read HTTP $rest (want 200)"
if ($auth -ne 200 -or $rest -ne 200) { throw 'Verification failed; nothing was changed.' }
if ($CheckOnly) { 'Both keys work. Nothing changed (-CheckOnly).'; return }

# 2. back up, then update the local env files
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $HOME ".onyx-key-backup\$stamp"
New-Item -ItemType Directory -Path $bak -Force | Out-Null
foreach ($f in @($envFile, $localFile)) { if (Test-Path $f) { Copy-Item $f $bak } }
"Backed up the old env files to $bak"
foreach ($pair in @(
    @($envFile, 'SUPABASE_SERVICE_ROLE_KEY', $sec), @($envFile, 'SUPABASE_ANON_KEY', $pub),
    @($localFile, 'SUPABASE_SERVICE_ROLE_KEY', $sec), @($localFile, 'NEXT_PUBLIC_SUPABASE_ANON_KEY', $pub))) {
  $done = Set-EnvValue $pair[0] $pair[1] $pair[2]
  "{0,-48} {1}" -f ((Split-Path $pair[0] -Leaf) + ' ' + $pair[1]), $(if ($done) { 'updated' } else { 'not present, skipped' })
}

# 3. GitHub Actions secret (stdin, so it never appears in a process list or log)
$sec | gh secret set SUPABASE_SERVICE_ROLE_KEY -R rileybleeker/Onyx
if ($LASTEXITCODE -ne 0) { Write-Warning 'gh secret set failed; set SUPABASE_SERVICE_ROLE_KEY in GitHub by hand.' }

# 4. the one place a script cannot reach
@"

Still to do by hand (Vercel has no CLI on this PC):
  Vercel -> project 'frontend' -> Settings -> Environment Variables (Production):
    SUPABASE_SERVICE_ROLE_KEY         -> the new secret key
    NEXT_PUBLIC_SUPABASE_ANON_KEY     -> the new publishable key
  then Deployments -> Redeploy.
Check afterwards: the next hourly 'Hourly Health ETL' run is green and /status shows fresh sources.
Only after a few clean days: disable the legacy keys in the Supabase dashboard (that step is not reversible).
"@
