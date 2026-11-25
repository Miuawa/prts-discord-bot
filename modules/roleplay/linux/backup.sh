#!/usr/bin/env bash
# Daily backup of the roleplay data that exists nowhere else. Keeps the newest 14.
# RP_KIT_DIR picks the kit (default <repo>/roleplay-kit),
# RP_BACKUP_DIR where backups go (default ~/PRTS-backups).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
KIT="${RP_KIT_DIR:-$ROOT/roleplay-kit}"
DEST="${RP_BACKUP_DIR:-$HOME/PRTS-backups}"
[ -d "$KIT" ] || { echo "No roleplay kit at $KIT, nothing to back up."; exit 0; }
mkdir -p "$DEST"
items=()
for i in story-log noncanon characters rp-channels.json CLAUDE.md; do
  [ -e "$KIT/$i" ] && items+=("$i")
done
[ ${#items[@]} -gt 0 ] || { echo "Nothing to back up in $KIT."; exit 0; }
OUT="$DEST/prts-$(date +%Y-%m-%d_%H%M).tar.gz"
tar -czf "$OUT" -C "$KIT" "${items[@]}"
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
ls -1t "$DEST"/prts-*.tar.gz | tail -n +15 | xargs -r rm -f
