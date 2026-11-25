#!/usr/bin/env bash
# Restarts the narrator now (like the 5:00 restart), after saving the chat to
# logs/chat-logs/ and logs/restart-handoff.md for the new session.
# The restart runs as its own systemd unit, so it survives this session closing.
DIR="$(cd "$(dirname "$0")" && pwd)"
python3 -I "$DIR/save-chat-log.py"
sleep 5
systemctl --user start --no-block prts-narrator-restart.service
