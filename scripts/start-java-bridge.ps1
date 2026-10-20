Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $projectRoot

. (Join-Path $PSScriptRoot "load-env.ps1")

if (-not (Import-ProjectDotEnv -ProjectRoot $projectRoot -CreateIfMissing)) {
    exit 1
}

if (-not (Get-Command mvn -ErrorAction SilentlyContinue)) {
    throw "Maven (mvn) not found. Install Maven and try again."
}

Write-Host "Starting Java bridge..."
Write-Host "  UGCS host/port : $($env:UGCS_HOST):$($env:UGCS_PORT)"
Write-Host "  Bridge port    : $($env:UGCS_BRIDGE_PORT)"
Write-Host ""

mvn -f "$projectRoot\java-bridge\pom.xml" exec:java
