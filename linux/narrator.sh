#!/usr/bin/env bash
# Runs the PRTS narrator (Claude Code) inside tmux session "prts-narrator".
# Started by prts-narrator.service; Linux version of windows/start-narrator.bat.
# A crash restarts Claude after 10 s; a clean exit (/exit) ends the session.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
export PATH="$HOME/.local/bin:$PATH"
export PRTS_LAUNCHER=1                    # only this session's bridge connects to the bot
export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/narrator.log"
# Model for the narrator session (PRTS_NARRATOR_MODEL in .env, default sonnet).
MODEL="${PRTS_NARRATOR_MODEL:-$(sed -n 's/^PRTS_NARRATOR_MODEL=//p' "$ROOT/.env" 2>/dev/null | tail -1)}"
MODEL="${MODEL:-sonnet}"

# Claude Code asks once per start to confirm "Loading development channels".
# Answer it in the tmux session (tmux attach -t prts-narrator, choose "I am using
# this for local development", then detach with Ctrl-b d).

while true; do
  # After a manual restart (handoff less than 15 minutes old), open with a recap request.
  FIRST=()
  H="$ROOT/logs/restart-handoff.md"
  if [ -f "$H" ] && [ $(( $(date +%s) - $(stat -c %Y "$H") )) -lt 900 ]; then
    FIRST=("Session restarted. Read logs/restart-handoff.md, rename it to restart-handoff.used.md, then post here a short recap of the previous chat: what was done and anything still open.")
  fi
  echo "$(date '+%F %T') narrator starting" >>"$LOG"
  claude "${FIRST[@]}" --model "$MODEL" --remote-control "PRTS narrator" --dangerously-load-development-channels server:discord
  code=$?
  echo "$(date '+%F %T') narrator exited with code $code" >>"$LOG"
  [ "$code" -eq 0 ] && exit 0
  sleep 10
done
