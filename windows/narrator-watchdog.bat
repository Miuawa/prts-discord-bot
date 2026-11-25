@echo off
rem Runs the narrator watchdog with no flashing window (started through run-hidden.vbs).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0narrator-watchdog.ps1"
