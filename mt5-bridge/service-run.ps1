# Vaelor MT5 bridge --- headless runner (no console window).
#
#   .\service-run.ps1            start the bridge in the background (hidden)
#   .\service-run.ps1 -Stop      stop it
#   .\service-run.ps1 -Status    show whether it is running
#
# The bridge is a normal uvicorn process; this wrapper starts it detached from
# any console so the PowerShell window can be closed. Output is appended to
# logs\bridge.log so the service keeps a full audit trail.
#
# The Windows counterpart (scheduled task) is installed by install-service.ps1.

param(
    [int]$Port = 8899,
    [switch]$Stop,
    [switch]$Status
)

Set-Location -Path $PSScriptRoot
$ErrorActionPreference = "Continue"

$python   = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$logDir   = Join-Path $PSScriptRoot "logs"
$logFile  = Join-Path $logDir "bridge.log"
$pidFile  = Join-Path $PSScriptRoot "data\bridge.pid"
$TaskName = "Vaelor MT5 Bridge"

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

# ------------------------------------------------------------------ helpers
function Test-BridgeAlive {
    try {
        $wc = New-Object System.Net.WebClient
        $wc.Proxy = $null
        $health = $wc.DownloadString("http://127.0.0.1:$Port/health") | ConvertFrom-Json
        return ($health.service -eq "vaelor-mt5-bridge")
    } catch {
        return $false
    }
}

function Get-BridgePid {
    if (Test-Path $pidFile) {
        $raw = (Get-Content $pidFile -Raw).Trim()
        if ($raw -match '^\d+$') {
            $p = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
            if ($p) { return [int]$raw }
        }
    }
    # Fall back to whoever owns the port.
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return $null
}

function Stop-Bridge {
    $procId = Get-BridgePid
    if (-not $procId) {
        Write-Host "  The bridge is not running." -ForegroundColor Yellow
        return
    }
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
    Write-Host "  Bridge stopped (pid $procId)." -ForegroundColor Green
}

function Start-Bridge {
    if (Test-BridgeAlive) {
        Write-Host "  A Vaelor bridge is already answering on port $Port --- nothing to do." -ForegroundColor Green
        return
    }
    if (-not (Test-Path $python)) {
        Write-Step "Preparing the environment (first run only)"
        & (Join-Path $PSScriptRoot "run.ps1") -Setup -Port $Port | Out-Null
    }
    if (-not (Test-Path $python)) {
        Write-Host "  Could not find .venv --- run .\run.cmd once to set it up." -ForegroundColor Red
        return
    }
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $env:BRIDGE_PORT = "$Port"
$hostBind = if ($env:BRIDGE_HOST) { $env:BRIDGE_HOST } else { "127.0.0.1" }

    # Start detached: no console, output goes to the log file.
    $proc = Start-Process -FilePath $python `
        -ArgumentList @("-m", "uvicorn", "app.api:app", "--host", $hostBind, "--port", "$Port", "--log-level", "info") `
        -WorkingDirectory $PSScriptRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError (Join-Path $logDir "bridge-error.log") `
        -PassThru
    Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii

    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        if (Test-BridgeAlive) {
            Write-Host "  Bridge running in the background (pid $($proc.Id)) on port $Port." -ForegroundColor Green
            Write-Host "  Log: $logFile"
            return
        }
        if ($proc.HasExited) { break }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "  The bridge did not answer on port $Port. Check logs\bridge-error.log" -ForegroundColor Red
    exit 1
}

# -------------------------------------------------------------------- run
if ($Status) {
    $alive = Test-BridgeAlive
    $procId = Get-BridgePid
    Write-Host ""
    Write-Host "  Vaelor MT5 bridge status" -ForegroundColor Yellow
    Write-Host "  ------------------------------------------------"
    Write-Host "  Running     : $alive"
    Write-Host "  URL         : http://127.0.0.1:$Port"
    Write-Host "  Process id  : $(if ($procId) { $procId } else { '---' })"
    Write-Host "  Log file    : $logFile"
    Write-Host "  Scheduled   : $(if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { 'installed' } else { 'not installed --- run .\install-service.ps1' })"
    Write-Host "  ------------------------------------------------"
    Write-Host ""
    exit 0
}

if ($Stop) {
    Stop-Bridge
    exit 0
}

Start-Bridge
exit 0
