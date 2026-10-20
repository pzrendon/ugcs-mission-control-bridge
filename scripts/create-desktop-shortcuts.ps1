Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Creates desktop shortcuts for one-click start/stop of this project.
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopPath = [Environment]::GetFolderPath("Desktop")

$startBat = Join-Path $projectRoot "scripts\start-all.bat"
$stopBat = Join-Path $projectRoot "scripts\stop-all.bat"

if (-not (Test-Path $startBat)) {
    throw "Start script not found at: $startBat"
}
if (-not (Test-Path $stopBat)) {
    throw "Stop script not found at: $stopBat"
}

$wshShell = New-Object -ComObject WScript.Shell

function New-DesktopShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    $shortcutPath = Join-Path $desktopPath "$Name.lnk"
    $shortcut = $wshShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $TargetPath
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = $Description
    $shortcut.WindowStyle = 1
    $shortcut.Save()

    return $shortcutPath
}

$startShortcut = New-DesktopShortcut `
    -Name "UgCS Bridge - Start" `
    -TargetPath $startBat `
    -Description "Start UgCS Java bridge and Node backend" `
    -WorkingDirectory $projectRoot

$stopShortcut = New-DesktopShortcut `
    -Name "UgCS Bridge - Stop" `
    -TargetPath $stopBat `
    -Description "Stop UgCS Java bridge and Node backend" `
    -WorkingDirectory $projectRoot

Write-Host "Desktop shortcuts created:"
Write-Host "  - $startShortcut"
Write-Host "  - $stopShortcut"
