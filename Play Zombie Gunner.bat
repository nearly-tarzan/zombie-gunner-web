@echo off
title Zombie Gunner 3D  -  keep this window open while playing
cd /d "%~dp0"
echo.
echo    ZOMBIE GUNNER 3D
echo    ================
echo    Starting the game server. Your browser will open automatically
echo    at http://localhost:5173 once it is ready (a few seconds).
echo.
echo    KEEP THIS WINDOW OPEN while you play.
echo    Close it (or press Ctrl+C) to stop the game.
echo.
call npm run dev -- --open
echo.
echo    Server stopped. You can close this window now.
pause
