@echo off
REM Reactive la tache planifiee ClaudeScanner9h

echo Activation de ClaudeScanner9h...
schtasks /change /tn "ClaudeScanner9h" /enable

if %ERRORLEVEL% EQU 0 (
    echo [OK] Tache reactivee. Prochaine execution : prochain jour ouvrable a 09:32.
) else (
    echo [ERREUR] Tache introuvable.
)
pause
