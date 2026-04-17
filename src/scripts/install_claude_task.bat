@echo off
REM Installe la tache planifiee Windows "ClaudeScanner9h"
REM Lance Claude Code en mode non-interactif chaque jour ouvrable a 9h32
REM Doit etre execute en tant qu'Administrateur

echo Installation de la tache planifiee ClaudeScanner9h...
echo.

schtasks /create ^
  /tn "ClaudeScanner9h" ^
  /tr "D:\Claude\tradingview-mcp-jackson\src\scripts\run_claude_scan.bat" ^
  /sc weekly ^
  /d MON,TUE,WED,THU,FRI ^
  /st 09:32 ^
  /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [OK] Tache "ClaudeScanner9h" creee avec succes.
    echo.
    echo Prochaine execution : prochain jour ouvrable a 09:00
    echo Logs              : D:\Claude\tradingview-mcp-jackson\logs\claude_scan_YYYY-MM-DD.log
    echo Rapport            : D:\Claude\tradingview-mcp-jackson\reports\scan_YYYY-MM-DD.md
    echo.
    schtasks /query /tn "ClaudeScanner9h" /fo LIST
) else (
    echo.
    echo [ERREUR] Impossible de creer la tache (exit %ERRORLEVEL%)
    echo.
    echo Conseil : clic droit sur install_claude_task.bat -> "Executer en tant qu administrateur"
)

echo.
pause
