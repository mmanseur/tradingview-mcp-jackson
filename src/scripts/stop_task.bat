@echo off
REM Desactive la tache planifiee ClaudeScanner9h (sans la supprimer)

echo Desactivation de ClaudeScanner9h...
schtasks /change /tn "ClaudeScanner9h" /disable

if %ERRORLEVEL% EQU 0 (
    echo [OK] Tache desactivee. Elle ne se lancera plus a 09:32.
    echo      Pour la reactiver : enable_task.bat
) else (
    echo [ERREUR] Tache introuvable ou deja desactivee.
)
pause
