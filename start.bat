@echo off
title Rental Tracker
setlocal enabledelayedexpansion
echo.
echo  Starting Rental Tracker...
echo.

cd /d "%~dp0"
set "APP=%~dp0app"
set "RUNTIME=%~dp0runtime"

:: ── 1. Find Node.js ──────────────────────────────────────────────────────────
if exist "%RUNTIME%\node.exe" (
  if exist "%RUNTIME%\node_modules\npm\bin\npm-cli.js" (
    set "PATH=%RUNTIME%;%PATH%"
    goto :have_node
  )
  echo  Bundled npm is missing. Re-downloading complete Node.js...
  echo.
  rmdir /s /q "%RUNTIME%"
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
if exist "%RUNTIME%" rmdir /s /q "%RUNTIME%"
move "%NODE_EXTRACTED%" "%RUNTIME%" >nul
del "%NODE_ZIP%" >nul 2>&1

if not exist "%RUNTIME%\node.exe" (
  echo.
  echo  ERROR: Extraction failed. Please try again.
  pause
  exit /b 1
)

set "PATH=%RUNTIME%;%PATH%"
echo  Node.js ready.
echo.

:: ── 3. Auto-update ────────────────────────────────────────────────────────────
:have_node

node "%APP%\updater.js"
if !errorlevel! equ 42 (
  echo  Refreshing dependencies after update...
  echo.
  if exist "%APP%\node_modules" rmdir /s /q "%APP%\node_modules"
)

:: ── 4. Install / repair dependencies ─────────────────────────────────────────
if exist "%APP%\node_modules" (
  node -e "require(process.env.APP+'/node_modules/better-sqlite3')" >nul 2>&1
  if !errorlevel! neq 0 (
    echo  Rebuilding dependencies for this platform...
    echo.
    rmdir /s /q "%APP%\node_modules"
  )
)

if not exist "%APP%\node_modules" (
  echo  Installing dependencies. This takes about 30 seconds on the first run...
  echo.
  pushd "%APP%" && call npm install --omit=dev && popd
  if !errorlevel! neq 0 (
    if exist "%APP%\node_modules" rmdir /s /q "%APP%\node_modules"
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

:: ── 5. Check port ─────────────────────────────────────────────────────────────
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo  Port 3000 is already in use. The app may already be running.
  echo  Opening browser...
  start "" "http://localhost:3000"
  echo.
  pause
  exit /b 0
)

:: ── 6. Start server and open browser ─────────────────────────────────────────
echo  Server starting...
echo.
echo  Leave this window open while using the app.
echo  Press Ctrl+C ^(or close this window^) to stop.
echo.

start /min cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

node "%APP%\server.js" <nul

echo.
echo  Server stopped. Press any key to close.
pause >nul
