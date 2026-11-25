#!/usr/bin/env bash
# Installs PRTS Control: an app-menu entry and (unless --no-autostart) a login
# autostart entry for the tray icon. --uninstall removes both.
#
#   modules/control/linux/install.sh [--no-autostart | --uninstall]
#
# Needs python3 with PyQt6 (or PySide6) and a desktop with a system tray
# (KDE Plasma, GNOME with an AppIndicator extension, Xfce, ...).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
AUTO="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
AUTOSTART=1
case "${1:-}" in
  --no-autostart) AUTOSTART=0 ;;
  --uninstall)
    rm -f "$APPS/prts-control.desktop" "$AUTO/prts-control.desktop"
    echo "Removed PRTS Control from the app menu and autostart (it keeps running until you quit it)."
    exit 0 ;;
  -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
esac
chmod +x "$DIR/prts_control.py"
entry() {
cat <<EOD
[Desktop Entry]
Type=Application
Name=PRTS Control
GenericName=PRTS service switch
Comment=Turn the PRTS Discord bot, Claude narrator and local model on or off
Exec=/usr/bin/env python3 "$DIR/prts_control.py" $1
Icon=preferences-system-services
Terminal=false
Categories=Utility;System;
StartupNotify=false
EOD
}
mkdir -p "$APPS"
entry --show >"$APPS/prts-control.desktop"
if [ "$AUTOSTART" = 1 ]; then
  mkdir -p "$AUTO"
  { entry ""; echo "X-KDE-autostart-after=panel"; } >"$AUTO/prts-control.desktop"
fi
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
python3 -c "import PyQt6" 2>/dev/null || python3 -c "import PySide6" 2>/dev/null || echo "Note: PyQt6 is not installed yet (see modules/control/README.md)."
echo "Installed: app menu entry 'PRTS Control'$([ "$AUTOSTART" = 1 ] && echo ' and login autostart')."
