Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $projectRoot ".runtime"
$pidFilePath = Join-Path $runtimeDir "ugcs-webapp-bridge.pids.json"

$stopped = New-Object System.Collections.Generic.List[string]
$alreadyStopped = New-Object System.Collections.Generic.List[string]

function Stop-ProcessSafe {
    param(
        [Parameter(Mandatory = $true)][int]$Pid,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $target = Get-Process -Id $Pid -ErrorAction SilentlyContinue
    if ($null -eq $target) {
        $alreadyStopped.Add("$Label (pid $Pid not running)") | Out-Null
        return
    }

    try {
        Stop-Process -Id $Pid -Force -ErrorAction Stop
        $stopped.Add("$Label (pid $Pid)") | Out-Null
    } catch {
        $alreadyStopped.Add("$Label (pid $Pid could not be stopped: $($_.Exception.Message))") | Out-Null
    }
}

if (Test-Path $pidFilePath) {
    try {
        $state = Get-Content $pidFilePath -Raw | ConvertFrom-Json

        if ($state.javaShellPid) {
            Stop-ProcessSafe -Pid ([int]$state.javaShellPid) -Label "Java service window"
        }
        if ($state.nodeShellPid) {
            Stop-ProcessSafe -Pid ([int]$state.nodeShellPid) -Label "Node service window"
        }
    } catch {
        Write-Host "Warning: Could not parse PID state file. Continuing with fallback scan..."
    }
}

# Fallback cleanup: terminate any lingering process started from this project.
$projectRootEscaped = [regex]::Escape($projectRoot)
$fallbackPatterns = @(
    "backend[\\/]+server\.js",
    "java-bridge[\\/]+pom\.xml.+exec:java",
    "scripts[\\/]+start-java-bridge\.ps1",
    "scripts[\\/]+start-node-backend\.ps1"
)

try {
    $allProcesses = Get-CimInstance Win32_Process -ErrorAction Stop
    $candidateList = @()
    foreach ($process in $allProcesses) {
        $commandLine = $process.CommandLine
        if (-not $commandLine) {
            continue
        }
        if ($commandLine -notmatch $projectRootEscaped) {
            continue
        }

        $matchesPattern = $false
        foreach ($pattern in $fallbackPatterns) {
            if ($commandLine -match $pattern) {
                $matchesPattern = $true
                break
            }
        }
        if ($matchesPattern -and $process.ProcessId -ne $PID) {
            $candidateList += $process
        }
    }

    foreach ($process in $candidateList) {
        Stop-ProcessSafe -Pid ([int]$process.ProcessId) -Label "Fallback matched process"
    }
} catch {
    Write-Host "Warning: Fallback process scan failed: $($_.Exception.Message)"
}

if (Test-Path $pidFilePath) {
    Remove-Item $pidFilePath -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($stopped.Count -gt 0) {
    Write-Host "Stopped process(es):"
    foreach ($entry in $stopped) {
        Write-Host "  - $entry"
    }
} else {
    Write-Host "No running service processes were found to stop."
}

if ($alreadyStopped.Count -gt 0) {
    Write-Host ""
    Write-Host "Additional info:"
    foreach ($entry in $alreadyStopped) {
        Write-Host "  - $entry"
    }
}

Write-Host ""
Write-Host "Stop-all complete."
