from __future__ import annotations
import json, os, re, tempfile, time, uuid, datetime as dt
from pathlib import Path

def now_ms() -> int:
    return int(time.time() * 1000)

def iso(ms: int | float | None = None) -> str:
    if ms is None:
        ms = now_ms()
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

def parse_iso(s) -> float | None:
    """返回毫秒；兼容 'YYYY-MM-DD HH:MM:SS'（当 UTC）、'YYYY-MM-DD'、带 Z/偏移。"""
    if not s:
        return None
    if isinstance(s, (int, float)):
        return float(s) * (1000 if s < 1e11 else 1)
    t = str(s).strip()
    try:
        if re.fullmatch(r"\d{4}-\d\d-\d\d", t):
            d = dt.datetime.strptime(t, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
        else:
            t2 = t.replace(" ", "T").replace("Z", "+00:00")
            d = dt.datetime.fromisoformat(t2)
            if d.tzinfo is None:
                d = d.replace(tzinfo=dt.timezone.utc)
        return d.timestamp() * 1000
    except Exception:
        return None

def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:16]

def clip(s: str | None, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[: max(0, n - 1)] + "…"

def jdump(o) -> str:
    return json.dumps(o, ensure_ascii=False)

def jload(s, default=None):
    if s is None or s == "":
        return default
    if isinstance(s, (list, dict)):
        return s
    try:
        return json.loads(s)
    except Exception:
        return default

def atomic_write_text(path: str | Path, text: str):
    """原子写：先写临时文件再 os.replace，断电也不会写出半个文件。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def local_dt(ms: float, tz_min: int) -> dt.datetime:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone(dt.timedelta(minutes=tz_min)))

def first(d: dict, *keys, default=None):
    """容忍字段名差异：依次取第一个非空值。"""
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d[k]
    return default

_CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]")

def estimate_tokens(text: str) -> int:
    """粗估 token：中文约 1 字≈1 token，英文约 4 字符≈1 token。"""
    if not text:
        return 0
    cjk = len(_CJK.findall(text))
    rest = len(text) - cjk
    return int(cjk * 1.0 + rest / 4 + 0.5)
