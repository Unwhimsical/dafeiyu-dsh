@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 大肥鱼记忆大脑 v2 安装 ===
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
if not exist ".venv\Scripts\python.exe" (
  %PY% -m venv .venv || (echo 创建虚拟环境失败：请先装 Python 3.10+ 并勾选 Add to PATH & pause & exit /b 1)
)
".venv\Scripts\python.exe" -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
".venv\Scripts\python.exe" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple || (echo 依赖安装失败 & pause & exit /b 1)
if not exist "config.json" copy /y "config.example.json" "config.json" >nul && echo 已生成 config.json，请打开改 admin_key / owner_chat / spill_dir
if not exist "data" mkdir data
if not exist "data\privacy.json" copy /y "privacy.example.json" "data\privacy.json" >nul && echo 已生成 data\privacy.json，请改成真实 QQ 号
echo.
echo 安装完成。双击 start.bat 启动；想先看看效果，可以在空库上双击 seed_demo.bat 灌演示数据。
pause
