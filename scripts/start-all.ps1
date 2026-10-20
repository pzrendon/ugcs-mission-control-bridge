Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $projectRoot
$runtimeDir = Join-Path $projectRoot ".runtime"
$pidFilePath = Join-Path $runtimeDir "ugcs-webapp-bridge.pids.json"

. (Join-Path $PSScriptRoot "load-env.ps1")

if (-not (Import-ProjectDotEnv -ProjectRoot $projectRoot -CreateIfMissing)) {
    exit 1
}

function Assert-CommandExists {
    param([Parameter(Mandatory = $true)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found. Install it and try again."
    }
}

Assert-CommandExists -Name "java"
Assert-CommandExists -Name "mvn"
Assert-CommandExists -Name "node"
Assert-CommandExists -Name "npm"

Write-Host ""
Write-Host "=== UgCS WebApp Bridge startup ==="
Write-Host "Project root      : $projectRoot"
Write-Host "Node port         : $($env:NODE_PORT)"
Write-Host "Java bridge port  : $($env:UGCS_BRIDGE_PORT)"
Write-Host "UgCS target       : $($env:UGCS_HOST):$($env:UGCS_PORT)"
Write-Host "Java bridge URL   : $($env:JAVA_BRIDGE_URL)"
Write-Host ""

# Install Node dependencies if this is first run.
if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
    Write-Host "node_modules not found -> running npm install..."
    npm install
}

# Launch both services in separate terminal windows so logs stay visible.
$javaScript = Join-Path $PSScriptRoot "start-java-bridge.ps1"
$nodeScript = Join-Path $PSScriptRoot "start-node-backend.ps1"

$javaProcess = Start-Process powershell -PassThru -WorkingDirectory $projectRoot -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$javaScript`""
)

Start-Sleep -Seconds 2

$nodeProcess = Start-Process powershell -PassThru -WorkingDirectory $projectRoot -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$nodeScript`""
)

# Persist shell process IDs so stop-all script can stop everything cleanly.
if (-not (Test-Path $runtimeDir)) {
    New-Item -ItemType Directory -Path $runtimeDir | Out-Null
}

$pidState = [ordered]@{
    projectRoot = $projectRoot
    startedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    javaShellPid = $javaProcess.Id
    nodeShellPid = $nodeProcess.Id
}
$pidState | ConvertTo-Json | Set-Content -Path $pidFilePath -Encoding UTF8

Write-Host "Started Java bridge and Node backend in new windows."
Write-Host "Open this URL in browser: http://localhost:$($env:NODE_PORT)"
Write-Host "Tip: If browser does not open automatically, copy/paste the URL."
Write-Host "To stop both services later, run: scripts\stop-all.bat"

try {
    Start-Process "http://localhost:$($env:NODE_PORT)" | Out-Null
} catch {
    # Non-fatal: browser might not be available in some shell contexts.
}
