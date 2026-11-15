"""跨平台身份归一 + 私聊隔离：把 Aurabot 那边的设置实时同步进记忆大脑 v3。

Aurabot 是「手脚」，账号/人物绑定写在
`plugins-data/dafeiyu/config.json` 的 `ext.identity`（六个号）与
`ext.memcore.isolatePeople`（`QQ=抖音` 逗号分隔）里。
这里把它们读出来，写成 v3 自己的 `data/privacy.json`：
  - `person_map`:  QQ号 -> {douyin, label}
  - `private_chats`: 这些人的 QQ 号和抖音号都标成 private
只增不删：v3 里手工加的人不会被覆盖掉。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from .config import plugin_data_dir

AURABOT = plugin_data_dir()
CONFIG = AURABOT / "config.json"

# 号 -> 显示名（跟 identity 模块的默认称呼一致：ownerCall=主人、familyName=家人）
LABELS = {
    "owner": "主人",
    "mom": "家人",
    "self": "大肥鱼自己",
}

_lock = threading.Lock()
_last_state = {"at": 0.0, "mtime": 0.0, "people": 0, "ok": False, "note": ""}


def _read_aurabot() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def parse_people(raw) -> list[tuple[str, str, str]]:
    """主人在 identity 设置里写的「people」对照表 → [(qq, 抖音, 名字)]。和插件 features/people.js 同一个格式。"""
    import re
    out = []
    if isinstance(raw, list):
        for x in raw:
            if isinstance(x, dict):
                qq = re.sub(r"\D", "", str(x.get("qq") or ""))
                if qq:
                    out.append((qq, re.sub(r"\D", "", str(x.get("dy") or x.get("douyin") or "")), str(x.get("name") or "").strip()))
        return out
    for line in re.split(r"[\n;；]+", str(raw or "")):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(\d{4,20})\s*(?:[=＝]\s*(\d{4,25})?)?\s*(?:[:：]\s*(.*))?$", line)
        if m:
            out.append((m.group(1), m.group(2) or "", (m.group(3) or "").strip()))
    return out


def _pairs(cfg: dict) -> list[tuple[str, str, str]]:
    """返回 [(qq, douyin, label)]，按 qq 去重。"""
    ext = (cfg.get("ext") or {})
    ident = ext.get("identity") or {}
    out: dict[str, tuple[str, str, str]] = {}

    def add(qq, dy, label):
        qq = str(qq or "").strip()
        dy = str(dy or "").strip()
        if not qq:
            return
        prev = out.get(qq)
        if prev:
            out[qq] = (qq, dy or prev[1], label or prev[2])
        else:
            out[qq] = (qq, dy, label)

    add(ident.get("ownerQq"), ident.get("ownerDouyin"), ident.get("ownerLabel") or LABELS["owner"])
    add(ident.get("momQq"), ident.get("momDouyin"), ident.get("momLabel") or LABELS["mom"])
    add(ident.get("selfQq"), ident.get("selfDouyin"), ident.get("selfLabel") or LABELS["self"])

    # 身份对照表 people：一行一个「QQ=抖音:名字」（抖音、名字都可省；也认「QQ:名字」）
    for qq, dy, label in parse_people(ident.get("people")):
        add(qq, dy, label)

    # isolatePeople: "10001=1000000001,10002=1000000002"
    raw = str((ext.get("memcore") or {}).get("isolatePeople") or "")
    for chunk in raw.replace("，", ",").split(","):
        chunk = chunk.strip()
        if not chunk or "=" not in chunk:
            continue
        qq, dy = chunk.split("=", 1)
        add(qq.strip(), dy.strip(), "")
    return [v for v in out.values() if v[0]]


def _target(target=None) -> Path:
    """写到哪个 privacy.json：调用方（大脑本体）给的路径 > 环境变量 MEMORY_PRIVACY > 老默认。
    原来写死老路径，大脑读的却是 config.privacy_path（data_dir/privacy.json），同步了也不生效。"""
    if target:
        return Path(target)
    return Path(os.environ.get("MEMORY_PRIVACY", "data/privacy.json"))


def sync(force: bool = False, target=None) -> dict:
    """把 Aurabot 的身份/隔离设置并进 v3 的 privacy.json。返回摘要。"""
    with _lock:
        try:
            mtime = CONFIG.stat().st_mtime
        except Exception:
            mtime = 0.0
        if not force and _last_state["ok"] and mtime and mtime == _last_state["mtime"]:
            return dict(_last_state, skipped=True)

        cfg = _read_aurabot()
        people = _pairs(cfg)
        if not people:
            _last_state.update({"at": time.time(), "mtime": mtime, "ok": False,
                                "note": "Aurabot config 里没有身份绑定（未启动过？）"})
            return dict(_last_state)

        target = _target(target)
        try:
            data = json.loads(target.read_text(encoding="utf-8"))
        except Exception:
            data = {}

        pmap = data.get("person_map") or {}
        priv = data.get("private_chats") or {}
        added = 0
        for qq, dy, label in people:
            cur = pmap.get(qq) or {}
            if cur.get("manual"):
                continue   # 主人在控制台「身份」里手填过的，以主人为准，不被自动同步覆盖
            new = {"douyin": dy or cur.get("douyin", ""), "label": label or cur.get("label", "")}
            if cur.get("wechat"):
                new["wechat"] = cur["wechat"]   # 微信 id 只在控制台手填，自动同步别把它丢了
            if new != cur:
                pmap[qq] = new
                added += 1
            priv[qq] = priv.get(qq) or "private"
            if dy:
                priv[dy] = priv.get(dy) or "private"

        data["person_map"] = pmap
        data["private_chats"] = priv
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, target)

        _last_state.update({"at": time.time(), "mtime": mtime, "ok": True,
                            "people": len(people), "changed": added,
                            "note": "已同步 %d 个人" % len(people)})
        return dict(_last_state)


def start_loop(interval: float = 60.0, log=None, target=None, on_change=None) -> threading.Thread:
    def run():
        while True:
            try:
                st = sync(target=target)
                if st.get("changed") and on_change:
                    on_change()
                if log and st.get("changed"):
                    log.info("身份同步：%s", st.get("note"))
            except Exception as e:  # 不能因为同步失败把服务搞挂
                if log:
                    log.warning("身份同步失败：%s", e)
            time.sleep(max(15.0, float(interval)))

    t = threading.Thread(target=run, name="identity-sync", daemon=True)
    t.start()
    return t


def visible_snapshot(target=None) -> dict:
    """给前端看的（不含 token 之类）。"""
    target = _target(target)
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    return {
        "ok": True,
        "person_map": data.get("person_map") or {},
        "private_chats": data.get("private_chats") or {},
        "default_private": data.get("default_private"),
        "default_group": data.get("default_group"),
        "last_sync": dict(_last_state),
        "aurabot_config": str(CONFIG),
    }


# 「封存」会话——主人、家人、隔离名单里的人的私聊（QQ 号和抖音号都算）。
# 这些会话里产生的记忆只在它自己的会话可见，不管 scope 写成什么（public / scoped 也不行）。
# 隔离名单只认主人在插件设置里手动写的 isolatePeople，这里只读不写。
_sealed_cache = {"mtime": None, "ids": frozenset()}


def sealed_ids() -> frozenset:
    """返回 {'p:<号>', ...}。读失败时沿用上一次结果（不会因为读坏文件就把封存放开）。"""
    try:
        mt = CONFIG.stat().st_mtime_ns
    except Exception:
        return _sealed_cache["ids"]
    if mt == _sealed_cache["mtime"]:
        return _sealed_cache["ids"]
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    except Exception:
        return _sealed_cache["ids"]
    ext = cfg.get("ext") or {}
    ident = ext.get("identity") or {}
    ids = set()

    def add(x):
        x = "".join(ch for ch in str(x or "") if ch.isdigit())
        if x:
            ids.add("p:" + x)

    for k in ("ownerQq", "ownerDouyin", "momQq", "momDouyin"):
        add(ident.get(k))
    add(cfg.get("ownerQQ"))
    raw = str((ext.get("memcore") or {}).get("isolatePeople") or "")
    for chunk in raw.replace("，", ",").split(","):
        for part in chunk.split("="):
            add(part.strip())
    # 顺手算出「主人」和「隔离号」两组裸号（只给来源分层用，不打印）
    own = set()
    for x in (ident.get("ownerQq"), ident.get("ownerDouyin"), cfg.get("ownerQQ")):
        x = "".join(ch for ch in str(x or "") if ch.isdigit())
        if x:
            own.add(x)
    iso_ = set()
    for chunk in raw.replace("，", ",").split(","):
        for part in chunk.split("="):
            x = "".join(ch for ch in part if ch.isdigit())
            if x:
                iso_.add(x)
    _sealed_cache.update({"mtime": mt, "ids": frozenset(ids), "owner": frozenset(own), "isolated": frozenset(iso_ - own)})
    return _sealed_cache["ids"]


def owner_ids() -> frozenset:
    """主人的裸号（QQ + 抖音）。"""
    sealed_ids()
    return _sealed_cache.get("owner") or frozenset()


def isolated_ids() -> frozenset:
    """隔离号（memcore isolatePeople 里除主人以外的号）的裸号。"""
    sealed_ids()
    return _sealed_cache.get("isolated") or frozenset()
