@echo off
REM Lance manuellement la tache ClaudeScanner9h maintenant

echo Lancement manuel de ClaudeScanner9h...
schtasks /run /tn "ClaudeScanner9h"

if %ERRORLEVEL% EQU 0 (
    echo [OK] Tache lancee. Consulte les logs :
    echo      logs\claude_scan_%DATE:~6,4%-%DATE:~3,2%-%DATE:~0,2%.log
) else (
    echo [ERREUR] Impossible de lancer la tache (exit %ERRORLEVEL%)
    echo Conseil : clic droit -> Executer en tant qu administrateur
)

pause
