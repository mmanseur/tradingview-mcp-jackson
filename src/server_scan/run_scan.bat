@echo off
:: ============================================================
:: run_scan.bat — Lanceur du scan IA TSX (Task Scheduler)
:: Exécuté automatiquement lundi-vendredi à 9h30
:: ============================================================

set SCRIPT_DIR=D:\Claude\tradingview-mcp-jackson\src\server_scan
set LOG_DIR=D:\Claude\tradingview-mcp-jackson\logs
set LOG_FILE=%LOG_DIR%\scan_%date:~-4,4%-%date:~-7,2%-%date:~0,2%.log

:: Créer le dossier logs si absent
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo [%date% %time%] Démarrage du scan IA TSX >> "%LOG_FILE%"

:: Vérifier que IB Gateway est accessible (port 4001)
python -c "import socket; s=socket.socket(); s.settimeout(3); r=s.connect_ex(('127.0.0.1',4001)); s.close(); exit(r)" 2>> "%LOG_FILE%"
if errorlevel 1 (
    echo [%date% %time%] ERREUR: IB Gateway non accessible sur port 4001 — scan annulé >> "%LOG_FILE%"
    exit /b 1
)

echo [%date% %time%] IB Gateway OK — lancement du scan >> "%LOG_FILE%"

:: Lancer le scan (stdout + stderr vers le fichier log)
python "%SCRIPT_DIR%\scan_server.py" >> "%LOG_FILE%" 2>&1
set EXIT_CODE=%errorlevel%

if %EXIT_CODE% == 0 (
    echo [%date% %time%] Scan terminé avec succès >> "%LOG_FILE%"
) else (
    echo [%date% %time%] Scan terminé avec erreur (code %EXIT_CODE%) >> "%LOG_FILE%"
)

:: Nettoyer les logs de plus de 30 jours
forfiles /p "%LOG_DIR%" /s /m *.log /d -30 /c "cmd /c del @path" 2>nul

exit /b %EXIT_CODE%
