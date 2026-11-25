# Restarts the PRTS narrator (Claude Code) if it died by itself (scheduled task
# "PRTS narrator watchdog", every 5 minutes).
# logs\narrator.wanted is created by start-narrator.bat and removed when Claude
# exits cleanly or stop-narrator.bat is used, so a narrator you closed
# on purpose stays closed. A crash, or closing the window with the X, leaves the
# file and the narrator is reopened. The Discord bot has its own restart loop.
$root = Split-Path -Parent $PSScriptRoot
$wanted = Join-Path $root 'logs\narrator.wanted'
if (-not (Test-Path $wanted)) { exit 0 }

$claude = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' -and $_.CommandLine -like '*--dangerously-load-development-channels*' }
if ($claude) { exit 0 }

# Skip right after the file was written: the narrator may still be starting
# (or the daily restart is between closing and reopening).
if (((Get-Date) - (Get-Item $wanted).LastWriteTime).TotalSeconds -lt 120) { exit 0 }

# Close a leftover start-narrator.bat window (waiting on "press any key"), then reopen.
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*start-narrator.bat*' } |
  ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
Start-Sleep -Seconds 3
Start-Process -FilePath (Join-Path $PSScriptRoot 'start-narrator.bat') -WorkingDirectory $root
