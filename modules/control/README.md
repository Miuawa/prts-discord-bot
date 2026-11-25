# PRTS Control (desktop module)

A tray icon and a small window to switch the PRTS services on and off on a Linux desktop,
without a terminal. It is a desktop tool, not part of the Discord bot: it has no bot code,
needs no `PRTS_MODULES` entry, and works whether or not other modules are enabled.

**What it does**

- Shows each service with its state (running, starting, stopping, off, failed).
- **Start / Stop** per service, **Start all / Stop all**, and a **Start on login** checkbox
  (`systemctl --user enable/disable`).
- Explains what being off means for each service, and asks before stopping the Discord bot.
- Tray icon color: green = all running, yellow = some running or changing, red = all off.
  Click it to open the window; right-click for a quick menu.
- `prts_control.py --status` prints the states in a terminal and exits (no window).

By default it controls the units from `linux/install.sh`: `llama-server.service` (local model),
`prts-bot.service` (the Discord bot) and `prts-narrator.service` (the Claude Code narrator).
Units that aren't installed simply show as off.

## Requirements

- Linux with systemd user services (the PRTS units installed with `linux/install.sh`).
- Python 3 with PyQt6 (PySide6 also works):
  - Arch / CachyOS: `sudo pacman -S python-pyqt6`
  - Debian / Ubuntu: `sudo apt install python3-pyqt6`
  - Fedora: `sudo dnf install python3-pyqt6`
  - or `pip install --user PyQt6`
- A desktop with a system tray: KDE Plasma, Xfce, Cinnamon, or GNOME with the
  AppIndicator extension. Without a tray, the window opens on its own.

## Install

```bash
modules/control/linux/install.sh                 # app-menu entry + start at login
modules/control/linux/install.sh --no-autostart  # app-menu entry only
modules/control/linux/install.sh --uninstall     # remove both
```

Then open **PRTS Control** from the app menu. Only one copy runs at a time; quitting it from
the tray menu leaves the services running.

## Choose the services

Copy the list and edit your copy, so updates of the repo don't overwrite it:

```bash
mkdir -p ~/.config/prts-control
cp modules/control/linux/services.json ~/.config/prts-control/services.json
```

Each entry:

```json
{ "unit": "prts-bot.service", "label": "Discord bot", "detail": "shown under the name",
  "when_off": "shown while it is off", "confirm_stop": true }
```

Remove entries you don't use (for example `prts-narrator.service` on an API-only setup), or
add others, such as a module's units (`prts-rp-backup.timer`) or another model server.
Services start in list order and stop in reverse order. `PRTS_CONTROL_CONFIG=/path/file.json`
points it at another list.

## Windows

There is no Windows version. Use `windows\start-bot.bat`, `windows\stop-bot.bat`,
`windows\start-narrator.bat` and `windows\stop-narrator.bat` instead.

## Troubleshooting

- **No tray icon**: your desktop has no system tray (on GNOME, install the AppIndicator
  extension). The window still opens from the app menu.
- **"needs PyQt6"**: install it (see Requirements); the message names the package.
- **"Local model" says Running, but nothing can reach it**: your llama.cpp package ships its
  own `llama-server.service`, which starts without a model on another port. Install the PRTS
  one with `linux/install.sh` (without `--no-llama`) and set `LLAMA_MODEL`, `LLAMA_HOST` and
  `LLAMA_PORT` in `.env`; it then takes the package unit's place. Check with
  `systemctl --user cat llama-server`: the first line should be a path under `~/.config`.
- **A service shows "Failed"**: press Start to try again, and read
  `journalctl --user -u <unit>`.
- **Start on login does nothing for the bot**: run `loginctl enable-linger "$USER"` if the
  services should also run while you are logged out.
