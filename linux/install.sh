#!/usr/bin/env bash
# Installs the PRTS systemd user units into ~/.config/systemd/user.
#
#   linux/install.sh [--no-narrator] [--no-llama]
#
# Installs the bot unit, the nightly backup (prts-backup.timer), the Claude
# Code narrator units (only needed when a backend is claude-code or auto) and
# the llama-server unit (only needed for a local model), plus the units of
# every module listed in PRTS_MODULES (modules/<name>/linux/systemd/). Units
# are templates: @ROOT@, @BUN@, @TMUX@ and @LLAMA_SERVER@ are replaced with
# this checkout's path and the programs found on PATH. Creates .env from .env.example if there is none yet.
# Nothing is started or enabled; see README.md ("Running on Linux").
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NARRATOR=1 LLAMA=1
for a in "$@"; do
  case "$a" in
    --no-narrator) NARRATOR=0 ;;
    --no-llama) LLAMA=0 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

BUN="$(command -v bun || true)"
TMUX_BIN="$(command -v tmux || true)"
LLAMA_BIN="$(command -v llama-server || echo /usr/bin/llama-server)"
SWAP_BIN="$(command -v llama-swap || true)"
[ -n "$BUN" ] || { echo "bun not found on PATH (https://bun.sh)" >&2; exit 1; }
[ "$NARRATOR" = 0 ] || [ -n "$TMUX_BIN" ] || echo "warning: tmux not found; prts-narrator.service needs it (or use --no-narrator)" >&2

[ -f "$ROOT/.env" ] || { cp "$ROOT/.env.example" "$ROOT/.env"; chmod 600 "$ROOT/.env"; echo "Created $ROOT/.env"; }
# Enabled modules: PRTS_MODULES from the environment, else from .env.
MODULES="${PRTS_MODULES:-$(sed -n 's/^PRTS_MODULES=//p' "$ROOT/.env" | tail -1)}"

units=("$DIR"/systemd/prts-bot.service "$DIR"/systemd/prts-backup.service "$DIR"/systemd/prts-backup.timer)
[ "$NARRATOR" = 1 ] && units+=("$DIR"/systemd/prts-narrator*.service "$DIR"/systemd/prts-narrator*.timer)
[ "$LLAMA" = 1 ] && units+=("$DIR"/systemd/llama-server.service)
# llama-swap (several local models on one address) when it is installed.
[ "$LLAMA" = 1 ] && [ -n "$SWAP_BIN" ] && units+=("$DIR"/systemd/llama-swap.service)
for m in ${MODULES//,/ }; do
  for u in "$ROOT/modules/$m/linux/systemd/"*.service "$ROOT/modules/$m/linux/systemd/"*.timer; do
    [ -f "$u" ] && units+=("$u")
  done
done

mkdir -p "$UNIT_DIR"
for u in "${units[@]}"; do
  dest="$UNIT_DIR/$(basename "$u")"
  # Render to a temporary file, then move it into place. mv replaces a symlink
  # left by an older install instead of writing through it (which would empty
  # the template it points to).
  sed -e "s|@ROOT@|$ROOT|g" -e "s|@BUN@|$BUN|g" -e "s|@TMUX@|${TMUX_BIN:-/usr/bin/tmux}|g" -e "s|@LLAMA_SERVER@|$LLAMA_BIN|g" -e "s|@LLAMA_SWAP@|${SWAP_BIN:-/usr/bin/llama-swap}|g" \
    "$u" >"$dest.new"
  [ -s "$dest.new" ] || { echo "error: rendering $u gave an empty file" >&2; exit 1; }
  mv -f "$dest.new" "$dest"
done
chmod +x "$DIR"/*.sh "$ROOT"/modules/*/linux/*.sh 2>/dev/null || true
systemctl --user daemon-reload
echo "Installed into $UNIT_DIR:"
for u in "${units[@]}"; do echo "  $(basename "$u")"; done
echo "Settings: $ROOT/.env"
