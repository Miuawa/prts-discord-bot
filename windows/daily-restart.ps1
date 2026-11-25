# Daily fresh start for the PRTS narrator (scheduled task "PRTS daily restart", 05:00).
# Closes the narrator's Claude Code window and opens a new one, so the
# conversation (and its token cost per message) starts small again. Story
# notes on disk carry over. The Discord bot is a separate process and keeps
# running, so instant commands and music are not interrupted.
# Does nothing if the narrator isn't running (it was closed on purpose).
# Log: logs\daily-restart.log
. (Join-Path $PSScriptRoot 'console-input.ps1')
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'daily-restart.log'
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content $log }
$narrator = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*start-narrator.bat*' }
if (-not $narrator) { Log 'narrator not running, nothing to restart'; exit 0 }
# Ask Claude Code to exit by itself first (/exit), so its Remote Control session is
# closed properly on the phone/web side. A hard kill leaves a stale session listed.
# Typed straight into its console, so it works with nobody at the PC.
$claude = Get-NarratorProcess
if ($claude) {
  try { Send-NarratorText ([uint32]$claude.ProcessId) "/exit"; Start-Sleep -Milliseconds 600; Send-NarratorText ([uint32]$claude.ProcessId) "`r" } catch { Log "could not type /exit: $_" }
  for ($i = 0; $i -lt 20 -and (Get-NarratorProcess); $i++) { Start-Sleep -Seconds 1 }
}
# Then close what is left of the window (and force-kill claude if /exit did not work).
foreach ($p in $narrator) { taskkill.exe /PID $p.ProcessId /T /F | Out-Null }
Start-Sleep -Seconds 5
# Opening the new window sometimes fails with cmd.exe error 0xc0000142, so check that Claude Code really started and retry if not.
for ($try = 1; $try -le 4; $try++) {
  Start-Process -FilePath (Join-Path $PSScriptRoot 'start-narrator.bat') -WorkingDirectory $root
  for ($i = 0; $i -lt 45 -and -not (Get-NarratorProcess); $i++) { Start-Sleep -Seconds 2 }
  if (Get-NarratorProcess) { Log "narrator restarted (try $try)"; exit 0 }
  Log "narrator did not start (try $try), retrying"
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*start-narrator.bat*' } |
    ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
  Start-Sleep -Seconds 20
}
Log 'narrator failed to start after 4 tries; the watchdog will keep trying every 5 minutes'
