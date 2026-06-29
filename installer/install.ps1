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

  # The application code lives in <InstallRoot>\app and is the ONLY thing an
  # upgrade replaces. The user's data (database, config, saved provider keys,
  # backups, logs, cache) lives in sibling directories -- the launcher points
  # MORROW_HOME at <InstallRoot>\data -- and must survive every upgrade. So we
  # create the data directories idempotently and never delete the install root.
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  foreach ($name in 'data','config','logs','browser','cache','backup','bin') {
    New-Item -ItemType Directory -Path (Join-Path $InstallRoot $name) -Force | Out-Null
  }

  $installedApp = Join-Path $InstallRoot 'app'
  $appNew = Join-Path $InstallRoot 'app.new'
  $appOld = Join-Path $InstallRoot 'app.old'
  $installedCmd = Join-Path $installedApp 'morrow.cmd'

  # Clear app.new/app.old scratch dirs left by a previous interrupted upgrade.
  # These are code-only staging/backup copies -- never user data -- so removing
  # them is safe. The user's data directories above are untouched.
  Remove-Item -LiteralPath $appNew -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $appOld -Recurse -Force -ErrorAction SilentlyContinue

  # Stage the validated package into a fresh app.new beside the live install.
  # This lands in a new directory; the currently working `app` is left intact,
  # so a failure here can never destroy the previous version.
  Move-Item -LiteralPath $package -Destination $appNew
  foreach ($rel in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $appNew $rel))) {
      Remove-Item -LiteralPath $appNew -Recurse -Force -ErrorAction SilentlyContinue
      Fail "Staged install is incomplete (missing app\$rel)."
    }
  }

  # Stop any running instance before swapping files (a live node.exe/DLL would
  # lock the directory and fail the rename).
  if (Test-Path -LiteralPath $installedCmd) { & $installedCmd stop 2>$null }

  # Activate: move the previous app aside, then promote app.new. Both renames are
  # same-volume (under $InstallRoot), so they are fast and the previous version
  # is preserved in app.old until the new one is proven healthy. Roll back to the
  # preserved version if activation fails.
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

  Set-Content -LiteralPath (Join-Path $InstallRoot 'bin\morrow.cmd') -Value "@echo off`r`n`"%~dp0..\app\morrow.cmd`" %*`r`n" -NoNewline

  # Verify the activated tree. On any gap, roll back to the previous version.
  foreach ($rel in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $installedApp $rel))) {
      Remove-Item -LiteralPath $installedApp -Recurse -Force -ErrorAction SilentlyContinue
      if ($hadPrevious -and (Test-Path -LiteralPath $appOld)) {
        Move-Item -LiteralPath $appOld -Destination $installedApp -ErrorAction SilentlyContinue
      }
      Fail "Installation incomplete: app\$rel is missing after activation; previous version restored."
    }
  }

  # A fresh user account can have no User-scoped Path (only a Machine Path), in
  # which case GetEnvironmentVariable returns $null. Default to '' so appending
  # the bin dir never calls a method on $null. Filter blanks so we compare
  # against real entries and never write an empty PATH segment.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $userPath) { $userPath = '' }
  $bin = Join-Path $InstallRoot 'bin'
  if ((@($userPath -split ';' | Where-Object { $_ }) -notcontains $bin)) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $bin).TrimStart(';')), 'User')
  }
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startMenu 'Morrow.lnk'))
  $shortcut.TargetPath = $installedCmd
  $shortcut.WorkingDirectory = Join-Path $InstallRoot 'app'
  $shortcut.Description = 'Morrow AI Agent'
  $shortcut.Save()

  Write-Host 'Starting Morrow...'
  & $installedCmd start
  $healthy = $false
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:4317/api/health' -UseBasicParsing).StatusCode -eq 200) { $healthy = $true; break } } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) {
    # Roll back to the previous working version (if any) rather than leaving the
    # user with a broken install. User data is untouched either way.
    if ($hadPrevious -and (Test-Path -LiteralPath $appOld)) {
      & $installedCmd stop 2>$null
      Remove-Item -LiteralPath $installedApp -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $appOld -Destination $installedApp -ErrorAction SilentlyContinue
      & (Join-Path $installedApp 'morrow.cmd') start 2>$null
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
