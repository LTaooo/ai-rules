@echo off
setlocal
where pwsh.exe >nul 2>&1
if errorlevel 1 (
    echo PowerShell 7 is required. Install it and add pwsh.exe to PATH.
    pause
    exit /b 1
)
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync.ps1" %*
set "SYNC_EXIT_CODE=%ERRORLEVEL%"
if not "%SYNC_EXIT_CODE%"=="0" echo Sync failed. See the error above.
pause
exit /b %SYNC_EXIT_CODE%
