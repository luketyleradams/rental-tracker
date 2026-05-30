@echo off
title Rental Tracker
setlocal enabledelayedexpansion
echo.
echo  Starting Rental Tracker...
echo.

cd /d "%~dp0"

:: ── 1. Find Node.js ──────────────────────────────────────────────────────────
:: Prefer local portable copy; accept system install only if version >= 18;
:: otherwise auto-download a portable copy (no admin required).

if exist "%~dp0runtime\node.exe" (
  set "PATH=%~dp0runtime;%PATH%"
  goto :have_node
)

where node >nul 2>&1
if %errorlevel% equ 0 (
  for /f %%v in ('node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2^>nul') do set "NODE_MAJOR=%%v"
  if defined NODE_MAJOR if !NODE_MAJOR! geq 18 goto :have_node
  echo  System Node.js is too old (need v18+^). Downloading a compatible version...
  echo.
)

:: ── 2. Auto-download portable Node.js (no admin required) ────────────────────
echo  Node.js not found. Downloading now (one-time, ~35 MB^)...
echo.

set "NODE_VER=22.16.0"
set "NODE_ZIP=%TEMP%\node-portable.zip"
set "NODE_EXTRACTED=%~dp0node-v%NODE_VER%-win-x64"
set "NODE_DEST=%~dp0runtime"

powershell -NoProfile -Command ^
  "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip' -OutFile '%NODE_ZIP%' -UseBasicParsing"
if %errorlevel% neq 0 (
  echo.
  echo  ERROR: Download failed. Check your internet connection and try again.
  pause
  exit /b 1
)

echo  Unpacking...
powershell -NoProfile -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%~dp0' -Force"
if exist "%NODE_DEST%" rmdir /s /q "%NODE_DEST%"
move "%NODE_EXTRACTED%" "%NODE_DEST%" >nul
del "%NODE_ZIP%" >nul 2>&1

if not exist "%NODE_DEST%\node.exe" (
  echo.
  echo  ERROR: Extraction failed. Please try again.
  pause
  exit /b 1
)

set "PATH=%NODE_DEST%;%PATH%"
echo  Node.js ready.
echo.

:: ── 3. Install / repair dependencies ─────────────────────────────────────────
:have_node

if exist "node_modules" (
  node -e "require('better-sqlite3')" >nul 2>&1
  if !errorlevel! neq 0 (
    echo  Rebuilding dependencies for this platform...
    echo.
    rmdir /s /q "node_modules"
  )
)

if not exist "node_modules" (
  echo  Installing dependencies. This takes about 30 seconds on the first run...
  echo.
  call npm install --omit=dev
  if !errorlevel! neq 0 (
    echo.
    echo  ERROR: npm install failed.
    echo.
    echo  Common causes:
    echo    - No internet connection. Connect and try again.
    echo    - Missing build tools for native modules.
    echo      Fix: run  runtime\install_tools.bat  then try again.
    pause
    exit /b 1
  )
  echo.
)

:: ── 4. Check port ─────────────────────────────────────────────────────────────
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo  Port 3000 is already in use. The app may already be running.
  echo  Opening browser...
  start "" "http://localhost:3000"
  echo.
  pause
  exit /b 0
)

:: ── 5. Start server and open browser ─────────────────────────────────────────
echo  Server starting...
echo.
echo  Leave this window open while using the app.
echo  Press Ctrl+C ^(or close this window^) to stop.
echo.

start /min cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

node server.js

echo.
echo  Server stopped. Press any key to close.
pause >nul
