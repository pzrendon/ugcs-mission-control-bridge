@echo off
REM Stops Java bridge + Node backend started by start-all.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1"
