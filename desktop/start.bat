@echo off
setlocal
title Star Code Desktop
cd /d "%~dp0"

echo.
echo   =========================================
echo    Star Code Desktop - local agentic UI
echo    (the same agent ships as Star Code CLI)
echo   =========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   [!] Node.js was not found on your PATH.
    echo       Install it from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)

rem ---- desktop app (Electron) if it is installed -------------------------
if exist "node_modules\electron\dist\electron.exe" (
    echo   Launching the desktop app...
    echo.
    start "" "node_modules\electron\dist\electron.exe" .
    exit /b 0
)

rem ---- otherwise fall back to the browser version ------------------------
echo   Electron is not installed, so this runs in your browser.
echo   For the native desktop window, run:   npm install   then this file again.
echo.
echo   Working directory: %CD%
echo   Starting server...
echo.

start "" http://localhost:4180
node server.js

echo.
echo   Server stopped.
pause
