@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js is required. Install Node.js LTS, then open this file again.
 pause
 exit /b 1
)
node launcher.cjs
if errorlevel 1 pause
