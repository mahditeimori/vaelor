# Vaelor MT5 bridge launcher (Windows PowerShell).
#
#   .\run.ps1              start on 127.0.0.1:8899
#   .\run.ps1 -Port 9000   start on a different port
#   .\run.ps1 -Setup       only create the venv, install deps and .env
#
# First run: creates .venv (Python 3.11+ via uv or the py launcher), installs
# requirements, writes .env from .env.example, prints the pairing token.
# Every failure path prints a clear message and exits non-zero; run.cmd keeps
# the console window open so the message can be read.

param(
    [int]$Port = 8899,
    [switch]$Setup
)

Set-Location -Path $PSScriptRoot

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

function Fail($lines) {
    Write-Host ""
    foreach ($line in @($lines)) { Write-Host "  $line" -ForegroundColor Red }
    Write-Host ""
    exit 1
}

# ---------------------------------------------------------------- port check
# Fail fast with an explanation instead of letting uvicorn die with a raw
# traceback the user cannot act on.
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host ""
    Write-Host "  Port $Port is already in use." -ForegroundColor Yellow
    Write-Host "  If the bridge is already running, there is nothing to do: open the"
    Write-Host "  Vaelor Execution page and pair with http://127.0.0.1:$Port - the"
    Write-Host "  token is in data\bridge-token."
    Write-Host "  Otherwise start on another port:"
    Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1 -Port 8900"
    Write-Host ""
    exit 1
}

# ------------------------------------------------------------------- venv
if (-not (Test-Path $python)) {
    Write-Step "Creating a Python 3.11+ virtual environment (this can take a minute)"
    $created = $false
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if ($uv) {
        & uv venv .venv --python 3.11
        if ($LASTEXITCODE -eq 0 -and (Test-Path $python)) { $created = $true }
        if (-not $created) {
            # uv is present but cannot find 3.11; let it pick the best Python it has.
            & uv venv .venv
            if ($LASTEXITCODE -eq 0 -and (Test-Path $python)) { $created = $true }
        }
    }
    if (-not $created) {
        $py = Get-Command py -ErrorAction SilentlyContinue
        if ($py) {
            foreach ($spec in @("-3.11", "-3.12", "-3.13", "-3")) {
                & py $spec -m venv .venv
                if ($LASTEXITCODE -eq 0 -and (Test-Path $python)) { $created = $true; break }
            }
        }
    }
    if (-not $created) {
        $pyExe = Get-Command python -ErrorAction SilentlyContinue
        if ($pyExe) {
            & python -m venv .venv
            if ($LASTEXITCODE -eq 0 -and (Test-Path $python)) { $created = $true }
        }
    }
    if (-not $created) {
        Fail @(
            "Could not create a Python 3.11+ virtual environment.",
            "No suitable Python was found on this computer.",
            "",
            "Fix: install Python 3.11 or newer from https://www.python.org/downloads/",
            "and tick 'Add python.exe to PATH' in the installer, then run run.cmd again.",
            "Alternatively install uv: https://docs.astral.sh/uv/getting-started/installation/"
        )
    }
    $ver = (& $python -c "import sys; print('%d.%d' % sys.version_info[:2])")
    Write-Host "    Python $ver ready in .venv"
}

# ------------------------------------------------------------------- deps
$needsInstall = $true
if (Test-Path (Join-Path $PSScriptRoot ".venv\.deps-ok")) { $needsInstall = $false }
if ($needsInstall) {
    Write-Step "Installing bridge dependencies (needs internet once, can take a few minutes)"
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if ($uv) {
        & uv pip install --python $python -r requirements.txt
    } else {
        & $python -m pip install --upgrade pip
        & $python -m pip install -r requirements.txt
    }
    if ($LASTEXITCODE -ne 0) {
        Fail @(
            "Dependency installation failed (exit code $LASTEXITCODE).",
            "Check your internet connection and run run.cmd again.",
            "To see the full error, run manually:",
            "  .venv\Scripts\python.exe -m pip install -r requirements.txt"
        )
    }
    New-Item -ItemType File -Path (Join-Path $PSScriptRoot ".venv\.deps-ok") -Force | Out-Null
    Write-Host "    Dependencies installed."
}

# ------------------------------------------------------------------- .env
if (-not (Test-Path (Join-Path $PSScriptRoot ".env"))) {
    Write-Step "Creating .env from .env.example"
    Copy-Item ".env.example" ".env"
    Write-Host "    Edit .env to point at your MT5 terminal and, for live trading, set ALLOW_LIVE_TRADES=1."
}

# ------------------------------------------------------------------- config
$env:BRIDGE_PORT = "$Port"

function Read-Setting($expr) {
    # Runs one python -c expression; on failure prints the traceback tail and exits.
    $out = & $python -c $expr 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) {
        Fail (@("The bridge configuration failed to load. Python said:") + ($out | Select-Object -Last 5))
    }
    return ($out | Select-Object -Last 1).Trim()
}

$token = Read-Setting "from app.config import SETTINGS; print(SETTINGS.token)"
$modeLine = Read-Setting "from app.config import SETTINGS; print(SETTINGS.mode)"

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
Write-Host "  Keep this window open while you trade. Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

# ------------------------------------------------------------------- server
& $python -m uvicorn app.api:app --host 127.0.0.1 --port $Port --log-level info
$code = $LASTEXITCODE
# 0xC000013A (-1073741510) = the user closed the console / pressed Ctrl+C.
if ($code -ne 0 -and $code -ne -1073741510) {
    Fail @(
        "The bridge server stopped unexpectedly (exit code $code).",
        "The Python error above explains why. Common causes:",
        "  - another program owns port $Port (start on another port, see run.cmd)",
        "  - a broken .venv - delete the .venv folder and run run.cmd again"
    )
}
exit 0
