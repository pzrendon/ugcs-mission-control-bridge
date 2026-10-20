@echo off
REM Starts only the Java bridge service.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-java-bridge.ps1"
