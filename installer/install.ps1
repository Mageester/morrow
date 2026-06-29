# Morrow Early Access installer. Requires Windows 10+ x64 and PowerShell 5.1+.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell 5.1 defaults the console to a legacy OEM code page (437/850),
# which renders any UTF-8 output from this script or its child processes as
# mojibake (garbled box-drawing/punctuation). Force UTF-8 for both our output and child-process pipes so
# the installer reads cleanly on PowerShell 5.1 and 7 alike. Best-effort: a
# redirected or non-interactive host may reject the assignment, which is fine.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$BaseUrl = 'https://morrowproject.getaxiom.ca'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Morrow'
$ManifestUrl = "$BaseUrl/releases/latest.json"
# Stage outside the install root, with a unique name, so a failed run never
# leaves a half-written tree inside %LOCALAPPDATA%\Morrow and never collides
# with a concurrent or previous attempt.
$StagingId = [Guid]::NewGuid().ToString('N')
$Staging = Join-Path $env:TEMP "morrow-staging-$StagingId"
$Archive = Join-Path $env:TEMP "morrow-$StagingId.zip"

function Fail([string]$Message) { throw "Morrow installation failed: $Message" }

function Cleanup {
  Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
  # Sweep up staging/archive debris left by any earlier failed run.
  Get-ChildItem -LiteralPath $env:TEMP -Filter 'morrow-staging-*' -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $env:TEMP -Filter 'morrow-*.zip' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

# The required runtime files, relative to the package root. The installer never
# hard-codes a versioned directory name; it discovers the root by these files.
$RequiredFiles = @(
  'morrow.cmd',
  'morrow.mjs',
  'runtime\node.exe',
  'orchestrator\dist\src\index.js',
  'web\index.html'
)

# Resolve the package root inside the extracted staging tree. Supports both
# supported package shapes: files directly at the archive root, or nested under
# a single top-level directory. Returns the resolved path or $null.
function Resolve-PackageRoot([string]$root) {
  $candidates = @($root)
  $candidates += @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName })
  foreach ($candidate in $candidates) {
    $complete = $true
    foreach ($rel in $RequiredFiles) {
      if (-not (Test-Path -LiteralPath (Join-Path $candidate $rel))) { $complete = $false; break }
    }
    if ($complete) { return $candidate }
  }
  return $null
}

