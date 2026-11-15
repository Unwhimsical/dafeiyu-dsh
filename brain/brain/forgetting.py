"""遗忘机制（移植自 companion-memory forgetting.ts，MIT）。纯数学，不调模型。
strength 读取时按半衰期衰减；被「真正用到」时强化。
状态：pinned（不衰减）/ clear ≥0.5 / faded 0.15–0.5 / trace <0.15。"""
from __future__ import annotations
import random, re
from .util import parse_iso, iso, now_ms

FADED_MIN = 0.15
CLEAR_MIN = 0.5
DEFAULT_EMOTION = 0.3
DAY_MS = 86400_000
BASE_HALF_LIFE = {1: 2, 2: 5, 3: 14, 4: 45}
FADED_PREFIX = "（记得不太清了）"
TRACE_PREFIX = "（很久以前的事）"
SURFACE_COOLDOWN_MS = 48 * 3600_000
TRACE_SURFACE_CHANCE = 0.05
# 永久层只按类型（改造方案：永久层不再按分数，只按类型）
PERMANENT_KINDS = {"preference", "relationship", "profile"}


def _g(r, k, d=None):
    try:
        v = r[k]
    except (KeyError, IndexError):
        return d
    return d if v is None else v


def clamp01(x) -> float:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return 0.0
    return min(1.0, max(0.0, x))


def initial_strength(importance) -> float:
    return clamp01(0.5 + (float(importance or 3)) / 10)


def base_half_life(importance, emotion=DEFAULT_EMOTION, pin_by_imp5=True):
    imp = round(float(importance or 3))
    if imp >= 5 and pin_by_imp5:
        return None
    return BASE_HALF_LIFE.get(max(1, min(4, imp)), 14) * (1 + 2 * clamp01(emotion))


def pinned_by_rule(importance, kind, tags, content, pin_by_imp5=False) -> bool:
    if pin_by_imp5 and float(importance or 0) >= 5:
        return True
    if kind in PERMANENT_KINDS:
        return True
    t = tags if isinstance(tags, str) else " ".join(tags or [])
    if re.search(r"核心|安全词|safe ?word", t, re.I):
        return True
    if re.search(r"安全词|safe ?word", (content or "")[:200], re.I):
        return True
    return False


def is_pinned(r) -> bool:
    if _g(r, "tier") == "core":   # 核心层 = 主人确认过的事实，不衰减
        return True
    if _g(r, "pinned"):
        return True
    st = _g(r, "state")
    if st == "pinned":
        return True
    if st is None:
        return pinned_by_rule(_g(r, "importance", 3), _g(r, "kind"), _g(r, "tags", ""), _g(r, "content", ""))
    return False


def emotion_of(r) -> float:
    e = _g(r, "emotion")
    return DEFAULT_EMOTION if e is None else clamp01(e)


def half_life_of(r) -> float:
    h = _g(r, "half_life_days")
    try:
        h = float(h)
        if h > 0:
            return h
    except (TypeError, ValueError):
        pass
    return base_half_life(_g(r, "importance", 3), emotion_of(r), False) or 14


def strength_now(r, now: float | None = None) -> float:
    if is_pinned(r):
        return 1.0
    now = now if now is not None else now_ms()
    s = _g(r, "strength")
    s0 = initial_strength(_g(r, "importance", 3)) if s is None else clamp01(s)
    t = parse_iso(_g(r, "last_recalled_at") or _g(r, "created_at"))
    days = max(0.0, (now - t) / DAY_MS) if t else 0.0
    return s0 * 0.5 ** (days / half_life_of(r))


def state_of(r, now: float | None = None) -> str:
    if is_pinned(r):
        return "pinned"
    s = strength_now(r, now)
    return "clear" if s >= CLEAR_MIN else "faded" if s >= FADED_MIN else "trace"


def reinforce_patch(r, now: float | None = None) -> dict:
    now = now if now is not None else now_ms()
    rc = int(_g(r, "recall_count", 0) or 0) + 1
    if is_pinned(r):
        return {"strength": 1.0, "half_life_days": _g(r, "half_life_days"), "recall_count": rc, "last_recalled_at": iso(now), "state": "pinned"}
    s_now = strength_now(r, now)
    s = s_now + (1 - s_now) * 0.5
    # 间隔效应（spaced repetition / SM-2 思路）：隔得越久才被想起，记得越牢（×1.2–×1.8）；刚想起又想起只加一点。上限 10 年。
    t = parse_iso(_g(r, "last_recalled_at") or _g(r, "created_at"))
    gap = max(0.0, (now - t) / DAY_MS) if t else 0.0
    hl0 = half_life_of(r)
    mult = 1.2 + 0.6 * min(1.0, gap / max(0.5, hl0))
    return {"strength": s, "half_life_days": min(3650.0, hl0 * mult), "recall_count": rc, "last_recalled_at": iso(now),
            "state": "clear" if s >= CLEAR_MIN else "faded" if s >= FADED_MIN else "trace"}


def initial_fields(importance, kind, tags, content, created_at: str, emotion=None, pin=None, pin_by_imp5=False) -> dict:
    emo = DEFAULT_EMOTION if emotion is None else clamp01(emotion)
    pinned = pin is True or (pin is not False and pinned_by_rule(importance, kind, tags, content, pin_by_imp5))
    hl = base_half_life(importance, emo, False) or base_half_life(4, emo)
    return {"strength": initial_strength(importance), "emotion": emo, "half_life_days": hl, "last_recalled_at": created_at,
            "recall_count": 0, "state": "pinned" if pinned else "clear", "pinned": 1 if pinned else 0}


def display_content(r, state: str) -> str:
    c = _g(r, "content", "")
    ft = _g(r, "faded_text")
    if state == "faded":
        return FADED_PREFIX + (ft or c)
    if state == "trace":
        return TRACE_PREFIX + (ft or c)
    return c


def near_exact_match(content: str, query: str) -> bool:
    q = re.sub(r"\s+", "", (query or "").lower())
    if len(q) < 2:
        return False
    return q in re.sub(r"\s+", "", (content or "").lower())


def surface_weight(r, now: float | None = None, recent_overlap=False, rand=None, cooldown_ms: int = SURFACE_COOLDOWN_MS) -> float:
    """返回浮现乘子（0 = 不浮现）。48h 冷却；trace 5% 概率×0.5；偏爱 0.2–0.4 的 faded；×(1+情绪)；与上一句重叠 ×2。"""
    now = now if now is not None else now_ms()
    last = parse_iso(_g(r, "last_surfaced_at"))
    if last and cooldown_ms and now - last < cooldown_ms:
        return 0.0
    st = state_of(r, now)
    s = strength_now(r, now)
    if st == "trace":
        if (rand or random.random)() >= TRACE_SURFACE_CHANCE:
            return 0.0
        w = 0.5
    elif st == "faded":
        w = 1.5 if 0.2 <= s <= 0.4 else 0.8
    else:
        w = 1.0
    w *= 1 + emotion_of(r)
    if recent_overlap:
        w *= 2
    return w


def recency_factor(r, now: float | None = None, half_life_days=30, floor=0.35) -> float:
    now = now if now is not None else now_ms()
    t = parse_iso(_g(r, "event_date") or _g(r, "updated_at") or _g(r, "created_at"))
    if not t:
        return floor
    days = max(0.0, (now - t) / DAY_MS)
    return floor + (1 - floor) * 0.5 ** (days / half_life_days)
