param(
  [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
$App = $PSScriptRoot
$Install = Split-Path -Parent $App
$Bin = Join-Path $Install 'bin'
$StartMenuShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Morrow.lnk'
$DesktopShortcut = Join-Path $env:USERPROFILE 'Desktop\Morrow.lnk'

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
