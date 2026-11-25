@echo off
title PRTS bot (Discord)
rem Runs the Discord bot (src\bot.ts) in a restart loop. Started hidden by
rem start-narrator.bat (see run-hidden.vbs). Output goes to logs\bot.log.
rem To stop it, run stop-bot.bat.
set "ROOT=%~dp0.."
if not defined PRTS_BRIDGE_PORT set PRTS_BRIDGE_PORT=47823
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
cd /d "%ROOT%"
rem If a bot already holds the bridge port, exit at once. Without this check a second
rem copy cannot write to bot.log (the running bot has it open), bun never runs, the
rem exit code is never 3 and the copy loops every 10 seconds.
call :running && exit /b
echo [PRTS] Bot launcher started %date% %time% > "%ROOT%\logs\bot.log"
:loop
call :running && exit /b
bun src\bot.ts >> "%ROOT%\logs\bot.log" 2>&1
if %errorlevel%==3 (
  echo [PRTS] Another PRTS bot is already running. Exiting. >> "%ROOT%\logs\bot.log"
  exit /b
)
echo [PRTS] Bot stopped (code %errorlevel%). Restarting in 10 seconds... >> "%ROOT%\logs\bot.log"
timeout /t 10 /nobreak >nul
goto loop

:running
netstat -ano -p tcp | findstr /r /c:"127\.0\.0\.1:%PRTS_BRIDGE_PORT% .*LISTENING" >nul
