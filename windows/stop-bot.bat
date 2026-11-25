@echo off
rem Stops the hidden PRTS Discord bot (the restart loop first, then bun bot.ts).
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*start-bot.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'bun*' -and $_.CommandLine -like '*bot.ts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo PRTS bot stopped.
timeout /t 3 >nul
