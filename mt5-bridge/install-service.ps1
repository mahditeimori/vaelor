# Vaelor MT5 bridge --- install the background service.
#
# Registers a Windows scheduled task that keeps the bridge running with no
# console window:
#   * starts at every logon,
#   * repeats every 5 minutes (restarts the bridge if it ever dies),
#   * restarts on failure,
#   * never starts a second instance while one is running.
#
#   .\install-service.ps1            install (and start)
#   .\install-service.ps1 -Uninstall remove the task
#
# The task runs in YOUR user session, so MetaTrader 5 launches and trades as
# the account owner. Closing the terminal or this browser does not stop it:
# the bridge relaunches terminal64.exe and logs the account back in.

param(
    [int]$Port = 8899,
    [switch]$Uninstall
)

Set-Location -Path $PSScriptRoot
$TaskName = "Vaelor MT5 Bridge"
$runner   = Join-Path $PSScriptRoot "service-run.ps1"

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
    Write-Host "  The bridge itself is still running --- stop it with:"
    Write-Host "    .\service-run.ps1 -Stop"
    exit 0
}

# ----------------------------------------------------------------- install
if (-not (Test-Path $runner)) {
    Write-Host "  service-run.ps1 is missing --- run this script from the bridge folder." -ForegroundColor Red
    exit 1
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Step "Updating the existing task"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Port $Port"

# 1 -- start at every logon
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# 2 -- safety net: check every 5 minutes, forever (restarts a dead bridge)
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances Ignore `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Write-Step "Registering the scheduled task '$TaskName'"
Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger @($atLogOn, $every5) `
    -Principal $principal -Settings $settings `
    -Description "Keeps the Vaelor MT5 bridge running in the background so the desk can trade without a console window." | Out-Null

Write-Step "Starting the bridge"
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4

$state = (Get-ScheduledTask -TaskName $TaskName).State
$info = Get-ScheduledTaskInfo -TaskName $TaskName
$lastResult = '0x{0:X}' -f $info.LastTaskResult

Write-Host ""
Write-Host "  Vaelor MT5 bridge --- background service" -ForegroundColor Yellow
Write-Host "  ------------------------------------------------"
Write-Host "  Task         : $TaskName ($state)"
Write-Host "  Last result  : $lastResult  (0x0 = running fine)"
Write-Host "  URL          : http://127.0.0.1:$Port"
Write-Host "  Log          : $(Join-Path $PSScriptRoot 'logs\bridge.log')"
Write-Host "  ------------------------------------------------"
Write-Host ""
Write-Host "  From now on you can close this window, close the website and even"
Write-Host "  close MetaTrader 5 --- the bridge relaunches the terminal and keeps"
Write-Host "  the desk running."
Write-Host ""
Write-Host "  Manage it with:"
Write-Host "    .\service-run.ps1 -Status     status"
Write-Host "    .\service-run.ps1 -Stop       stop the bridge"
Write-Host "    .\install-service.ps1 -Uninstall   remove the service"
Write-Host ""
exit 0
