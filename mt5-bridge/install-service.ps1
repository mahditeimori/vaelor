# Vaelor MT5 bridge --- optional hidden logon task (mainly for a cloud VPS).
#
#   .\install-service.ps1            install (starts hidden now)
#   .\install-service.ps1 -Uninstall remove the task and stop the bridge
#
# This registers ONE task that runs pythonw.exe at logon. There is no
# powershell.exe in the task, no one-minute repetition, no restart loop and no
# console window. On a normal desktop you do not need this at all: close
# run.cmd to disconnect, or use the website's kill switch.
#
# MetaTrader is NOT relaunched unless the .env file explicitly contains
# MT5_AUTO_CONNECT=1 (intended for a headless VPS).

param(
    [int]$Port = 8899,
    [switch]$Uninstall
)

Set-Location -Path $PSScriptRoot
$TaskName = "Vaelor MT5 Bridge"
$launcher = Join-Path $PSScriptRoot "start-bridge.py"
$pythonw  = Join-Path $PSScriptRoot ".venv\Scripts\pythonw.exe"
$stop     = Join-Path $PSScriptRoot "service-run.ps1"

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "  Scheduled task '$TaskName' removed." -ForegroundColor Green
    } else {
        Write-Host "  Scheduled task '$TaskName' was not installed." -ForegroundColor Yellow
    }
    if (Test-Path $stop) {
        & $stop -Stop -Port $Port | Out-Null
    }
    Write-Host "  The bridge was stopped. Nothing will restart it automatically."
    exit 0
}

# ----------------------------------------------------------------- install
if (-not (Test-Path $launcher)) {
    Write-Host "  start-bridge.py is missing --- run this script from the bridge folder." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $pythonw)) {
    Write-Host "  .venv\Scripts\pythonw.exe not found." -ForegroundColor Red
    Write-Host "  Run .\run.cmd once to create the environment, then retry." -ForegroundColor Yellow
    exit 1
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Step "Updating the existing task"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# pythonw.exe has no console at all; start-bridge.py writes the log itself.
$action = New-ScheduledTaskAction `
    -Execute $pythonw `
    -Argument "`"$launcher`"" `
    -WorkingDirectory $PSScriptRoot

# One quiet start at logon. No repetition, no PowerShell, no visible window.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -Hidden

Write-Step "Registering the scheduled task '$TaskName'"
Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger @($atLogon) `
    -Principal $principal -Settings $settings `
    -Description "Starts the Vaelor MT5 bridge hidden at logon (pythonw, no console, no repeating checks)." | Out-Null

Write-Step "Starting the bridge"
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4

$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host ""
Write-Host "  Vaelor MT5 bridge --- hidden logon task" -ForegroundColor Yellow
Write-Host "  ------------------------------------------------"
Write-Host "  Task         : $TaskName ($state)"
Write-Host "  URL          : http://127.0.0.1:$Port"
Write-Host "  Log          : $(Join-Path $PSScriptRoot 'logs\bridge.log')"
Write-Host "  ------------------------------------------------"
Write-Host ""
Write-Host "  The task starts one hidden pythonw process at logon."
Write-Host "  It does not run every minute and never opens a PowerShell window."
Write-Host ""
Write-Host "  Remove it completely with:"
Write-Host "    .\install-service.ps1 -Uninstall"
Write-Host ""
exit 0
