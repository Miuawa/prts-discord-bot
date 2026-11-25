@echo off
rem Closes the PRTS narrator (Claude Code) on purpose and tells the watchdog not to reopen it.
rem The Discord bot keeps running (instant commands, music). Use start-narrator.bat to start it again.
del "%~dp0..\logs\narrator.wanted" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*start-narrator.bat*' } | ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F | Out-Null }"
echo The narrator has been stopped. The watchdog will not reopen it.
timeout /t 3 >nul
