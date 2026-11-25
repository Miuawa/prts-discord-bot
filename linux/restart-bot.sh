#!/usr/bin/env bash
# Restarts only the Discord bot (src/bot.ts); the narrator keeps running.
systemctl --user restart prts-bot.service
sleep 10
journalctl --user -u prts-bot.service -n 8 --no-pager -o cat
