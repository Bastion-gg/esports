@echo off
cd /d "%~dp0"
node launcher.cjs --stop
if errorlevel 1 pause
