"""统一行为开关（热生效）。

读 plugins-data/dafeiyu/behaviour.json，和抖音/语音共用同一份文件。
按 mtime 缓存：改完保存即生效，不用重启大脑、不用重启 DSH。
路径来自 config.json 的 behaviour_path；没配就用插件数据目录下的 behaviour.json（见 config.plugin_data_dir）。

设计原则：这里只管「她要不要自己动 / 改动能不能生效」，原有的安全上限、
夜间静默、验证码熔断、隐私分层一律不经过这里，也不会被这里放开。
"""
from __future__ import annotations
import json
import threading
import time
from pathlib import Path

from .config import plugin_data_dir


DEFAULTS = {
    "reminisce": {"enabled": True, "maxPerDay": 2, "cooldownDays": 7, "autoSend": False},
    "growth": {"enabled": True, "injectMode": "fact"},
    "voice": {"listenFacts": True, "factsInPrompt": True, "senseVoice": False},
}

_lock = threading.RLock()
_cache = {"path": "", "mtime": -1, "at": 0.0, "data": None}


def _path(b) -> Path:
    p = str(b.cfg.get("behaviour_path") or "").strip() or str(plugin_data_dir() / "behaviour.json")
    return Path(p)


def _merge(raw: dict) -> dict:
    out = {k: dict(v) for k, v in DEFAULTS.items()}
    for k, v in (raw or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = v
    return out


def get(b, section: str | None = None, fresh: bool = False) -> dict:
    """返回整份配置或某一节。文件读不到/写坏了 → 回退 DEFAULTS，不让大脑起不来。"""
    p = _path(b)
    now = time.time()
    with _lock:
        c = _cache
        c["at"] = now
        # 每次都 stat（开销极小）：主人改完保存就立刻生效，不留「怎么没变」的缓存窗口。
        try:
            mt = p.stat().st_mtime
        except OSError:
            mt = -1
        if fresh or c["data"] is None or c["path"] != str(p) or mt != c["mtime"]:
            try:
                raw = json.loads(p.read_text(encoding="utf-8-sig"))
            except Exception as e:
                b.log.debug("behaviour 读取失败，用默认值：%s", e)
                raw = {}
            c["data"] = _merge(raw if isinstance(raw, dict) else {})
            c["mtime"] = mt
            c["path"] = str(p)
        data = c["data"]
    return dict(data.get(section, {})) if section else dict(data)


def on(b, section: str, key: str, default=True) -> bool:
    v = get(b, section).get(key, default)
    return v is not False and v not in (0, "0", "false", "off", "")
