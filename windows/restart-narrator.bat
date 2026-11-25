@echo off
rem Restarts the PRTS narrator now (same as the daily restart), but first saves
rem the chat to logs\chat-logs\ and logs\restart-handoff.md so the new session can pick it up.
rem Run it through run-hidden.vbs so it survives the narrator window closing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0save-chat-log.ps1"
timeout /t 5 /nobreak >nul
rem The restart kills the narrator's whole process tree, and this script is inside it
rem (the narrator started it). Start the restart outside the tree through WMI so it survives.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0daily-restart.ps1\"'} | Out-Null"
