@echo off
REM Affiche toutes les taches planifiees liees au scanner Claude

echo ========================================
echo  Taches planifiees — Claude Scanner
echo ========================================
echo.

schtasks /query /fo LIST /tn "ClaudeScanner9h" 2>nul
if %ERRORLEVEL% NEQ 0 echo [ABSENT] ClaudeScanner9h

echo.

schtasks /query /fo LIST /tn "ClaudeScannerV4" 2>nul
if %ERRORLEVEL% NEQ 0 echo [ABSENT] ClaudeScannerV4

echo.
echo ========================================
echo  Toutes les taches (liste complete)
echo ========================================
schtasks /query /fo TABLE

pause