# Atomically activate a validated package into <Root>\app while preserving ALL
# user data (everything under <Root> except app/app.new/app.old) and keeping the
# previous working version in app.old until the new tree is in place and verified.
# Returns $true if a previous app existed (so the caller can roll back on a failed
# health check). Used by the normal install AND by the test hook below, so the
# integration suite exercises this exact activation + rollback code path.
function Invoke-MorrowActivation {
  param([Parameter(Mandatory)][string]$StagedPackage, [Parameter(Mandatory)][string]$Root)

  # User data lives under <Root>; only <Root>\app is replaced. Create the data
  # directories idempotently and never delete the root.
  New-Item -ItemType Directory -Path $Root -Force | Out-Null
  foreach ($name in 'data','config','logs','browser','cache','backup','bin') {
    New-Item -ItemType Directory -Path (Join-Path $Root $name) -Force | Out-Null
  }

  $installedApp = Join-Path $Root 'app'
  $appNew = Join-Path $Root 'app.new'
  $appOld = Join-Path $Root 'app.old'
  $installedCmd = Join-Path $installedApp 'morrow.cmd'

  # Clear app.new/app.old scratch dirs from a previous interrupted upgrade (code
  # only -- never user data).
  Remove-Item -LiteralPath $appNew -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $appOld -Recurse -Force -ErrorAction SilentlyContinue

  # Stage into a fresh app.new beside the live install, then validate BEFORE any
  # swap. The currently working `app` is untouched, so failure here cannot destroy
  # the previous version.
  Move-Item -LiteralPath $StagedPackage -Destination $appNew
  foreach ($rel in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $appNew $rel))) {
      Remove-Item -LiteralPath $appNew -Recurse -Force -ErrorAction SilentlyContinue
      Fail "Staged install is incomplete (missing app\$rel)."
    }
  }

  # Stop any running instance before swapping (a live node.exe/DLL locks the dir).
  # Best-effort: stopping is an optimization, so a failing/garbled launcher must
  # never abort the upgrade. Silence all streams and swallow errors; if a lock
  # genuinely remains, the rename below fails and rolls back cleanly.
  if (Test-Path -LiteralPath $installedCmd) {
    try { & $installedCmd stop *>$null } catch {}
  }

  # Activate via same-volume renames: previous app aside, promote app.new. Roll
  # back to the preserved version if the promotion throws.
  $hadPrevious = Test-Path -LiteralPath $installedApp
  try {
    if ($hadPrevious) { Move-Item -LiteralPath $installedApp -Destination $appOld }
    Move-Item -LiteralPath $appNew -Destination $installedApp
  } catch {
    if ((-not (Test-Path -LiteralPath $installedApp)) -and (Test-Path -LiteralPath $appOld)) {
      Move-Item -LiteralPath $appOld -Destination $installedApp -ErrorAction SilentlyContinue
    }
    Fail "Could not activate the new version; the previous installation is intact. ($_)"
  }

  Set-Content -LiteralPath (Join-Path $Root 'bin\morrow.cmd') -Value "@echo off`r`n`"%~dp0..\app\morrow.cmd`" %*`r`n" -NoNewline

  # Verify the activated tree; on any gap, roll back to the previous version.
  foreach ($rel in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $installedApp $rel))) {
      Remove-Item -LiteralPath $installedApp -Recurse -Force -ErrorAction SilentlyContinue
      if ($hadPrevious -and (Test-Path -LiteralPath $appOld)) {
        Move-Item -LiteralPath $appOld -Destination $installedApp -ErrorAction SilentlyContinue
      }
      Fail "Installation incomplete: app\$rel is missing after activation; previous version restored."
    }
  }

  return $hadPrevious
}

# Pure helper: merge the bin dir into a User PATH value without side effects.
# Returns the (possibly unchanged) PATH string. A $null/empty existing PATH is
# handled so we never call a method on $null, and an already-present bin entry is
# returned unchanged so re-running the installer never duplicates the entry.
function Get-MorrowMergedPath([string]$Existing, [string]$Bin) {
  if ($null -eq $Existing) { $Existing = '' }
  if ((@($Existing -split ';' | Where-Object { $_ }) -contains $Bin)) { return $Existing }
  return (($Existing.TrimEnd(';') + ';' + $Bin).TrimStart(';'))
}

# Test-only hooks. NEVER set by the irm|iex install path. Each runs a single
# pure/idempotent operation against caller-provided paths and exits, so the
# integration suite can drive real installer code with synthetic data, without
# network, launching, or mutating the real User PATH environment variable.
switch ($env:MORROW_TEST_HOOK) {
  'activate' {
    if (-not $env:MORROW_ACTIVATE_FROM -or -not $env:MORROW_ACTIVATE_ROOT) {
      Fail 'MORROW_TEST_HOOK=activate requires MORROW_ACTIVATE_FROM and MORROW_ACTIVATE_ROOT.'
    }
    [void](Invoke-MorrowActivation -StagedPackage $env:MORROW_ACTIVATE_FROM -Root $env:MORROW_ACTIVATE_ROOT)
    Write-Host 'Activation complete.'
    exit 0
  }
  'mergepath' {
    Get-MorrowMergedPath $env:MORROW_MERGEPATH_EXISTING $env:MORROW_MERGEPATH_BIN
    exit 0
  }
}

try {
  if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Morrow Early Access supports Windows x64 only.' }
  Cleanup  # Clear debris from any prior failed attempt before starting.

  Write-Host 'Morrow Early Access installer starting. Fetching the release manifest...'
  $manifest = Invoke-RestMethod -Uri $ManifestUrl -UseBasicParsing
  if ($manifest.schemaVersion -ne 1 -or $manifest.channel -ne 'beta') { Fail 'The release manifest is invalid.' }
  $artifact = @($manifest.artifacts | Where-Object { $_.platform -eq 'windows-x64' })[0]
  if ($null -eq $artifact -or -not $artifact.url -or -not $artifact.sha256) { Fail 'No Windows x64 release artifact is available.' }
  if ($artifact.sha256 -notmatch '^[a-fA-F0-9]{64}$') { Fail 'The artifact checksum is malformed.' }

  $sizeMb = [math]::Round($artifact.size / 1MB)
  Write-Host "Downloading Morrow $($manifest.version) ($($artifact.filename), ~$sizeMb MB). This can take several minutes and shows no progress bar -- please wait..."
  Invoke-WebRequest -Uri $artifact.url -OutFile $Archive -UseBasicParsing

  Write-Host 'Download complete. Verifying SHA-256 checksum...'
  $hash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $artifact.sha256.ToLowerInvariant()) { Fail "SHA256 mismatch. Expected $($artifact.sha256), got $hash." }

  Write-Host 'Checksum verified. Extracting archive...'
  New-Item -ItemType Directory -Path $Staging -Force | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $Staging -Force

  # Resolve and validate the runtime root BEFORE touching the existing install.
  $package = Resolve-PackageRoot $Staging
  if ($null -eq $package) {
    Fail 'The release archive layout is unrecognised: could not locate morrow.cmd, runtime\node.exe and the orchestrator entrypoint at the archive root or under a single top-level directory.'
  }
  foreach ($rel in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $package $rel))) { Fail "The release archive is incomplete (missing $rel)." }
  }

  Write-Host 'Package validated. Installing...'

  # Atomically activate the validated package, preserving all user data and the
  # previous working version until the new tree is in place (see the function).
  $hadPrevious = Invoke-MorrowActivation -StagedPackage $package -Root $InstallRoot
  $installedApp = Join-Path $InstallRoot 'app'
  $appOld = Join-Path $InstallRoot 'app.old'
  $installedCmd = Join-Path $installedApp 'morrow.cmd'

  # Add the bin shim to the User PATH (null-safe, no duplicate entries).
  $bin = Join-Path $InstallRoot 'bin'
  $existingPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $mergedPath = Get-MorrowMergedPath $existingPath $bin
  if ($mergedPath -ne $existingPath) {
    [Environment]::SetEnvironmentVariable('Path', $mergedPath, 'User')
  }
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startMenu 'Morrow.lnk'))
  $shortcut.TargetPath = $installedCmd
  $shortcut.WorkingDirectory = Join-Path $InstallRoot 'app'
  $shortcut.Description = 'Morrow AI Agent'
  $shortcut.Save()

  Write-Host 'Starting Morrow...'
  # The localhost health poll below is the real success gate. Wrap the launch so a
  # failing service that writes to stderr (which PowerShell turns into a
  # terminating NativeCommandError under ErrorActionPreference=Stop) cannot bypass
  # the health-check rollback by throwing straight to the outer catch.
  try { & $installedCmd start } catch {}
  $healthy = $false
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:4317/api/health' -UseBasicParsing).StatusCode -eq 200) { $healthy = $true; break } } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) {
    # Roll back to the previous working version (if any) rather than leaving the
    # user with a broken install. User data is untouched either way. The recovery
    # start/stop are best-effort (swallow native errors) so the rollback always
    # completes and reports honestly.
    if ($hadPrevious -and (Test-Path -LiteralPath $appOld)) {
      try { & $installedCmd stop *>$null } catch {}
      Remove-Item -LiteralPath $installedApp -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $appOld -Destination $installedApp -ErrorAction SilentlyContinue
      try { & (Join-Path $installedApp 'morrow.cmd') start *>$null } catch {}
      Fail 'The new version did not pass its health check; the previous version was restored and restarted. Run "morrow doctor" for details.'
    }
    Fail 'Morrow did not pass its localhost health check. Run "morrow doctor" for details.'
  }

  # Success: the new version is healthy. Discard the preserved previous version.
  Remove-Item -LiteralPath $appOld -Recurse -Force -ErrorAction SilentlyContinue
  Start-Process 'http://127.0.0.1:4317/onboarding'
  Write-Host "Morrow $($manifest.version) installed to $InstallRoot. It is an unsigned beta."
} catch {
  Cleanup
  Write-Error $_
  exit 1
} finally {
  Cleanup
}
