@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 大肥鱼记忆大脑 v2 (8780)
if not exist ".venv\Scripts\python.exe" call install.bat
set PYTHONUTF8=1
".venv\Scripts\python.exe" -m brain --config config.json
echo 服务已退出（退出时已自动备份）。
pause
