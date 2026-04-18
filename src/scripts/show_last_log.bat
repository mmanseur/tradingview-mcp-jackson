@echo off
REM Affiche le dernier log du Claude Scanner

for /f "tokens=1-3 delims=/-. " %%a in ('wmic os get localdatetime ^| find "."') do set DATETIME=%%a
set TODAY=%DATETIME:~0,4%-%DATETIME:~4,2%-%DATETIME:~6,2%
set LOGFILE=D:\Claude\tradingview-mcp-jackson\logs\claude_scan_%TODAY%.log

if exist "%LOGFILE%" (
    echo === Log du %TODAY% ===
    type "%LOGFILE%"
) else (
    echo Aucun log trouve pour aujourd'hui (%TODAY%).
    echo Logs disponibles :
    dir /b D:\Claude\tradingview-mcp-jackson\logs\claude_scan_*.log
)
pause
