@echo off
REM Wrapper pour Windows Task Scheduler — lance le scanner V4
REM Logs horodates dans logs/scan_YYYY-MM-DD.log

setlocal
set REPO=D:\Claude\tradingview-mcp-jackson
cd /d "%REPO%"

REM Date au format YYYY-MM-DD (FR / CA)
for /f "tokens=1-3 delims=/-. " %%a in ('wmic os get localdatetime ^| find "."') do (
    set DATETIME=%%a
)
set LOGDATE=%DATETIME:~0,4%-%DATETIME:~4,2%-%DATETIME:~6,2%
set LOGFILE=%REPO%\logs\scan_%LOGDATE%.log

echo ======================================== >> "%LOGFILE%"
echo [%DATE% %TIME%] Scanner V4 demarrage >> "%LOGFILE%"
echo ======================================== >> "%LOGFILE%"

REM --- Preflight: s'assurer que TradingView tourne avec CDP 9222 ---
C:\nvm\nodejs\node.exe src\scripts\ensure_tv.js >> "%LOGFILE%" 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [%DATE% %TIME%] ECHEC preflight TradingView - scan annule >> "%LOGFILE%"
    exit /b 2
)

REM --- Scan principal ---
C:\nvm\nodejs\node.exe src\scripts\scanner_v4.js >> "%LOGFILE%" 2>&1

echo [%DATE% %TIME%] Scanner V4 termine (exit %ERRORLEVEL%) >> "%LOGFILE%"
echo. >> "%LOGFILE%"

exit /b %ERRORLEVEL%
