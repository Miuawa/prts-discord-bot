# Daily backup of the roleplay data that exists nowhere else (scheduled task
# "PRTS backup", 04:30). Zips the roleplay kit's story and note folders into
# PRTS-backups\prts-YYYY-MM-DD_HHmm.zip and keeps the newest 14.
# Set RP_BACKUP_DIR to put the backups somewhere else (another drive, a
# synced cloud folder). Default: <your user folder>\PRTS-backups.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$kit = if ($env:RP_KIT_DIR) { $env:RP_KIT_DIR } else { Join-Path $root 'roleplay-kit' }
if (-not (Test-Path $kit)) { Write-Output "No roleplay kit at $kit, nothing to back up."; exit 0 }
$dest = if ($env:RP_BACKUP_DIR) { $env:RP_BACKUP_DIR } else { Join-Path $env:USERPROFILE 'PRTS-backups' }
New-Item -ItemType Directory -Force $dest | Out-Null

$items = @(
  'story-log', 'noncanon', 'characters', 'rp-channels.json', 'CLAUDE.md'
) | ForEach-Object { Join-Path $kit $_ } | Where-Object { Test-Path $_ }

$zip = Join-Path $dest ("prts-{0:yyyy-MM-dd_HHmm}.zip" -f (Get-Date))
if (-not $items) { Write-Output 'Nothing to back up.'; exit 0 }
Compress-Archive -Path $items -DestinationPath $zip -CompressionLevel Optimal -Force
Write-Output "Backup written: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"

# Keep the newest 14 backups.
Get-ChildItem $dest -Filter 'prts-*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item -Force
