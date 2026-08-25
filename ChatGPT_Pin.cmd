@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title ChatGPT Pin

where npm.cmd >nul 2>nul
if errorlevel 1 goto npm_missing

echo [ChatGPT Pin] Starting a dedicated Codex window...
echo Keep this window open. Closing it stops the dedicated Pin instance.
echo Collection CLI progress and heartbeat messages will appear here.
echo.
call npm.cmd start
if errorlevel 1 goto launch_failed
exit /b 0

:npm_missing
echo [ChatGPT Pin] npm.cmd was not found.
echo Install Node.js 22.5 or newer, then try again.
pause
exit /b 1

:launch_failed
echo.
echo [ChatGPT Pin] Launch failed. Keep the error message above for diagnosis.
pause
exit /b 1
