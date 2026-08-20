@echo off
title AI Hub - Phone Mode
echo.
echo  ====================================
echo     AI HUB - Running on Phone
echo  ====================================
echo.
echo  1. Install Termux from F-Droid
echo  2. In Termux: pkg install nodejs
echo  3. Copy this folder to phone
echo  4. In Termux: cd ai-hub ^& node phone-server.js
echo.
echo  Your phone IP:
ipconfig | findstr /i "IPv4"
echo.
pause
