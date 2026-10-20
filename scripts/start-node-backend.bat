@echo off
REM Starts only the Node backend/frontend host.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-node-backend.ps1"
