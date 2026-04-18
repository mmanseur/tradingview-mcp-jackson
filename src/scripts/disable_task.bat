@echo off
REM Desactivation de la tache planifiee ClaudeScanner9h

echo Desactivation de ClaudeScanner9h...
schtasks /change /tn "ClaudeScanner9h" /disable

if %ERRORLEVEL% EQU 0 (
    echo [OK] Tache desactivee avec succes
) else (
    echo [ERREUR] Tache introuvable.
)
pause
