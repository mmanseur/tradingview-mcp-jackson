@echo off
REM Arrete uniquement le processus Claude Scanner lance par la tache planifiee
REM Cible : cmd.exe qui execute run_claude_scan.bat + tous ses enfants (claude.exe du scan)
REM Ne touche PAS aux autres sessions claude.exe (conversations en cours)

echo Recherche du processus run_claude_scan.bat...

REM Trouver le PID du cmd.exe qui a lance run_claude_scan.bat
for /f "tokens=1" %%P in (
    'wmic process where "commandline like '%%run_claude_scan%%'" get processid /value 2^>nul ^| find "ProcessId"'
) do (
    for /f "tokens=2 delims==" %%Q in ("%%P") do set SCAN_PID=%%Q
)

if not defined SCAN_PID (
    echo [INFO] Aucun scan en cours trouve.
    pause
    exit /b 0
)

echo [TROUVE] PID du scan : %SCAN_PID%
echo Arret du processus et de tous ses enfants (claude.exe du scan)...

taskkill /f /pid %SCAN_PID% /t

if %ERRORLEVEL% EQU 0 (
    echo [OK] Scan arrete proprement.
) else (
    echo [ERREUR] Impossible d'arreter le scan (exit %ERRORLEVEL%).
    echo Conseil : ouvre le Gestionnaire des taches et cherche cmd.exe ^> run_claude_scan.bat
)

pause
