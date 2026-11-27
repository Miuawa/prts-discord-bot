#!/usr/bin/env bash
# Nightly backup of the PRTS bot's settings and saved data (prts-backup.timer).
#
#   linux/backup.sh            write one backup now
#   linux/backup.sh --list     list the backups and the files in the newest one
#
# What goes in (only what exists):
#   <repo>/.env                    bot settings
#   <repo>/cache/                  reminders, music history, saved links, roleplay
#                                  players, announce channels, AI history (not the
#                                  game data tables, which download again)
#   $DISCORD_STATE_DIR (default ~/.claude/channels/discord/): token .env,
#                                  access.json (allowlist), bridge.key (not inbox/,
#                                  the Discord attachments)
#   ~/.config/prts-control/        PRTS Control's service list
#   PRTS_BACKUP_EXTRA              more files or folders, space-separated
# Not included: the code (it is in git), node_modules, logs, pulled data
# (data/, story cache) and the roleplay kit (modules/roleplay has its own backup).
#
# The archives hold your bot token and keys, so they are private: the folder is
# mode 700 and each file 600, they stay on this computer and are never in git.
# Settings (in .env or the environment):
#   PRTS_BACKUP_DIR            where backups go (default ~/PRTS-backups/bot)
#   PRTS_BACKUP_KEEP           how many to keep (default 7)
#   PRTS_BACKUP_GPG_RECIPIENT  optional: encrypt each backup to this gpg key
#                              (a key id or email of a public key in your keyring)
# The result of the last run is written to $XDG_STATE_HOME/prts/backup.json
# (default ~/.local/state/prts/backup.json) for PRTS Control.
#
# Restore: stop the bot, then extract over the same paths:
#   systemctl --user stop prts-bot.service
#   tar --zstd -xpf ~/PRTS-backups/bot/prts-bot-<date>.tar.zst -C /
#   (encrypted: gpg -d <file>.tar.zst.gpg | tar --zstd -xpf - -C /)
#   systemctl --user start prts-bot.service
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Settings from .env when they are not in the environment already.
env_get() { [ -f "$ROOT/.env" ] && sed -n "s/^$1=//p" "$ROOT/.env" | tail -1 | sed 's/^"\(.*\)"$/\1/'; true; }
expand() { case "$1" in "~"|"~/"*) printf '%s' "$HOME${1#\~}" ;; *) printf '%s' "$1" ;; esac; }
DEST="$(expand "${PRTS_BACKUP_DIR:-$(env_get PRTS_BACKUP_DIR)}")"
DEST="${DEST:-$HOME/PRTS-backups/bot}"
KEEP="${PRTS_BACKUP_KEEP:-$(env_get PRTS_BACKUP_KEEP)}"
KEEP="${KEEP:-7}"
RECIPIENT="${PRTS_BACKUP_GPG_RECIPIENT:-$(env_get PRTS_BACKUP_GPG_RECIPIENT)}"
EXTRA="${PRTS_BACKUP_EXTRA:-$(env_get PRTS_BACKUP_EXTRA)}"
STATE_DIR="$(expand "${DISCORD_STATE_DIR:-$(env_get DISCORD_STATE_DIR)}")"
STATE_DIR="${STATE_DIR:-$HOME/.claude/channels/discord}"
STATUS_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/prts"
STATUS="$STATUS_DIR/backup.json"
case "$KEEP" in ''|*[!0-9]*|0) echo "PRTS_BACKUP_KEEP must be a number above 0 (got '$KEEP')" >&2; exit 2 ;; esac

if [ "${1:-}" = "--list" ]; then
  ls -1t "$DEST"/prts-bot-*.tar.zst* 2>/dev/null || { echo "No backups in $DEST yet."; exit 0; }
  newest="$(ls -1t "$DEST"/prts-bot-*.tar.zst* | head -1)"
  echo; echo "Files in $newest:"
  case "$newest" in
    *.gpg) gpg -q -d "$newest" | tar --zstd -tvf - ;;
    *) tar --zstd -tvf "$newest" ;;
  esac
  exit 0
fi

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
write_status() { # ok file size error
  mkdir -p "$STATUS_DIR"
  local count
  count="$(ls -1 "$DEST"/prts-bot-*.tar.zst* 2>/dev/null | wc -l)"
  printf '{"time":"%s","ok":%s,"file":"%s","size":%s,"kept":%s,"dir":"%s","error":"%s"}\n' \
    "$(date -Iseconds)" "$1" "$(json_str "$2")" "${3:-0}" "$count" "$(json_str "$DEST")" "$(json_str "$4")" \
    >"$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"
}
OUT=""
fail() { rm -f "${OUT:+$OUT.part}"; write_status false "" 0 "$1"; echo "Backup failed: $1" >&2; exit 1; }
trap 'fail "the script stopped at line $LINENO"' ERR

mkdir -p "$DEST"
chmod 700 "$DEST"
[ -w "$DEST" ] || fail "cannot write to $DEST"

paths=("$ROOT/.env" "$ROOT/cache" "$STATE_DIR" "${XDG_CONFIG_HOME:-$HOME/.config}/prts-control")
for p in $EXTRA; do paths+=("$(expand "$p")"); done
existing=()
for p in "${paths[@]}"; do [ -e "$p" ] && existing+=("${p#/}"); done
[ ${#existing[@]} -gt 0 ] || fail "nothing to back up (no .env, cache/ or $STATE_DIR)"

# Re-downloadable or temporary files.
EXCLUDES=(--exclude='*.tmp' --exclude='__pycache__' --exclude="${STATE_DIR#/}/inbox"
  --exclude="${ROOT#/}/cache/arkdata.json" --exclude="${ROOT#/}/cache/arkplus.json")
OUT="$DEST/prts-bot-$(date +%Y-%m-%d_%H%M%S).tar.zst"
if [ -n "$RECIPIENT" ]; then
  command -v gpg >/dev/null || fail "PRTS_BACKUP_GPG_RECIPIENT is set but gpg is not installed"
  OUT="$OUT.gpg"
  tar --zstd -cpf - -C / "${EXCLUDES[@]}" "${existing[@]}" \
    | gpg -q --batch --yes --trust-model always --auto-key-locate local -e -r "$RECIPIENT" -o "$OUT.part" \
    || fail "tar or gpg failed (is the key '$RECIPIENT' in your keyring?)"
else
  tar --zstd -cpf "$OUT.part" -C / "${EXCLUDES[@]}" "${existing[@]}" \
    || fail "tar failed"
fi
chmod 600 "$OUT.part"
mv -f "$OUT.part" "$OUT"

# Keep only the newest $KEEP backups.
ls -1t "$DEST"/prts-bot-*.tar.zst* | tail -n +$((KEEP + 1)) | xargs -r rm -f --
size="$(stat -c %s "$OUT")"
write_status true "$OUT" "$size" ""
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1)), keeping the newest $KEEP."
