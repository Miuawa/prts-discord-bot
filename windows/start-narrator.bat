@echo off
title PRTS - Discord narrator
rem Starts the PRTS narrator (Claude Code with the PRTS channel) and, hidden in the
rem background, the Discord bot. Run it from anywhere; paths are relative to this file.
set "ROOT=%~dp0.."
cd /d "%ROOT%"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
rem The Discord bot runs hidden and keeps going even if this window closes.
rem If it is already running, the new copy notices and exits.
wscript.exe "%~dp0run-hidden.vbs" "%~dp0start-bot.bat"
set PRTS_LAUNCHER=1
rem Claude Code asks once per start to confirm "Loading development channels":
rem choose "I am using this for local development" (press Enter).
set CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
if not defined PRTS_NARRATOR_MODEL set PRTS_NARRATOR_MODEL=sonnet
echo Starting the PRTS narrator (Claude Code). Keep this window open while the narrator should answer.
echo.
rem logs\narrator.wanted tells narrator-watchdog.ps1 to reopen the narrator if it crashes.
echo started %date% %time% > "%ROOT%\logs\narrator.wanted"
rem After a manual restart (fresh logs\restart-handoff.md), start with a first message so the
rem new session shows a recap of the previous chat right away.
set "FIRSTMSG="
powershell -NoProfile -Command "$f='%ROOT%\logs\restart-handoff.md'; if ((Test-Path $f) -and ((Get-Date)-(Get-Item $f).LastWriteTime).TotalMinutes -lt 15) { exit 1 }"
if errorlevel 1 set FIRSTMSG="Session restarted. Read logs/restart-handoff.md, rename it to restart-handoff.used.md, then post here a short recap of the previous chat: what was done and anything still open."
claude %FIRSTMSG% --model %PRTS_NARRATOR_MODEL% --dangerously-load-development-channels server:discord
rem A clean exit (for example /exit) means it was closed on purpose, so the watchdog leaves it alone.
if %errorlevel%==0 del "%ROOT%\logs\narrator.wanted" >nul 2>&1
echo.
echo The narrator has stopped. Instant commands and music keep running in the background.
echo Press any key to close.
pause >nul
