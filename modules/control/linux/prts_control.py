#!/usr/bin/env python3
"""PRTS Control: a tray icon and small window to switch the PRTS services on and off.

The services are systemd --user units listed in services.json: the user copy
~/.config/prts-control/services.json if it exists (or PRTS_CONTROL_CONFIG),
else the one next to this file. By default: the local model (llama-server),
the Discord bot and the Claude Code narrator.

  Click the tray icon        open the window
  Right-click the tray icon  quick menu (toggle each service, start all, stop all, logs)
  Logs button / menu         live journal of a service, or of all of them together

Run with --status to print the state of each service and exit (no window).
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
USER_CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "prts-control" / "services.json"
# Optional app icon: put any square PNG here (not shipped with the code; see README).
LOGO = Path(os.environ["PRTS_CONTROL_ICON"]) if os.environ.get("PRTS_CONTROL_ICON") else HERE / "prts-logo.png"
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
    from PyQt6.QtCore import Qt, QTimer, QLockFile, QDir, QProcess
    from PyQt6.QtGui import QIcon, QPixmap, QPainter, QColor, QAction, QFontDatabase
    from PyQt6.QtWidgets import (QApplication, QSystemTrayIcon, QMenu, QWidget, QLabel, QPushButton,
                                 QCheckBox, QGridLayout, QVBoxLayout, QHBoxLayout, QMessageBox, QFrame,
                                 QPlainTextEdit, QComboBox, QLineEdit)
except ImportError:
    try:
        from PySide6.QtCore import Qt, QTimer, QLockFile, QDir, QProcess
        from PySide6.QtGui import QIcon, QPixmap, QPainter, QColor, QAction, QFontDatabase
        from PySide6.QtWidgets import (QApplication, QSystemTrayIcon, QMenu, QWidget, QLabel, QPushButton,
                                       QCheckBox, QGridLayout, QVBoxLayout, QHBoxLayout, QMessageBox, QFrame,
                                       QPlainTextEdit, QComboBox, QLineEdit)
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


def logo_pixmap(size):
    if not LOGO.is_file():
        return None
    pm = QPixmap(str(LOGO))
    if pm.isNull():
        return None
    return pm.scaled(size, size, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)


def app_icon():
    """The logo if there is one, else a grey dot."""
    pm = logo_pixmap(256)
    return QIcon(pm) if pm else dot_icon(GREY)


def status_icon(color, size=64):
    """The logo with a status dot in its lower right corner, or just the dot without a logo."""
    logo = logo_pixmap(size)
    if logo is None:
        return dot_icon(color, size)
    pm = QPixmap(size, size)
    pm.fill(Qt.GlobalColor.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.drawPixmap((size - logo.width()) // 2, (size - logo.height()) // 2, logo)
    d = size * 7 // 16
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor("#1b1f24"))
    p.drawEllipse(size - d, size - d, d, d)
    m = max(2, d // 7)
    p.setBrush(QColor(color))
    p.drawEllipse(size - d + m, size - d + m, d - 2 * m, d - 2 * m)
    p.end()
    return QIcon(pm)


LEVELS = [("Everything", None), ("Warnings and errors", "warning"), ("Errors only", "err")]
LEVEL_COLORS = {0: RED, 1: RED, 2: RED, 3: RED, 4: YELLOW}
MAX_LOG_LINES = 5000


class LogWindow(QWidget):
    """Live `journalctl --user -f` view of one or more units. Stops following while hidden."""

    def __init__(self, units, title):
        super().__init__()
        self.units = units
        self.setWindowTitle(f"{title} - PRTS Control logs")
        self.proc = None
        self.buf = b""
        self.paused = False
        outer = QVBoxLayout(self)
        bar = QHBoxLayout()
        self.level = QComboBox()
        for label, _ in LEVELS:
            self.level.addItem(label)
        self.level.currentIndexChanged.connect(self.restart)
        self.filter = QLineEdit()
        self.filter.setPlaceholderText("Filter (text to match)")
        self.filter.setClearButtonEnabled(True)
        self.filter.returnPressed.connect(self.restart)
        self.pause_btn = QPushButton("Pause")
        self.pause_btn.clicked.connect(self.toggle_pause)
        clear = QPushButton("Clear")
        clear.clicked.connect(lambda: self.view.clear())
        copy = QPushButton("Copy all")
        copy.clicked.connect(lambda: QApplication.clipboard().setText(self.view.toPlainText()))
        for w in (self.level, self.filter, self.pause_btn, clear, copy):
            bar.addWidget(w)
        bar.setStretchFactor(self.filter, 1)
        outer.addLayout(bar)
        self.view = QPlainTextEdit()
        self.view.setReadOnly(True)
        self.view.setMaximumBlockCount(MAX_LOG_LINES)
        self.view.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        self.view.setFont(QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont))
        outer.addWidget(self.view)
        self.status = QLabel()
        self.status.setStyleSheet("color: gray")
        outer.addWidget(self.status)
        self.resize(1000, 560)

    def command(self):
        args = ["--user", "--follow", "--lines", "300", "--output", "json", "--no-pager"]
        for u in self.units:
            args += ["--unit", u]
        prio = LEVELS[self.level.currentIndex()][1]
        if prio:
            args += ["--priority", prio]
        if self.filter.text().strip():
            args += ["--grep", self.filter.text().strip(), "--case-sensitive=false"]
        return args

    def restart(self):
        self.stop()
        self.view.clear()
        self.buf = b""
        self.proc = QProcess(self)
        self.proc.readyReadStandardOutput.connect(self.read_out)
        self.proc.readyReadStandardError.connect(
            lambda: self.append(None, bytes(self.proc.readAllStandardError()).decode(errors="replace").strip(), 3))
        self.proc.start("journalctl", self.command())
        self.status.setText("Following " + ", ".join(self.units) + "  (journalctl --user)")

    def stop(self):
        if self.proc is not None:
            self.proc.kill()
            self.proc.waitForFinished(1000)
            self.proc = None

    def read_out(self):
        if self.proc is None:
            return
        self.buf += bytes(self.proc.readAllStandardOutput())
        *lines, self.buf = self.buf.split(b"\n")
        for raw in lines:
            if not raw.strip():
                continue
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            msg = e.get("MESSAGE", "")
            if isinstance(msg, list):  # journald sends non-UTF-8 messages as a byte array
                msg = bytes(msg).decode(errors="replace")
            try:
                when = time.strftime("%H:%M:%S", time.localtime(int(e.get("__REALTIME_TIMESTAMP", "0")) / 1e6))
            except ValueError:
                when = ""
            # USER_UNIT is set on systemd's own "Starting/Stopped" lines (which come from init.scope)
            unit = e.get("USER_UNIT") or e.get("_SYSTEMD_USER_UNIT") or e.get("SYSLOG_IDENTIFIER", "")
            prefix = f"{when} [{unit.removesuffix('.service')}] " if len(self.units) > 1 else f"{when} "
            try:
                prio = int(e.get("PRIORITY", 6))
            except ValueError:
                prio = 6
            self.append(prefix, msg, prio)

    def append(self, prefix, msg, prio):
        if not msg or self.paused:
            return
        bar = self.view.verticalScrollBar()
        at_bottom = bar.value() >= bar.maximum() - 4
        color = LEVEL_COLORS.get(prio)
        if prefix is None:
            prefix = ""
        if color:
            esc = (prefix + msg).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            self.view.appendHtml(f"<span style='color:{color}; white-space:pre'>{esc}</span>")
        else:
            self.view.appendPlainText(prefix + msg)
        if at_bottom:
            bar.setValue(bar.maximum())

    def toggle_pause(self):
        self.paused = not self.paused
        self.pause_btn.setText("Resume" if self.paused else "Pause")
        self.status.setText(("Paused: new lines are skipped.  " if self.paused else "") + "Following " + ", ".join(self.units))

    def showEvent(self, ev):
        if self.proc is None:
            self.restart()
        super().showEvent(ev)

    def closeEvent(self, ev):
        self.stop()
        ev.accept()


class Window(QWidget):
    def __init__(self, app):
        super().__init__()
        self.app = app
        self.setWindowTitle("PRTS Control")
        self.setWindowIcon(app_icon())
        outer = QVBoxLayout(self)
        grid = QGridLayout()
        grid.setHorizontalSpacing(14)
        self.rows = {}
        for r, s in enumerate(app.services):
            dot = QLabel()
            name = QLabel(f"<b>{s['label']}</b><br><span style='color:gray'>{s.get('detail', s['unit'])}</span>")
            name.setWordWrap(True)
            status = QLabel()
            btn = QPushButton()
            btn.setMinimumWidth(80)
            btn.clicked.connect(lambda _=False, s=s: app.toggle(s))
            login = QCheckBox("Start on login")
            login.clicked.connect(lambda checked, s=s: app.set_login(s, checked))
            logs = QPushButton("Logs")
            logs.setToolTip(f"Live log of {s['unit']}")
            logs.clicked.connect(lambda _=False, s=s: app.show_logs([s]))
            for c, w in enumerate((dot, name, status, btn, login, logs)):
                grid.addWidget(w, r, c)
            if s.get("terminal"):
                term = QPushButton("Terminal")
                term.setToolTip(s.get("terminal_hint", s["terminal"]))
                term.clicked.connect(lambda _=False, s=s: app.open_terminal(s))
                grid.addWidget(term, r, 6)
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
        all_logs = QPushButton("All logs")
        all_logs.setToolTip("Every service's log in one live view")
        all_logs.clicked.connect(lambda: app.show_logs(app.services))
        bar.addWidget(start_all)
        bar.addWidget(stop_all)
        bar.addWidget(all_logs)
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
                notes.append(f"<b>{s['label']} failed.</b> Press Start to try again, or Logs to see why.")
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
        self.tray_color = GREY
        self.tray = QSystemTrayIcon(status_icon(GREY))
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
        logs = self.menu.addMenu("Logs")
        logs.addAction("All services", lambda: self.show_logs(self.services))
        logs.addSeparator()
        for s in self.services:
            logs.addAction(s["label"], lambda s=s: self.show_logs([s]))
        for s in self.services:
            if s.get("terminal"):
                self.menu.addAction(f"{s['label']} terminal", lambda s=s: self.open_terminal(s))
        self.log_windows = {}
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

    def open_terminal(self, s):
        """Runs the service's 'terminal' command in a terminal window ($TERMINAL or the first one found)."""
        import shutil
        cmd = s["terminal"]
        choices = [os.environ.get("TERMINAL", ""), "konsole", "kitty", "alacritty", "gnome-terminal", "xfce4-terminal", "foot", "wezterm", "xterm"]
        for t in filter(None, choices):
            path = shutil.which(t)
            if not path:
                continue
            base = os.path.basename(path)
            if base == "gnome-terminal":
                argv = ["--", "sh", "-c", cmd]
            elif base in ("kitty", "foot"):
                argv = ["sh", "-c", cmd]
            elif base == "wezterm":
                argv = ["start", "--", "sh", "-c", cmd]
            else:
                argv = ["-e", "sh", "-c", cmd]
            QProcess.startDetached(path, argv)
            return
        QMessageBox.warning(None, "PRTS Control", f"No terminal program found. Run this yourself:\n\n{cmd}")

    def show_logs(self, services):
        units = tuple(s["unit"] for s in services)
        w = self.log_windows.get(units)
        if w is None:
            title = "All services" if len(units) > 1 else services[0]["label"]
            w = self.log_windows[units] = LogWindow(list(units), title)
            w.setWindowIcon(app_icon())
        w.show()
        w.raise_()
        w.activateWindow()

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
        if color != self.tray_color:
            self.tray_color = color
            self.tray.setIcon(status_icon(color))
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
    qapp.setWindowIcon(app_icon())
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
