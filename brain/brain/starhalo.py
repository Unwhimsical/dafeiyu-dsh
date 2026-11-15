"""星骸（StarHalo v1.2）采纳项的大脑侧实现。全部有开关：config.json → "starhalo": {...}；"enabled": false 一键全关。

- 原始记忆不可变：content 永不被「情绪滤镜」改写，滤镜只给注入那一行加一句主观感受的尾注（中性情绪时不加）。
- 情绪变化置信度过滤：模型给的情绪变化带 confidence 且低于阈值（默认 0.6，防反讽/玩笑误判）→ 不改情绪。
- 随机游走联想：只从「情绪浓度中等」的记忆里挑，带「突然想起」口吻；每轮最多 1 条、同一会话最短间隔；
  非主人会话里永不挑 18+ / 私密 / 别人的私密；不参与人格演化。
- 主人反馈：确认 / 更正 / 否认 → credibility + version（乐观锁），原文保留可追溯。
"""
from __future__ import annotations
from .util import now_ms, iso

DEFAULTS = {
    "enabled": True,
    "subjective_filter": {"enabled": True, "strength": 0.5},
    "confidence_min": 0.6,
    "random_walk": {"enabled": True, "min_interval_min": 20, "emo_lo": 0.25, "emo_hi": 0.85},
    "feedback": True,
}
_last_walk: dict[str, float] = {}


def conf(b) -> dict:
    c = b.cfg.get("starhalo") or {}
    out = {**DEFAULTS, **c}
    for k in ("subjective_filter", "random_walk"):
        out[k] = {**DEFAULTS[k], **(c.get(k) or {})}
    return out


def on(b, part=None) -> bool:
    c = conf(b)
    if not c.get("enabled", True):
        return False
    if part is None:
        return True
    v = c.get(part)
    return bool(v.get("enabled", True)) if isinstance(v, dict) else bool(v)


def valence(b, pid) -> float:
    """-1..1：开心/满足 为正，生气/被冷落/黑化 为负。情绪模块关了 → 0（中性）。"""
    try:
        if not b.module_on("emotion", pid):
            return 0.0
        from . import emotion
        st = emotion.state(b, pid)["dims"]
        g = lambda d: float((st.get(d) or {}).get("surface") or 0)
        v = (g("开心") + g("满足") - g("生气") - g("被冷落") - 0.5 * g("黑化")) / 120.0
        return max(-1.0, min(1.0, v))
    except Exception:
        return 0.0


def tint(line: str, val: float, strength: float) -> tuple[str, bool]:
    """主观记忆滤镜：只加尾注，不改原文。"""
    x = val * strength
    if abs(x) < 0.15:
        return line, False
    if x > 0:
        tail = "（现在想起来，心里是暖的）" if x < 0.4 else "（现在想起来都想笑）"
    else:
        tail = "（现在想起来有点不是滋味）" if x > -0.4 else "（现在想起来心里发堵）"
    return line + tail, True


def walk_ok(b, chat: str, row, adult_chat: bool) -> bool:
    """随机游走挑的这条，能不能在这个会话里「突然想起」。"""
    from .sensitivity import is_adult_row
    from . import forgetting as F
    c = conf(b)["random_walk"]
    emo = F.emotion_of(row)
    if not (float(c["emo_lo"]) <= emo <= float(c["emo_hi"])):
        return False
    if not adult_chat and is_adult_row(row):
        return False
    owner = b.cfg.get("owner_chat") or ""
    if chat != owner:
        try:
            eff = b.privacy.effective(row)
        except Exception:
            eff = "private"
        origin = row["origin_chat"] if "origin_chat" in row.keys() else ""
        if eff == "private" and origin != chat:
            return False
    return True


def walk_interval_ok(b, chat: str, now=None) -> bool:
    now = now or now_ms()
    gap = float(conf(b)["random_walk"]["min_interval_min"]) * 60_000
    return now - _last_walk.get(chat or "", 0) >= gap


def walk_mark(chat: str, now=None):
    _last_walk[chat or ""] = now or now_ms()


def feedback(b, mid: str, action: str, content: str = "", expected_version=None) -> dict:
    """主人对一条被想起的记忆说：确认 / 更正 / 否认。"""
    from . import memory as M
    r = M.get(b, mid)
    if not r:
        return {"ok": False, "error": "not_found"}
    ver = int(r["version"] or 1) if "version" in r.keys() else 1
    if expected_version is not None and int(expected_version) != ver:
        return {"ok": False, "error": "version_conflict", "version": ver, "message": "这条记忆刚被改过，刷新后再操作"}
    now = iso()
    if action == "confirm":
        prev = (r["credibility"] if "credibility" in r.keys() else "") or ""
        b.db.x("UPDATE memories SET credibility='confirmed', version=?, updated_at=? WHERE id=?", (ver + 1, now, mid))
        if prev in ("pending_core", "pending"):   # 主人确认 → 核心事实候选进 core 层并钉住；别人说的待证实事实转长期
            from .util import jdump, jload
            tags = [t for t in jload(r["tags"], []) if t not in ("待主人确认", "待证实")] + ["主人确认"]
            if prev == "pending_core":
                b.db.x("UPDATE memories SET tier='core', pinned=1, state='pinned', tags=? WHERE id=?", (jdump(tags), mid))
            else:
                b.db.x("UPDATE memories SET tier='long', tags=? WHERE id=?", (jdump(tags), mid))
        M.reinforce(b, mid, kind="confirmed")
        b.audit(mid, "feedback_confirm", {"version": ver + 1})
        return {"ok": True, "credibility": "confirmed", "version": ver + 1}
    if action == "correct":
        if not content.strip():
            return {"ok": False, "error": "need_content"}
        res = M.supersede(b, mid, content.strip())
        if res.get("ok"):
            b.db.x("UPDATE memories SET credibility='corrected', version=? WHERE id=?", (ver + 1, mid))
            b.db.x("UPDATE memories SET credibility='confirmed' WHERE id=?", (res["new_id"],))
            b.audit(mid, "feedback_correct", {"new": res["new_id"], "version": ver + 1})
        return res
    if action == "deny":
        # 不删：标记否认 + 归档（原文保留，可在工作台恢复）；以后不进召回、不参与演化
        b.db.x("UPDATE memories SET credibility='denied', status='archived', version=?, updated_at=? WHERE id=?", (ver + 1, now, mid))
        b.audit(mid, "feedback_deny", {"version": ver + 1})
        return {"ok": True, "credibility": "denied", "version": ver + 1}
    return {"ok": False, "error": "bad_action"}
