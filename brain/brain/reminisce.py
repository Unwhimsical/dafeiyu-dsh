"""自发回忆：她自己想起事情，不是等提醒、也不是计时器硬推。

线索 = 最近一两天新记下 / 刚聊过的东西；拿它去够一条更旧的记忆，字三元组有交集就算「勾上了」。
反刍闸：同一条旧记忆 cooldownDays 天内不重复，每天最多 maxPerDay 条；写进一条轻量记忆，
并记进 data/reminisce_state.json，供 context 的「你突然想起」优先取用（用一次就标记，不重复念叨）。

默认 autoSend=false：**不进 outbox、不主动给主人发消息**。她想起了什么，下次聊天自然带出来；
想让她主动说，把 behaviour.json → reminisce.autoSend 打开即可。
"""
from __future__ import annotations
import json
import re
from .util import iso, now_ms, clip, local_dt, parse_iso, atomic_write_text
from . import behaviour

STATE_FILE = "reminisce_state.json"
NOISE_TAGS = ("日志", "系统", "交接", "handoff", "chat", "nsfw", "18+", "private", "私密", "待证实")


def _state_path(b):
    return b.cfg.data_path / STATE_FILE


def _load(b) -> dict:
    try:
        d = json.loads(_state_path(b).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _blank(day: str) -> dict:
    return {"day": day, "count": 0, "last": {}, "recent": []}


def _save(b, st: dict):
    try:
        atomic_write_text(_state_path(b), json.dumps(st, ensure_ascii=False, indent=1))
    except Exception as e:
        b.log.debug("reminisce 状态保存失败：%s", e)


def _display(t) -> str:
    """去掉 <回复：1> / [偷笑] 这类聊天模板，别让「想起来的事」带着一串代码。"""
    s = re.sub(r"<[^>]{1,20}>", "", str(t or ""))
    s = re.sub(r"\[[^\]]{1,10}\]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _clean(t) -> str:
    s = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", _display(t)).lower()
    # 名字到处都是，不去掉的话「都提到大肥鱼」会被误判成想起了一件事
    for w in ("大肥鱼", "老爹", "主人"):
        s = s.replace(w, "")
    return s


def _tokens(t) -> set:
    # 中文短句用 2-gram + 3-gram，纯 3-gram 在十几字的聊天记录里几乎撞不上
    s = _clean(t)
    if len(s) < 2:
        return {s} if s else set()
    g = {s[i:i + 2] for i in range(len(s) - 1)}
    if len(s) >= 4:
        g |= {s[i:i + 3] for i in range(len(s) - 2)}
    return g


def _junk(text) -> bool:
    """分享卡片 / 链接 / 纯图片这类模板文字不算「值得想起的事」。"""
    s = str(text or "")
    if len(s) < 12:
        return True
    return any(x in s for x in ("[分享卡片", "[链接", "[图片", "http://", "https://", "【系统", "[系统", "[语音]"))


def _overlap(a: set, b: set) -> float:
    # Jaccard：比「除以较短一边」稳，长句子不会因为碰巧几个字相同就高分
    if not a or not b:
        return 0.0
    hit = a & b
    if len(hit) < 3:
        return 0.0
    return len(hit) / (len(a) + len(b) - len(hit))


def _ms(at) -> int:
    try:
        return int(parse_iso(at or "") or 0)
    except Exception:
        return 0


def _cues(b, now) -> list[tuple]:
    """最近 3 天新增的记忆当线索；过滤日志/系统/私密，且不要自己反刍出来的东西。"""
    try:
        rows = b.db.q(
            "SELECT id, content, tags FROM memories WHERE status='active' AND created_at>=? "
            "ORDER BY created_at DESC LIMIT 30", (iso(now - 3 * 86400_000),))
    except Exception as e:
        b.log.debug("reminisce 线索查询失败：%s", e)
        return []
    out = []
    for r in rows:
        tg = str(r["tags"] or "")
        if any(x in tg for x in NOISE_TAGS) or "自己想起" in tg:
            continue
        c = clip(str(r["content"] or ""), 120)
        if not _junk(c):
            out.append((r["id"], c))
    return out


def _old_memories(b, now) -> list:
    """至少一天前的记忆才算「旧」，最多看最近 300 条，避免全表扫。"""
    try:
        return list(b.db.q(
            "SELECT id, content, tags FROM memories WHERE status='active' AND created_at<=? "
            "ORDER BY created_at DESC LIMIT 300", (iso(now - 86400_000),)))
    except Exception as e:
        b.log.debug("reminisce 旧记忆查询失败：%s", e)
        return []


def run(b, persona=None, force=False, dry_run=False) -> dict:
    conf = behaviour.get(b, "reminisce")
    if not conf.get("enabled", True) and not force:
        return {"ok": True, "skipped": "disabled"}
    now = now_ms()
    day = local_dt(now, b.cfg.get("tz_offset_minutes", 480)).strftime("%Y-%m-%d")
    st = _load(b)
    if st.get("day") != day:
        # 只重置当日配额，反刍记录和最近念头要留着，否则重启后又把同一条想一遍
        st = {**_blank(day), "last": st.get("last") or {}, "recent": st.get("recent") or []}
    st.setdefault("last", {})
    st.setdefault("recent", [])
    max_day = max(0, int(conf.get("maxPerDay", 2)))
    if not force and st.get("count", 0) >= max_day:
        return {"ok": True, "skipped": "daily_cap"}

    cooldown_ms = max(1, int(conf.get("cooldownDays", 7))) * 86400_000
    cues = _cues(b, now)
    olds = _old_memories(b, now)
    if not cues or not olds:
        return {"ok": True, "skipped": "no_cue", "cues": len(cues), "olds": len(olds)}

    old_tok = [(r, _tokens(r["content"])) for r in olds if not _junk(r["content"])]
    min_score = float(conf.get("minScore", 0.075))
    best = None
    for cue_id, cue_text in cues[:8]:
        ct = _tokens(cue_text)
        if not ct or len(_clean(cue_text)) < 8:
            continue
        for r, ot in old_tok:
            if r["id"] == cue_id or "自己想起" in str(r["tags"] or ""):
                continue
            if len(_clean(r["content"])) < 8:
                continue
            if now - _ms(st["last"].get(r["id"])) < cooldown_ms:
                continue
            score = _overlap(ct, ot)
            if score > (best[0] if best else min_score):
                best = (score, r, cue_id, cue_text)
    if not best:
        return {"ok": True, "skipped": "no_link"}

    score, old, cue_id, cue_text = best
    line = f"以前记下的「{clip(_display(old['content']), 60)}」，和最近「{clip(_display(cue_text), 40)}」有点像"
    res = {"ok": True, "score": round(score, 3), "from": old["id"], "cue": cue_id, "text": line, "dry_run": bool(dry_run)}
    if dry_run:
        return res

    try:
        from . import memory
        wrote = memory.remember(b, content=line, persona=persona, kind="event", importance=2,
                                tags=["自己想起", "反刍"], source="system", chat="system",
                                link=False, check_poison=False, tier="short")
        res["memory"] = wrote.get("ok", True) if isinstance(wrote, dict) else True
    except Exception as e:
        b.log.debug("reminisce 写入记忆失败：%s", e)
        res["memory"] = False

    st["last"][old["id"]] = iso(now)
    st["count"] = int(st.get("count", 0)) + 1
    st["recent"] = ([{"at": iso(now), "text": line, "from": old["id"], "score": round(score, 3), "used": False}]
                    + st["recent"])[:10]
    _save(b, st)

    if conf.get("autoSend", False):
        try:
            from . import outbox
            res["outbox"] = outbox.put(b, persona, b.cfg.get("owner_chat") or "", "note", text=line)
        except Exception as e:
            b.log.debug("reminisce outbox 失败：%s", e)
    b.log.info("自发想起一条（%.3f）：%s", score, clip(line, 60))
    return res


def take_for_context(b, consume=True) -> dict | None:
    """给 context.build 用：取一条 24 小时内、还没念叨过的自己想起的事。"""
    st = _load(b)
    for item in list(st.get("recent") or [])[:3]:
        if item.get("used") or not item.get("text"):
            continue
        if now_ms() - _ms(item.get("at")) > 24 * 3600_000:
            continue
        if consume:
            item["used"] = True
            _save(b, st)
        return {"text": item["text"], "at": item.get("at")}
    return None
