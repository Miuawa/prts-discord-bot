#!/usr/bin/env python3
"""PRTS Control: a tray icon and small window to switch the PRTS services on and off.

The services are systemd --user units listed in services.json: the user copy
~/.config/prts-control/services.json if it exists (or PRTS_CONTROL_CONFIG),
else the one next to this file. By default: the local model (llama-server),
the Discord bot and the Claude Code narrator.

  Click the tray icon        open the window
  Right-click the tray icon  quick menu (toggle each service, start all, stop all)

Run with --status to print the state of each service and exit (no window).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
USER_CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "prts-control" / "services.json"
CONFIG = Path(os.environ["PRTS_CONTROL_CONFIG"]) if os.environ.get("PRTS_CONTROL_CONFIG") else (USER_CONFIG if USER_CONFIG.exists() else HERE / "services.json")

DEFAULT_SERVICES = [
    {"unit": "llama-server.service", "label": "Local model", "detail": "llama-server", "when_off": ""},
    {"unit": "prts-bot.service", "label": "Discord bot", "detail": "prts-bot", "when_off": "PRTS is offline on Discord.", "confirm_stop": True},
    {"unit": "prts-narrator.service", "label": "Claude narrator", "detail": "prts-narrator", "when_off": ""},
]


def load_services():
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))["services"]
    except (OSError, ValueError, KeyError):
        return DEFAULT_SERVICES


def systemctl(*args, timeout=5):
    try:
        r = subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or r.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)


def state(unit):
    """('active' | 'activating' | 'deactivating' | 'inactive' | 'failed' | ..., enabled: bool)"""
    _, active = systemctl("is-active", unit)
    _, enabled = systemctl("is-enabled", unit)
    return (active.splitlines()[0] if active else "unknown"), enabled.startswith("enabled")


def act(verb, unit):
    """Start/stop without waiting: the window keeps refreshing while systemd works."""
    try:
        subprocess.Popen(["systemctl", "--user", verb, "--no-block", unit],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


def print_status():
    for s in load_services():
        a, e = state(s["unit"])
        print(f"{s['label']:<16} {s['unit']:<24} {a:<12} {'starts on login' if e else 'manual'}")


if "--status" in sys.argv:
    print_status()
    sys.exit(0)

try:
    from PyQt6.QtCore import Qt, QTimer, QLockFile, QDir
    from PyQt6.QtGui import QIcon, QPixmap, QPainter, QColor, QAction
    from PyQt6.QtWidgets import (QApplication, QSystemTrayIcon, QMenu, QWidget, QLabel, QPushButton,
                                 QCheckBox, QGridLayout, QVBoxLayout, QHBoxLayout, QMessageBox, QFrame)
except ImportError:
    try:
        from PySide6.QtCore import Qt, QTimer, QLockFile, QDir
        from PySide6.QtGui import QIcon, QPixmap, QPainter, QColor, QAction
        from PySide6.QtWidgets import (QApplication, QSystemTrayIcon, QMenu, QWidget, QLabel, QPushButton,
                                       QCheckBox, QGridLayout, QVBoxLayout, QHBoxLayout, QMessageBox, QFrame)
    except ImportError:
        msg = ("PRTS Control needs PyQt6 (or PySide6). Install it from your distribution, for example\n"
               "  Arch: sudo pacman -S python-pyqt6    Debian/Ubuntu: sudo apt install python3-pyqt6\n"
               "  Fedora: sudo dnf install python3-pyqt6    or: pip install --user PyQt6")
        print(msg, file=sys.stderr)
        for cmd in (["kdialog", "--error", msg], ["zenity", "--error", "--text", msg]):
            try:
                subprocess.run(cmd, timeout=60)
                break
            except (OSError, subprocess.TimeoutExpired):
                continue
        sys.exit(1)

GREEN, YELLOW, RED, GREY = "#3fb950", "#f2a33a", "#e5534b", "#8b949e"
STATE_TEXT = {"active": ("Running", GREEN), "activating": ("Starting...", YELLOW), "reloading": ("Starting...", YELLOW),
              "deactivating": ("Stopping...", YELLOW), "inactive": ("Off", RED), "failed": ("Failed", RED)}


def dot_icon(color, size=64, ring=None):
    pm = QPixmap(size, size)
    pm.fill(Qt.GlobalColor.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setPen(Qt.PenStyle.NoPen)
    if ring:
        p.setBrush(QColor(ring))
        p.drawEllipse(0, 0, size, size)
    p.setBrush(QColor(color))
    m = size // 8 if ring else 2
    p.drawEllipse(m, m, size - 2 * m, size - 2 * m)
    p.end()
    return QIcon(pm)


class Window(QWidget):
    def __init__(self, app):
        super().__init__()
        self.app = app
        self.setWindowTitle("PRTS Control")
        self.setWindowIcon(app.tray.icon())
        outer = QVBoxLayout(self)
        grid = QGridLayout()
        grid.setHorizontalSpacing(14)
        self.rows = {}
        for r, s in enumerate(app.services):
            dot = QLabel()
            name = QLabel(f"<b>{s['label']}</b><br><span style='color:gray'>{s.get('detail', s['unit'])}</span>")
            status = QLabel()
            btn = QPushButton()
            btn.setMinimumWidth(80)
            btn.clicked.connect(lambda _=False, s=s: app.toggle(s))
            login = QCheckBox("Start on login")
            login.clicked.connect(lambda checked, s=s: app.set_login(s, checked))
            for c, w in enumerate((dot, name, status, btn, login)):
                grid.addWidget(w, r, c)
            self.rows[s["unit"]] = (dot, status, btn, login)
        grid.setColumnStretch(1, 1)
        outer.addLayout(grid)
        line = QFrame()
        line.setFrameShape(QFrame.Shape.HLine)
        outer.addWidget(line)
        self.notes = QLabel()
        self.notes.setWordWrap(True)
        outer.addWidget(self.notes)
        bar = QHBoxLayout()
        start_all = QPushButton("Start all")
        start_all.clicked.connect(app.start_all)
        stop_all = QPushButton("Stop all")
        stop_all.clicked.connect(app.stop_all)
        bar.addWidget(start_all)
        bar.addWidget(stop_all)
        bar.addStretch(1)
        close = QPushButton("Close")
        close.clicked.connect(self.hide)
        bar.addWidget(close)
        outer.addLayout(bar)
        self.setMinimumWidth(720)

    def refresh(self, states):
        notes = []
        for s in self.app.services:
            active, enabled = states[s["unit"]]
            text, color = STATE_TEXT.get(active, (active.capitalize(), GREY))
            dot, status, btn, login = self.rows[s["unit"]]
            dot.setPixmap(dot_icon(color, 18).pixmap(18, 18))
            status.setText(f"<span style='color:{color}'>{text}</span>")
            btn.setText("Stop" if active in ("active", "activating", "reloading") else "Start")
            btn.setEnabled(active != "deactivating")
            login.setChecked(enabled)
            if active in ("inactive", "failed") and s.get("when_off"):
                notes.append(f"<b>{s['label']} is off:</b> {s['when_off']}")
            if active == "failed":
                notes.append(f"<b>{s['label']} failed.</b> Press Start to try again. Log: "
                             f"<code>journalctl --user -u {s['unit']}</code>")
        self.notes.setText("<br>".join(notes) or "All PRTS services are running.")
        self.adjustSize()

    def closeEvent(self, ev):
        # Closing the window keeps the tray icon running.
        ev.ignore()
        self.hide()


class Control:
    def __init__(self, qapp):
        self.qapp = qapp
        self.services = load_services()
        self.states = {}
        self.tray = QSystemTrayIcon(dot_icon(GREY))
        self.tray.setToolTip("PRTS Control")
        self.menu = QMenu()
        self.actions = {}
        for s in self.services:
            a = QAction(s["label"], self.menu, checkable=True)
            a.triggered.connect(lambda _=False, s=s: self.toggle(s))
            self.menu.addAction(a)
            self.actions[s["unit"]] = a
        self.menu.addSeparator()
        self.menu.addAction("Start all", self.start_all)
        self.menu.addAction("Stop all", self.stop_all)
        self.menu.addSeparator()
        self.menu.addAction("Open PRTS Control", self.show_window)
        self.menu.addAction("Quit (services keep running)", qapp.quit)
        self.tray.setContextMenu(self.menu)
        self.tray.activated.connect(self.on_activated)
        self.window = Window(self)
        self.timer = QTimer()
        self.timer.timeout.connect(self.refresh)
        self.timer.start(2000)
        self.refresh()
        self.tray.show()

    def on_activated(self, reason):
        if reason in (QSystemTrayIcon.ActivationReason.Trigger, QSystemTrayIcon.ActivationReason.DoubleClick):
            self.show_window()

    def show_window(self):
        self.window.show()
        self.window.raise_()
        self.window.activateWindow()

    def refresh(self):
        self.states = {s["unit"]: state(s["unit"]) for s in self.services}
        up = [s for s in self.services if self.states[s["unit"]][0] == "active"]
        busy = any(self.states[s["unit"]][0] in ("activating", "deactivating", "reloading") for s in self.services)
        if busy:
            color = YELLOW
        elif len(up) == len(self.services):
            color = GREEN
        elif not up:
            color = RED
        else:
            color = YELLOW
        self.tray.setIcon(dot_icon(color))
        lines = []
        for s in self.services:
            a, _ = self.states[s["unit"]]
            self.actions[s["unit"]].setChecked(a in ("active", "activating"))
            lines.append(f"{s['label']}: {STATE_TEXT.get(a, (a, None))[0]}")
        self.tray.setToolTip("PRTS Control\n" + "\n".join(lines))
        if self.window.isVisible():
            self.window.refresh(self.states)

    def is_on(self, s):
        return self.states.get(s["unit"], ("inactive", False))[0] in ("active", "activating", "reloading")

    def confirm(self, text):
        box = QMessageBox(QMessageBox.Icon.Warning, "PRTS Control", text,
                          QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        box.setDefaultButton(QMessageBox.StandardButton.No)
        return box.exec() == QMessageBox.StandardButton.Yes

    def toggle(self, s):
        if self.is_on(s):
            if s.get("confirm_stop") and not self.confirm(f"Stop {s['label']}?\n\n{s.get('when_off', '')}"):
                self.refresh()
                return
            act("stop", s["unit"])
        else:
            act("start", s["unit"])
        QTimer.singleShot(300, self.refresh)
        if not self.window.isVisible():
            self.tray.showMessage("PRTS Control", f"{s['label']}: {'stopping' if self.is_on(s) else 'starting'}...",
                                  QSystemTrayIcon.MessageIcon.Information, 2500)

    def start_all(self):
        for s in self.services:
            act("start", s["unit"])
        QTimer.singleShot(300, self.refresh)

    def stop_all(self):
        if not self.confirm("Stop all PRTS services?\n\nPRTS goes offline on Discord and the local model stops."):
            return
        for s in reversed(self.services):
            act("stop", s["unit"])
        QTimer.singleShot(300, self.refresh)

    def set_login(self, s, on):
        code, out = systemctl("enable" if on else "disable", s["unit"])
        if code != 0:
            QMessageBox.warning(self.window, "PRTS Control", f"Could not change {s['unit']}:\n{out}")
        self.refresh()


def main():
    qapp = QApplication(sys.argv)
    qapp.setApplicationName("PRTS Control")
    qapp.setDesktopFileName("prts-control")
    qapp.setQuitOnLastWindowClosed(False)
    lock = QLockFile(QDir.tempPath() + "/prts-control.lock")
    if not lock.tryLock(100):
        # Already running: nothing to do (the tray icon is there).
        return 0
    if not QSystemTrayIcon.isSystemTrayAvailable():
        print("No system tray found; opening the window only.", file=sys.stderr)
    ctl = Control(qapp)
    if "--show" in sys.argv or not QSystemTrayIcon.isSystemTrayAvailable():
        ctl.show_window()
    return qapp.exec()


if __name__ == "__main__":
    sys.exit(main())
