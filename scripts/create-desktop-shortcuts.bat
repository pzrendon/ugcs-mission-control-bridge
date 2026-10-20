@echo off
REM Creates Desktop shortcuts for Start/Stop scripts.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-desktop-shortcuts.ps1"
