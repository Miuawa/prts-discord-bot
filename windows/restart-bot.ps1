# Restarts the PRTS Discord bot (src\bot.ts) only; the narrator keeps running.
# Stops the restart loop (start-bot.bat) and the bun bot.ts process, then starts the bot hidden again.
$root = Split-Path -Parent $PSScriptRoot
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*start-bot.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'bun*' -and $_.CommandLine -like '*bot.ts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
wscript.exe "$PSScriptRoot\run-hidden.vbs" "$PSScriptRoot\start-bot.bat"
Start-Sleep -Seconds 15
Get-Content "$root\logs\bot.log" -TotalCount 6
