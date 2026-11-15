"""python -m brain [--config config.json] [--port 8780] [--host 127.0.0.1]"""
import argparse, os, sys


def main():
    ap = argparse.ArgumentParser(description="大肥鱼记忆大脑 v2")
    ap.add_argument("--config", default=None)
    ap.add_argument("--host", default=None)
    ap.add_argument("--port", type=int, default=None)
    a = ap.parse_args()
    if a.config:
        os.environ["BRAIN_CONFIG"] = a.config
    import uvicorn
    from .config import Config
    from .core import Brain
    from .api import create_app
    cfg = Config()
    b = Brain(cfg)
    app = create_app(b)
    host, port = a.host or cfg.get("host") or "127.0.0.1", a.port or int(cfg.get("port") or 8780)
    print(f"大肥鱼记忆大脑 v2 → http://{host}:{port}/  （工作台 /workbench.html）  数据库 {cfg.db_file}")
    key = str(cfg.get("admin_key") or "")
    if len(key) < 12 or key in ("change-me", "<ADMIN_KEY>"):
        print("⚠ admin_key 还是默认值或太短：请在 config.json 里改成足够长的随机串（插件里的 memoryToken / memcore.token 要填同一个）。")
    try:
        uvicorn.run(app, host=host, port=port, log_level="warning")
    finally:
        b.close()


if __name__ == "__main__":
    main()
