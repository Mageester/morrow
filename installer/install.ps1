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
# Stage outside the install root, with a short unique name, so a failed run
# never leaves a half-written tree inside %LOCALAPPDATA%\Morrow and nested
# package dependencies keep enough Windows path-length headroom while extracting.
$StagingId = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$Staging = Join-Path $env:TEMP "mrw-s-$StagingId"
$Archive = Join-Path $env:TEMP "mrw-a-$StagingId.zip"

function Fail([string]$Message) { throw "Morrow installation failed: $Message" }

function Cleanup {
  Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
  # Sweep up staging/archive debris left by any earlier failed run.
  Get-ChildItem -LiteralPath $env:TEMP -Filter 'mrw-s-*' -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $env:TEMP -Filter 'mrw-a-*.zip' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $env:TEMP -Filter 'morrow-staging-*' -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $env:TEMP -Filter 'morrow-*.zip' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

# The required runtime files, relative to the package root. The installer never
# hard-codes a versioned directory name; it discovers the root by these files.
# Morrow is a CLI-only product. The package contains no web assets; the
# installer must never require or open a browser UI. The required files are
# the launcher, the dispatcher, the bundled runtime, and the orchestrator
# entrypoint -- the minimum set for a runnable terminal install.
$RequiredFiles = @(
  'morrow.cmd',
  'morrow.mjs',
  'dispatch.mjs',
  'runtime\node.exe',
  'orchestrator\dist\src\index.js'
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

function Test-MorrowAppTree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if (-not $item.PSIsContainer) { return $false }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  } catch {
    return $false
  }
  foreach ($rel in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $Path $rel))) { return $false }
  }
  return $true
}

function Remove-MorrowAppDirectory([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
  } catch {
    Fail "Could not remove $Description at $Path. Close Morrow, check for locked files or antivirus interference, then rerun the installer. ($_)"
  }
}

function Move-MorrowAppDirectory([string]$From, [string]$To, [string]$Description) {
  try {
    Move-Item -LiteralPath $From -Destination $To -ErrorAction Stop
  } catch {
    Fail "Could not $Description. Close Morrow, check for locked files or antivirus interference, then rerun the installer. ($_)"
  }
}

function Invoke-MorrowInstallRecovery {
  param([Parameter(Mandatory)][string]$Root)

  $installedApp = Join-Path $Root 'app'
  $appNew = Join-Path $Root 'app.new'
  $appOld = Join-Path $Root 'app.old'

  $appValid = Test-MorrowAppTree $installedApp
  $newValid = Test-MorrowAppTree $appNew
  $oldValid = Test-MorrowAppTree $appOld

  if ($appValid) {
    # A valid app is the known runnable version. Scratch dirs are safe to clear
    # before the next activation because the current app will become app.old.
    Remove-MorrowAppDirectory $appNew 'stale app.new'
    Remove-MorrowAppDirectory $appOld 'stale app.old'
    return
  }

  if ((Test-Path -LiteralPath $installedApp) -and (-not $appValid)) {
    Remove-MorrowAppDirectory $installedApp 'incomplete app'
  }

  if ($newValid) {
    # Crash after app.old was created and before/while app.new became app:
    # complete the promotion. Keep a valid app.old for later health rollback.
    Move-MorrowAppDirectory $appNew $installedApp 'promote the recovered app.new to app'
    if ((Test-Path -LiteralPath $appOld) -and (-not $oldValid)) {
      Remove-MorrowAppDirectory $appOld 'invalid app.old'
    }
    return
  }

  if ((Test-Path -LiteralPath $appNew) -and (-not $newValid)) {
    Remove-MorrowAppDirectory $appNew 'invalid app.new'
  }

  if ($oldValid) {
    Move-MorrowAppDirectory $appOld $installedApp 'restore the previous app.old to app'
    return
  }

  if ((Test-Path -LiteralPath $appOld) -and (-not $oldValid)) {
    Remove-MorrowAppDirectory $appOld 'invalid app.old'
  }
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

  # Recover any interrupted prior activation before staging a new package. This
  # is idempotent and never deletes the only complete app tree.
  Invoke-MorrowInstallRecovery -Root $Root

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
    if ($hadPrevious -and (Test-Path -LiteralPath $appOld)) {
      Remove-MorrowAppDirectory $appOld 'stale app.old'
    }
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
  # Compare entries case-insensitively and ignoring a trailing backslash, matching
  # the uninstaller, so `...\bin` and `...\bin\` are never treated as distinct.
  $needle = $Bin.TrimEnd('\')
  $present = @($Existing -split ';' | Where-Object { $_ } | Where-Object { $_.TrimEnd('\') -ieq $needle })
  if ($present.Count -gt 0) { return $Existing }
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
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Staging)

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
  # The health poll below is the real success gate. Wrap the launch so a
  # failing service that writes to stderr (which PowerShell turns into a
  # terminating NativeCommandError under ErrorActionPreference=Stop) cannot bypass
  # the health-check rollback by throwing straight to the outer catch.
  try { & $installedCmd start } catch {}
  $healthy = $false
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try {
      $healthResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:4317/api/health' -UseBasicParsing
      $healthProbe = $healthResponse.Content | ConvertFrom-Json
      if ($healthResponse.StatusCode -eq 200 -and $healthProbe.ok -eq $true -and $healthProbe.service -eq 'morrow-orchestrator' -and $healthProbe.apiVersion -eq 1) {
        $healthy = $true
        break
      }
    } catch {}
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
    Fail 'Morrow did not pass its health check. Run "morrow doctor" for details.'
  }

  # Success: the new version is healthy. Discard the preserved previous version.
  Remove-Item -LiteralPath $appOld -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host 'Morrow installed successfully.'
  Write-Host ''
  Write-Host 'Open a new PowerShell window and run:'
  Write-Host ''
  Write-Host '  morrow'
  Write-Host ''
  Write-Host "Morrow $($manifest.version) installed to $InstallRoot. It is an unsigned beta."
} catch {
  Cleanup
  Write-Error $_
  exit 1
} finally {
  Cleanup
}
