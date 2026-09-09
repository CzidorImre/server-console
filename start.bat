@echo off
title Server Dashboard
cd /d "%~dp0"
node server.js
echo.
echo The dashboard stopped. Press any key to close.
pause >nul
