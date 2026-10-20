Set-StrictMode -Version Latest

function Import-ProjectDotEnv {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,

        [switch]$CreateIfMissing
    )

    $envPath = Join-Path $ProjectRoot ".env"
    $examplePath = Join-Path $ProjectRoot ".env.example"

    if (-not (Test-Path $envPath)) {
        if ($CreateIfMissing -and (Test-Path $examplePath)) {
            Copy-Item $examplePath $envPath -Force
            Write-Host "Created .env from .env.example at: $envPath"
            Write-Host "Please edit .env (especially UGCS_LOGIN and UGCS_PASSWORD), then run again."
            return $false
        }

        Write-Host "Missing .env file at $envPath"
        Write-Host "Create one from .env.example and run again."
        return $false
    }

    Get-Content $envPath | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line)) { return }
        if ($line.StartsWith("#")) { return }

        $parts = $line.Split("=", 2)
        if ($parts.Count -ne 2) { return }

        $name = $parts[0].Trim()
        $value = $parts[1].Trim()

        # Remove surrounding single or double quotes if present.
        if (
            (($value.StartsWith('"')) -and ($value.EndsWith('"'))) -or
            (($value.StartsWith("'")) -and ($value.EndsWith("'")))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        Set-Item -Path "Env:$name" -Value $value
    }

    # Set reasonable defaults so first run is easier.
    if (-not $env:UGCS_BRIDGE_PORT) { $env:UGCS_BRIDGE_PORT = "8090" }
    if (-not $env:UGCS_HOST) { $env:UGCS_HOST = "127.0.0.1" }
    if (-not $env:UGCS_PORT) { $env:UGCS_PORT = "3334" }
    if (-not $env:NODE_PORT) { $env:NODE_PORT = "3000" }
    if (-not $env:JAVA_BRIDGE_URL) { $env:JAVA_BRIDGE_URL = "http://127.0.0.1:$($env:UGCS_BRIDGE_PORT)" }

    return $true
}
