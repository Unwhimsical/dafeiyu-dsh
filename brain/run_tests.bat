@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" call install.bat
".venv\Scripts\python.exe" -c "import pytest" 2>nul || ".venv\Scripts\python.exe" -m pip install -r requirements-dev.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
".venv\Scripts\python.exe" -m pytest -q
pause
