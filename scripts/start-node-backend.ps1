Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $projectRoot

. (Join-Path $PSScriptRoot "load-env.ps1")

if (-not (Import-ProjectDotEnv -ProjectRoot $projectRoot -CreateIfMissing)) {
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js (node) not found. Install Node.js and try again."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm not found. Reinstall Node.js/npm and try again."
}

if (-not (Test-Path "$projectRoot\node_modules")) {
    Write-Host "node_modules not found -> running npm install..."
    npm install
}

Write-Host "Starting Node backend..."
Write-Host "  Node port      : $($env:NODE_PORT)"
Write-Host "  Java bridge URL: $($env:JAVA_BRIDGE_URL)"
Write-Host ""

node "$projectRoot\backend\server.js"
