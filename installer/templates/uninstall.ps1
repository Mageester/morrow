param(
  [switch]$PurgeData,
  [switch]$KeepData,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
# Render cleanly on Windows PowerShell 5.1's legacy console code page.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$App = $PSScriptRoot
$Install = Split-Path -Parent $App
$Bin = Join-Path $Install 'bin'
$StartMenuShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Morrow.lnk'
$DesktopShortcut = Join-Path $env:USERPROFILE 'Desktop\Morrow.lnk'

# Decide whether to delete user data. Flags win; otherwise prompt the user with a
# clear, unambiguous "delete everything?" question (default No to stay safe).
if ($PurgeData -and $KeepData) {
  Write-Host 'Choose either -PurgeData or -KeepData, not both.' -ForegroundColor Red
  exit 2
}
if (-not $PurgeData -and -not $KeepData) {
  if ($Yes) {
    # Non-interactive default preserves data.
    $PurgeData = $false
  } else {
    Write-Host ''
    Write-Host 'Delete your data too?' -ForegroundColor Yellow
    Write-Host 'This permanently deletes ALL of your local Morrow data:'
    Write-Host '  - Conversations, memory, and the project database'
    Write-Host '  - Config and saved provider keys (API keys / OAuth sign-ins)'
    Write-Host '  - Backups, checkpoints, logs, and cache'
    Write-Host 'This cannot be undone. Choosing No keeps your data for a future reinstall.'
    $answer = Read-Host 'Delete EVERYTHING, including all of the above? [y/N]'
    $PurgeData = ($answer -match '^(y|yes)$')
  }
}

Write-Host 'Removing Morrow launcher and shortcuts...'
foreach ($shortcut in @($StartMenuShortcut, $DesktopShortcut)) {
  Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $parts = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $Bin.TrimEnd('\')) })
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
}

$targets = if ($PurgeData) {
  @($Install)
} else {
  @($App, $Bin)
}

$cleanup = Join-Path $env:TEMP ("morrow-uninstall-{0}.ps1" -f ([Guid]::NewGuid().ToString('N')))
$quotedTargets = ($targets | ForEach-Object { "'" + ($_.Replace("'", "''")) + "'" }) -join ', '
$body = @"
`$ErrorActionPreference = 'SilentlyContinue'
Start-Sleep -Seconds 2
`$appRoot = '$($App.Replace("'", "''"))'
Get-Process -Name node | Where-Object { `$_.Path -like "`$appRoot*" } | Stop-Process -Force
Start-Sleep -Seconds 1
foreach (`$target in @($quotedTargets)) {
  Remove-Item -LiteralPath `$target -Recurse -Force
}
Remove-Item -LiteralPath `$PSCommandPath -Force
"@
Set-Content -LiteralPath $cleanup -Value $body -Encoding UTF8
Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $cleanup) -WindowStyle Hidden

if ($PurgeData) {
  Write-Host "Morrow uninstall scheduled. Application files and local data will be removed from $Install after this command exits."
} else {
  Write-Host "Morrow uninstall scheduled. Application files will be removed after this command exits."
  Write-Host "User data is preserved under $Install. Reinstall Morrow to use it again, or run 'morrow uninstall --purge-data' before uninstalling to delete it."
}
