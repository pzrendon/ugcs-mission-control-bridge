@echo off
REM Beginner-friendly launcher:
REM - Loads .env
REM - Starts Java + Node in separate windows
REM - Opens browser

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
