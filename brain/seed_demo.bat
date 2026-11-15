@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 只在演示/空库上用！会写入演示记忆。
".venv\Scripts\python.exe" scripts\seed_demo.py --config config.json
pause
