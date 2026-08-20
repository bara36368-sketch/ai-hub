@echo off
title AI Hub - Full Stack Launch
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║     AI HUB - Starting All Services       ║
echo  ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0"

REM Start Ollama (if installed)
where ollama >nul 2>nul
if %ERRORLEVEL%==0 (
    echo [1/5] Starting Ollama...
    start /b ollama serve >nul 2>&1
    timeout /t 2 >nul
) else (
    echo [1/5] Ollama not found, skipping...
)

REM Start FreeLLMAPI (if installed)
if exist "%USERPROFILE%\Desktop\FreeLLMAPI\server.js" (
    echo [2/5] Starting FreeLLMAPI...
    cd /d "%USERPROFILE%\Desktop\FreeLLMAPI"
    start /b node server.js >nul 2>&1
    timeout /t 2 >nul
) else (
    echo [2/5] FreeLLMAPI not found, skipping...
)

REM Start FreeDeepseekAPI (if installed)
if exist "%USERPROFILE%\Desktop\FreeDeepseekAPI\server.js" (
    echo [3/5] Starting FreeDeepseekAPI...
    cd /d "%USERPROFILE%\Desktop\FreeDeepseekAPI"
    set NON_INTERACTIVE=1
    start /b node server.js >nul 2>&1
    timeout /t 2 >nul
) else (
    echo [3/5] FreeDeepseekAPI not found, skipping...
)

REM Start CLIProxyAPI (if installed)
if exist "%USERPROFILE%\Desktop\CLIProxyAPI\cli-proxy-api.exe" (
    echo [4/5] Starting CLIProxyAPI...
    cd /d "%USERPROFILE%\Desktop\CLIProxyAPI"
    start /b cli-proxy-api.exe >nul 2>&1
    timeout /t 2 >nul
) else (
    echo [4/5] CLIProxyAPI not found, skipping...
)

REM Start AI Hub
echo [5/5] Starting AI Hub...
cd /d "%~dp0"
node server.js
pause
