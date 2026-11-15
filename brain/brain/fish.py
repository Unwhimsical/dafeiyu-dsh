"""小肥鱼状态快照 —— 只读。

大脑控制台读大肥鱼插件（plugins-data/dafeiyu）的配置、模块、模块数据、
最新日志。开关请在大肥鱼控制台直接改；本模块保留 queue 写回仅供兼容旧调用。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from .config import plugin_data_dir

MASK_RE = ("token", "key", "secret", "password", "passwd", "apikey")
MAX_LOG_LINES = 60


def _mask(obj: Any) -> Any:
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if any(s in str(k).lower() for s in MASK_RE) and v not in (None, "", False):
                out[k] = "***"
            else:
                out[k] = _mask(v)
        return out
    if isinstance(obj, list):
        return [_mask(x) for x in obj[:80]]
    return obj


def _read_json(path: Path, limit: int = 200_000) -> Any:
    try:
        if not path.is_file() or path.stat().st_size > limit:
            return None
        return json.loads(path.read_text("utf-8", "ignore"))
    except Exception:
        return None


def _jsonl_tail(path: Path, n: int = 5) -> list:
    try:
        if not path.is_file():
            return []
        lines = path.read_text("utf-8", "ignore").strip().splitlines()[-n:]
        out = []
        for ln in lines:
            try:
                out.append(json.loads(ln))
            except Exception:
                out.append({"raw": ln[:300]})
        return out
    except Exception:
        return []


def _mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except Exception:
        return 0.0


def _files(dirpath: Path, limit: int = 30, cap: int = 4000) -> list[dict]:
    """列目录里最近改动的文件；跳过隐藏目录（如 .edge-profile），并设总量上限，避免整盘扫描卡死。"""
    out = []
    seen = 0
    try:
        for base, dirs, names in os.walk(dirpath):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "Cache", "Code Cache")]
            for name in names:
                if name.startswith("."):
                    continue
                p = Path(base) / name
                seen += 1
                if seen > cap:
                    break
                try:
                    st = p.stat()
                    out.append({"name": str(p.relative_to(dirpath)).replace("\\", "/"), "size": st.st_size, "at": int(st.st_mtime * 1000)})
                except Exception:
                    continue
            if seen > cap:
                break
        out.sort(key=lambda x: x["at"], reverse=True)
        out = out[:limit]
    except Exception:
        pass
    return out

def _aura_dir(cfg: dict | None) -> Path:
    raw = ""
    try:
        c = cfg or {}
        raw = str(c.get("dafeiyu_dir") or c.get("aurabot_dir") or "")
    except Exception:
        raw = ""
    return Path(raw) if raw else plugin_data_dir()


def status(cfg: dict | None = None) -> dict:
    root = _aura_dir(cfg)
    res: dict = {
        "ok": True,
        "root": str(root),
        "exists": root.is_dir(),
        "now": int(time.time() * 1000),
    }
    if not root.is_dir():
        return res

    conf = _read_json(root / "config.json") or {}
    modules_conf = conf.get("modules") if isinstance(conf.get("modules"), dict) else {}
    ext_conf = conf.get("ext") if isinstance(conf.get("ext"), dict) else {}
    res["bot"] = _mask(
        {
            "botQQ": conf.get("botQQ"),
            "ownerQQ": conf.get("ownerQQ"),
            "gateway": conf.get("gateway"),
            "persona": (conf.get("persona") or {}).get("current"),
            "safeMode": conf.get("safeMode"),
            "memory": conf.get("memory"),
            "voice": conf.get("voice"),
            "local": conf.get("local"),
            "douyin": {k: v for k, v in (conf.get("douyin") or {}).items() if k in ("enabled", "autoBrowse", "intervalHours", "maxRunsPerDay", "perRun", "dwellMin", "dwellMax", "shareBias", "ownerDm", "dmPollMinutes", "maxWatchPerDay")},
            "snowluma": {"dir": (conf.get("snowluma") or {}).get("dir")},
        }
    )

    mods_dir = root / "modules"
    data_dir = root / "modules-data"
    mods = []
    if mods_dir.is_dir():
        for p in sorted(mods_dir.iterdir()):
            if not p.is_dir() or p.name.startswith("_"):
                continue
            entry = {
                "id": p.name,
                "at": int(_mtime(p / "index.mjs") * 1000),
                "settings": _mask(ext_conf.get(p.name) or modules_conf.get(p.name) or {}),
                "enabled": ((modules_conf.get(p.name) or {}).get("enabled") is not False)
                           and ((ext_conf.get(p.name) or {}).get("enabled") is not False),
            }
            dp = data_dir / p.name
            if dp.is_dir():
                entry["files"] = _files(dp, 6)
            for name in ("state.json", "host.json", "decisions.jsonl"):
                fp = dp / name
                if fp.is_file():
                    if name.endswith(".jsonl"):
                        entry[name] = _jsonl_tail(fp, 3)
                    else:
                        entry[name] = _mask(_read_json(fp))
            mods.append(entry)
    res["modules"] = mods

    logs = root / "logs"
    tail: list[str] = []
    if logs.is_dir():
        files = sorted([p for p in logs.glob("*.log") if p.is_file()], key=_mtime, reverse=True)
        if files:
            try:
                lines = files[0].read_text("utf-8", "ignore").strip().splitlines()
                tail = [ln[:300] for ln in lines[-MAX_LOG_LINES:]]
                res["log_file"] = files[0].name
            except Exception:
                pass
    res["log_tail"] = tail

    pet = _read_json(root / "modules-data" / "pet" / "host.json") or {}
    res["pet"] = _mask({"baseUrl": pet.get("baseUrl"), "scale": pet.get("scale"), "pluginVersion": pet.get("pluginVersion")})

    aut = ext_conf.get("autonomy") if isinstance(ext_conf.get("autonomy"), dict) else {}
    res["autonomy"] = _mask(
        {
            "enabled": aut.get("enabled"),
            "window": {"start": aut.get("windowStart"), "end": aut.get("windowEnd")},
            "wantPlay": aut.get("wantPlay"),
            "recent": _jsonl_tail(data_dir / "autonomy" / "decisions.jsonl", 5),
        }
    )
    res["ok"] = True
    return res

QUEUE = "modules-data/control/queue.json"
APPLIED = "modules-data/control/applied.json"
ALLOW = {
    "douyin.enabled", "douyin.autoBrowse", "douyin.intervalHours", "douyin.maxRunsPerDay",
    "douyin.perRun", "douyin.dwellMin", "douyin.dwellMax", "douyin.maxWatchPerDay",
    "voice.enabled", "voice.voice", "voice.rate", "voice.pitch",
    "memory.enabled", "ext.autonomy.enabled", "ext.autonomy.windowStart", "ext.autonomy.windowEnd",
        "douyin.ownerDm", "douyin.dmPollMinutes", "douyin.shareBias", "voice.engine", "voice.autoChance", "voice.autoMaxChars", "ext.autonomy.wantPlay",
    "ext.media.autoVision", "ext.media.size", "ext.media.minGapSeconds", "ext.media.genProvider",
        "ext.media.genModel",
    "group.interjectChance", "group.minRelevance", "group.cooldownSec", "group.maxPerHour",
    "group.burstMax", "group.burstWindowSec", "group.activeWindowSec", "group.minRecentMessages",
}


def _dyn_allow(p: str) -> bool:
    """模块开关与扩展开关：modules.<id>.enabled / ext.<id>.enabled"""
    parts = p.split(".")
    if len(parts) == 3 and parts[0] == "modules" and parts[2] == "enabled":
        return bool(parts[1]) and parts[1].replace("_", "").replace("-", "").isalnum()
    if len(parts) == 3 and parts[0] == "ext" and parts[2] == "enabled":
        return bool(parts[1]) and parts[1].replace("_", "").replace("-", "").isalnum()
    return False


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def write_back(cfg: dict | None, changes: list[dict]) -> dict:
    root = _aura_dir(cfg)
    ok, skipped = [], []
    for it in changes or []:
        p = str((it or {}).get("path") or "")
        if not p:
            continue
        if p not in ALLOW and not _dyn_allow(p):
            skipped.append({"path": p, "why": "不在可改范围"})
            continue
        ok.append({"path": p, "value": it.get("value"), "at": int(time.time() * 1000)})
    if not ok:
        return {"ok": False, "skipped": skipped, "message": "没有可写的项"}
    q = root / QUEUE
    cur = []
    try:
        if q.is_file():
            cur = json.loads(q.read_text("utf-8")) or []
    except Exception:
        cur = []
    _atomic_write(q, json.dumps(cur + ok, ensure_ascii=False))
    return {"ok": True, "queued": len(ok), "skipped": skipped}


def applied(cfg: dict | None) -> dict:
    root = _aura_dir(cfg)
    data = None
    try:
        p = root / APPLIED
        if p.is_file():
            data = json.loads(p.read_text("utf-8"))
    except Exception:
        data = None
    return {"ok": True, "applied": data}