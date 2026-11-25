#!/usr/bin/env bash
# narrator-ctl.sh exit     ask the narrator to /exit (closes Remote Control cleanly)
# narrator-ctl.sh restart  /exit, then start a fresh session (daily restart)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/daily-restart.log"
log() { echo "$(date '+%F %T') $*" >>"$LOG"; }
running() { tmux has-session -t prts-narrator 2>/dev/null; }

ask_exit() {
  running || return 0
  tmux send-keys -t prts-narrator Escape
  sleep 0.5
  tmux send-keys -t prts-narrator -l '/exit'
  sleep 0.6
  tmux send-keys -t prts-narrator Enter
  for _ in $(seq 1 20); do running || return 0; sleep 1; done
  return 1
}

case "$1" in
  exit) ask_exit || log "narrator did not /exit within 20 s" ;;
  restart)
    if ! running; then log 'narrator not running, nothing to restart'; exit 0; fi
    ask_exit || log 'narrator did not /exit within 20 s, stopping it'
    systemctl --user restart prts-narrator.service && log 'narrator restarted' || log 'narrator restart failed'
    ;;
  *) echo "usage: $0 exit|restart" >&2; exit 2 ;;
esac
