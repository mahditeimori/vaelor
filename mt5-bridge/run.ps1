# Vaelor MT5 bridge launcher (Windows PowerShell).
#
#   .\run.ps1              start on 127.0.0.1:8899
#   .\run.ps1 -Port 9000   start on a different port
#   .\run.ps1 -Setup       only create the venv, install deps and .env
#
# First run: creates .venv (Python 3.11 via uv), installs requirements,
# writes .env from .env.example, prints the pairing token.

param(
    [int]$Port = 8899,
    [switch]$Setup
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

if (-not (Test-Path $python)) {
    Write-Step "Creating Python 3.11 virtual environment"
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if ($uv) {
        & uv venv .venv --python 3.11
    } else {
        $py311 = Get-Command py -ErrorAction SilentlyContinue
        if (-not $py311) { throw "Python 3.11 is required. Install uv (https://docs.astral.sh/uv/) or Python 3.11." }
        & py -3.11 -m venv .venv
    }
    if (-not (Test-Path $python)) { throw "Could not create .venv" }
}

$needsInstall = $true
if (Test-Path (Join-Path $PSScriptRoot ".venv\.deps-ok")) { $needsInstall = $false }
if ($needsInstall) {
    Write-Step "Installing bridge dependencies"
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if ($uv) {
        & uv pip install --python $python -r requirements.txt
    } else {
        & $python -m pip install --upgrade pip
        & $python -m pip install -r requirements.txt
    }
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed" }
    New-Item -ItemType File -Path (Join-Path $PSScriptRoot ".venv\.deps-ok") -Force | Out-Null
}

if (-not (Test-Path (Join-Path $PSScriptRoot ".env"))) {
    Write-Step "Creating .env from .env.example"
    Copy-Item ".env.example" ".env"
    Write-Host "    Edit .env to point at your MT5 terminal and, for live trading, set ALLOW_LIVE_TRADES=1."
}

$env:BRIDGE_PORT = "$Port"
$token = (& $python -c "from app.config import SETTINGS; print(SETTINGS.token)").Trim()
$modeLine = (& $python -c "from app.config import SETTINGS; print(SETTINGS.mode)").Trim()

if ($Setup) {
    Write-Step "Setup complete"
    Write-Host "Bridge URL  : http://127.0.0.1:$Port"
    Write-Host "Bridge token: $token"
    Write-Host "Mode        : $modeLine"
    exit 0
}

Write-Host ""
Write-Host "  Vaelor MT5 bridge" -ForegroundColor Yellow
Write-Host "  ------------------------------------------------"
Write-Host "  URL        : http://127.0.0.1:$Port"
Write-Host "  Token      : $token"
Write-Host "  Mode       : $modeLine  (auto falls back to simulation)"
Write-Host "  Health     : http://127.0.0.1:$Port/health"
Write-Host "  Token file : $PSScriptRoot\data\bridge-token"
Write-Host "  ------------------------------------------------"
Write-Host "  Paste URL + token into the site's Execution page."
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

& $python -m uvicorn app.api:app --host 127.0.0.1 --port $Port --log-level info
