# Registers the PRTS scheduled tasks (run once, by you). Both are only needed
# for the Claude Code narrator (PRTS_BACKEND / RP_BACKEND = claude-code or auto):
#   PRTS narrator watchdog every 5 min  -> windows\narrator-watchdog.ps1
#   PRTS daily restart     daily 05:00  -> windows\daily-restart.ps1
# Remove them later with: schtasks /Delete /TN "<name>" /F
$dir = $PSScriptRoot
$flags = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File'
schtasks.exe /Create /F /TN 'PRTS narrator watchdog' /SC MINUTE /MO 5 /TR "wscript.exe `"$dir\run-hidden.vbs`" `"$dir\narrator-watchdog.bat`""
schtasks.exe /Create /F /TN 'PRTS daily restart' /SC DAILY /ST 05:00 /TR "powershell.exe $flags `"$dir\daily-restart.ps1`""
schtasks.exe /Query /TN 'PRTS narrator watchdog'
schtasks.exe /Query /TN 'PRTS daily restart'
