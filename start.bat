@echo off
title AI Hub - Universal AI Gateway
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║        AI HUB - Universal AI Gateway     ║
echo  ╠══════════════════════════════════════════╣
echo  ║  Dashboard: http://localhost:8765         ║
echo  ║  Phone:     http://YOUR-IP:8765          ║
echo  ╚══════════════════════════════════════════╝
echo.
cd /d "%~dp0"
node server.js
pause
