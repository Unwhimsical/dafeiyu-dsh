"""TTS 代理守护：8790 挂了就由大脑拉起（大脑本身有 ensureCore 保活）。

用大脑来当守护者，比单独再养一个 PowerShell 循环更可靠：
brain 由插件 ensureCore 每 45 秒探活，挂了会自己重启，重启时会重新启动本线程。
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
import urllib.request

PROXY_SCRIPT = os.environ.get("DAFEIYU_TTS_PROXY", "breeze-tts-proxy.mjs")
PROXY_DIR = os.path.dirname(PROXY_SCRIPT)
PROXY_PORT = int(os.environ.get("DAFEIYU_TTS_PORT", "8790"))
NODE = os.environ.get(
    "DAFEIYU_NODE",
    "node",
)
INTERVAL = float(os.environ.get("DAFEIYU_TTS_INTERVAL", "45"))
CREATE_NO_WINDOW = 0x08000000

_started = {"at": 0.0, "count": 0, "last_ok": 0.0}
_lock = threading.Lock()


def healthy(timeout: float = 3.0) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PROXY_PORT}/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def start_proxy(log=None) -> bool:
    now = time.time()
    with _lock:
        if now - _started["at"] < 20:      # 冷却，避免端口冲突时狂拉
            return False
        _started["at"] = now
        _started["count"] += 1
    try:
        subprocess.Popen(
            [NODE, PROXY_SCRIPT],
            cwd=PROXY_DIR,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW,
            close_fds=True,
        )
        if log:
            try:
                log(f"[tts-watch] 8790 没在跑，已拉起代理（第 {_started['count']} 次）")
            except Exception:
                pass
        return True
    except Exception as e:  # pragma: no cover
        if log:
            try:
                log(f"[tts-watch] 拉起失败：{e}")
            except Exception:
                pass
        return False


def status() -> dict:
    ok = healthy()
    if ok:
        _started["last_ok"] = time.time()
    return {
        "ok": ok,
        "port": PROXY_PORT,
        "script": PROXY_SCRIPT,
        "spawned": _started["count"],
        "last_ok": _started["last_ok"],
    }


def start_loop(log=None, interval: float | None = None) -> threading.Thread:
    iv = INTERVAL if interval is None else interval

    def loop():
        while True:
            try:
                if not healthy():
                    start_proxy(log)
                    time.sleep(5)
                    if healthy() and log:
                        try:
                            log("[tts-watch] 代理已恢复")
                        except Exception:
                            pass
            except Exception:
                pass
            time.sleep(iv)

    t = threading.Thread(target=loop, name="tts-watch", daemon=True)
    t.start()
    return t
