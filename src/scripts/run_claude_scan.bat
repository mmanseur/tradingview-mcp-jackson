@echo off
REM Routine Claude Code — Scanner V4 automatique 9h00 lun-ven
REM Lance Claude CLI en mode non-interactif avec le slash command /scan
REM Log dans logs\claude_scan_YYYY-MM-DD.log

setlocal
set REPO=D:\Claude\tradingview-mcp-jackson
REM Cherche claude.exe — d'abord le chemin complet, sinon PATH
set CLAUDE=C:\Users\mmans\.local\bin\claude.exe
if not exist "%CLAUDE%" set CLAUDE=claude
cd /d "%REPO%"

REM Date au format YYYY-MM-DD
for /f "tokens=1-3 delims=/-. " %%a in ('wmic os get localdatetime ^| find "."') do (
    set DATETIME=%%a
)
set LOGDATE=%DATETIME:~0,4%-%DATETIME:~4,2%-%DATETIME:~6,2%
set LOGFILE=%REPO%\logs\claude_scan_%LOGDATE%.log

echo ======================================== >> "%LOGFILE%"
echo [%DATE% %TIME%] Claude Scan demarrage >> "%LOGFILE%"
echo ======================================== >> "%LOGFILE%"

REM --- Preflight: verifier TradingView CDP 9222 ---
C:\nvm\nodejs\node.exe src\scripts\ensure_tv.js >> "%LOGFILE%" 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [%DATE% %TIME%] ECHEC preflight TradingView - scan annule >> "%LOGFILE%"
    exit /b 2
)

REM --- Lancer Claude Code en mode non-interactif ---
REM --print : mode batch, pas d'interface interactive
REM --dangerously-skip-permissions : approuve automatiquement les outils (Bash, MCP, etc.)
REM --max-turns 40 : plafond de tours pour eviter boucle infinie
"%CLAUDE%" ^
  --print "/scan" ^
  --dangerously-skip-permissions ^
  --max-turns 40 ^
  >> "%LOGFILE%" 2>&1

set EXIT_CODE=%ERRORLEVEL%
echo [%DATE% %TIME%] Claude Scan termine (exit %EXIT_CODE%) >> "%LOGFILE%"
echo. >> "%LOGFILE%"

exit /b %EXIT_CODE%
