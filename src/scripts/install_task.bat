@echo off
REM Installe la tache planifiee Windows pour le scanner V4
REM Execute: src\scripts\install_task.bat (dans cmd ou clic droit)

schtasks /create ^
  /tn "ClaudeScannerV4" ^
  /tr "D:\Claude\tradingview-mcp-jackson\src\scripts\run_scanner.bat" ^
  /sc weekly ^
  /d MON,TUE,WED,THU,FRI ^
  /st 08:30 ^
  /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [OK] Tache "ClaudeScannerV4" creee avec succes.
    echo      Prochaine execution: prochain jour ouvrable a 08:30
    echo.
    schtasks /query /tn "ClaudeScannerV4" /fo LIST
) else (
    echo.
    echo [ERREUR] Impossible de creer la tache ^(exit %ERRORLEVEL%^)
)
pause
