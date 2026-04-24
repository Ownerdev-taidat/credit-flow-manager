@echo off
chcp 65001 >nul
title Credit-Flow Manager
cd /d "%~dp0"
echo ========================================
echo   Credit-Flow Manager - Local Server
echo ========================================
echo.
node server.js
pause
