$ErrorActionPreference = "Stop"
$Install = Split-Path -Parent $PSScriptRoot
$Shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Morrow.lnk"
if (Test-Path $Shortcut) { Remove-Item -Force $Shortcut }
[Environment]::SetEnvironmentVariable("Path", (($env:Path -split ';' | Where-Object { $_ -ne (Join-Path $Install 'bin') }) -join ';'), "User")
Write-Host "Morrow application files remain at $Install until this process exits. Remove them with: Remove-Item -Recurse -Force '$Install'"
