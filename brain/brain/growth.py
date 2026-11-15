"""星海生长：她会慢慢变，但变得有边界、可关、可回滚。

三块，全在本地 brain.db，不调 LLM：
1) 性格/风格（Big Five + 两个风格轴）：每天按最近 7 天的情绪快照轻微漂移。每步 ≤ step，离出厂值总偏移 ≤ max_drift。
2) 兴趣：从她最近的「公开」记忆标签里长出来，旧兴趣慢慢淡（×0.95/天），最多 12 个。18+ / 私密记忆不参与。
3) 关系（每个人一份，按身份对照把 QQ / 抖音并成同一个人）：聊过几次、熟悉度、上次聊到的话题（用于「上次你说的…后来怎样了」）。
   关系只在「和这个人的会话」里注入，不会出现在别人的会话 / 群里；18+ 内容不记话题。
另：作息（daily rhythm）——按本地时间给一句精力提示（深夜困、早上迷糊），可关。

开关：config.json → "growth": {"enabled": true, "frozen": false, "step": 0.01, "max_drift": 0.25, "cooldown_h": 168, "threshold": 0.1, "emotion_baseline": True, "baseline_day": 3.0, "baseline_max": 10.0, "relations": true, "rhythm": true, "interests": true}
  enabled=false：不注入、不漂移；frozen=true：照常注入但不再变（主人想「定住」她时用）。每次漂移前自动快照，可在 /api/growth/rollback 回滚。
"""
from __future__ import annotations
import math, re
from .util import iso, now_ms, new_id, jdump, jload, clip, local_dt
from . import textutil as T

TRAITS = {  # 名字: (出厂值 0–1, 低端描述, 高端描述)
    "开放性": (0.70, "守旧", "好奇爱尝鲜"),
    "尽责性": (0.45, "随性", "靠谱"),
    "外向性": (0.65, "安静", "话多爱闹"),
    "宜人性": (0.60, "嘴硬带刺", "温柔好说话"),
    "情绪稳定": (0.45, "敏感易炸", "稳"),
    "俏皮": (0.60, "正经", "贫嘴爱玩梗"),
    "黏人": (0.60, "独立", "黏人"),
}
DEFAULTS = {"enabled": True, "frozen": False, "step": 0.02, "max_drift": 0.25, "cooldown_h": 24, "threshold": 0.04, "emotion_baseline": True, "baseline_day": 3.0, "baseline_max": 10.0, "relations": True, "rhythm": True, "interests": True,
            "interest_max": 12, "interest_decay": 0.95,
            # 让她慢慢变、且看得见。三个新开关都可在 config.json / behaviour.json 里改。
            "prompt_threshold": 0.05,   # 0.02 每轮都播报，调到 0.05 让变化偶尔才被看见
            "inject_mode": "fact",      # fact=事实式（默认） / verdict=命令式 / off=不注入
            "week_cap": 0.05}          # 单维 7 日累计变化上限，防雪崩式污染
# 情绪 7 日均值（相对中性 30）→ 性格方向。系数很小，配合 step 上限
DRIFT_MAP = {"开心": {"外向性": 0.6, "俏皮": 0.4}, "满足": {"情绪稳定": 0.5, "宜人性": 0.3}, "生气": {"宜人性": -0.5, "情绪稳定": -0.3},
             "被冷落": {"黏人": 0.5, "情绪稳定": -0.2}, "吃醋": {"黏人": 0.3}}
NOISE_TAGS = {"对话", "日志", "系统", "chat", "log", "交接", "handoff", "记忆屋", "反思", "梦", "自主", "nsfw", "18+", "private", "私密"}


def conf(b) -> dict:
    return {**DEFAULTS, **(b.cfg.get("growth") or {})}


def _fresh():
    return {"traits": {k: v[0] for k, v in TRAITS.items()}, "interests": {}, "steps": 0}


def load(b, pid) -> dict:
    r = b.db.one("SELECT data FROM growth_state WHERE persona_id=?", (pid,))
    d = jload(r["data"], None) if r else None
    if not isinstance(d, dict):
        d = _fresh()
    d.setdefault("traits", {}); d.setdefault("interests", {})
    for k, v in TRAITS.items():
        d["traits"].setdefault(k, v[0])
    return d


def save(b, pid, d):
    _shift_cache.clear()
    b.db.x("INSERT INTO growth_state VALUES (?,?,?) ON CONFLICT(persona_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
           (pid, jdump(d), iso()))


def snapshot(b, pid, reason="auto") -> str:
    sid = new_id("gs_")
    b.db.x("INSERT INTO growth_snapshots VALUES (?,?,?,?,?)", (sid, pid, jdump(load(b, pid)), reason[:120], iso()))
    # 只留最近 60 份
    b.db.x("DELETE FROM growth_snapshots WHERE persona_id=? AND id NOT IN (SELECT id FROM growth_snapshots WHERE persona_id=? ORDER BY created_at DESC LIMIT 60)", (pid, pid))
    return sid


def bounded(cur, target, base, step, max_drift):
    v = cur + max(-step, min(step, target - cur))
    return round(max(0.0, min(1.0, max(base - max_drift, min(base + max_drift, v)))), 4)


def _emotion_avgs(b, pid, days=7) -> dict:
    rows = b.db.q("SELECT values_json FROM emotion_snapshots WHERE persona_id=? ORDER BY day DESC LIMIT ?", (pid, days))
    acc, n = {}, 0
    for r in rows:
        v = jload(r["values_json"], {}) or {}
        n += 1
        for d, x in v.items():
            try:
                s = float(x.get("surface", 0)) if isinstance(x, dict) else float(x)
            except Exception:
                continue
            acc[d] = acc.get(d, 0.0) + s
    return {d: v / n for d, v in acc.items()} if n else {}


def _public_tags(b, pid, days=3) -> dict:
    from .sensitivity import is_adult_row
    since = iso(now_ms() - days * 86400_000)
    cnt = {}
    for r in b.db.q("SELECT content, tags, kind, scope, visibility FROM memories WHERE owner_persona=? AND status='active' AND created_at>=? "
                    "AND scope IN ('public','inherit') AND kind NOT IN ('about_user','relationship','profile') "
                    "AND COALESCE(credibility,'') NOT IN ('denied','corrected') AND COALESCE(source_platform,'') NOT IN ('dream','spontaneous') ORDER BY created_at DESC LIMIT 300", (pid, since)):
        if is_adult_row(r) or (r["visibility"] or "") == "private" and r["scope"] != "public":
            continue
        for t in jload(r["tags"], []) or []:
            t = str(t).strip()
            if 2 <= len(t) <= 12 and t.lower() not in NOISE_TAGS and not re.search(r"\d{5,}|[:：]", t):
                cnt[t] = cnt.get(t, 0) + 1
    return cnt


_shift_cache: dict = {}


def emo_shift(b) -> dict:
    """情绪基线偏移（只给主人格；60 秒缓存）。生长关了/冻结 → 不偏移。"""
    c = conf(b)
    if not c["enabled"] or not c.get("emotion_baseline"):
        return {}
    hit = _shift_cache.get(id(b))
    if hit and now_ms() - hit[0] < 60_000:
        return hit[1]
    try:
        v = {k: float(x) for k, x in (load(b, b.primary).get("emo_shift") or {}).items()}
    except Exception:
        v = {}
    _shift_cache[id(b)] = (now_ms(), v)
    return v


def grow(b, pid=None, force=False) -> dict:
    """每日一次：快照 → 性格漂移 → 兴趣更新。"""
    pid = pid or b.primary
    c = conf(b)
    if not c["enabled"] or (c["frozen"] and not force):
        return {"ok": True, "skipped": "disabled" if not c["enabled"] else "frozen"}
    d = load(b, pid)
    snap = snapshot(b, pid, "每日生长前")
    avgs = _emotion_avgs(b, pid)
    step, md = float(c["step"]), float(c["max_drift"])
    changed = {}
    if avgs:
        push = {}
        for emo, m in DRIFT_MAP.items():
            dev = (avgs.get(emo, 30.0) - 30.0) / 70.0      # -0.43..1
            for t, k in m.items():
                push[t] = push.get(t, 0.0) + dev * k
        lc = d.setdefault("last_change", {})
        wk = d.setdefault("week", {})
        week_cap = float(c.get("week_cap", 0.05))
        for t, p in push.items():
            # 护栏：推力不到阈值不动；同一项冷却；每步 ≤ step；离出厂值 ≤ max_drift；
            # 再加单维 7 日累计夹子，防止几天内整个人设跑偏。
            if abs(p) < float(c["threshold"]):
                continue
            if now_ms() - float(lc.get(t, 0)) < float(c["cooldown_h"]) * 3600_000:
                continue
            hist = [x for x in (wk.get(t) or []) if isinstance(x, list) and len(x) == 2 and now_ms() - float(x[0]) < 7 * 86400_000]
            used = sum(abs(float(x[1])) for x in hist)
            if used >= week_cap:
                continue
            allow = min(step, week_cap - used)
            cur = float(d["traits"].get(t, TRAITS[t][0]))
            nv = bounded(cur, cur + (allow if p > 0 else -allow), TRAITS[t][0], allow, md)
            if abs(nv - cur) >= 0.001:
                changed[t] = [round(cur, 3), nv]; d["traits"][t] = nv; lc[t] = now_ms()
                hist.append([now_ms(), round(nv - cur, 4)]); wk[t] = hist[-40:]
    # 星骸双层情绪的「基线层」：按 7 天平均慢慢挪，每天 ≤ baseline_day 点（=0.03×100），总偏移 ≤ baseline_max；
    # 主人在情绪调参里设的基线是锚点，永远不被改写；快照里一起存，可回滚
    if c.get("emotion_baseline") and avgs:
        from .emotion import EMO_CONF
        sh = d.setdefault("emo_shift", {})
        for emo, (_, _, base) in EMO_CONF.items():
            if emo not in avgs:
                continue
            cur = float(sh.get(emo, 0.0))
            want = max(-float(c["baseline_max"]), min(float(c["baseline_max"]), (avgs[emo] - base) * 0.25))
            stepb = max(-float(c["baseline_day"]), min(float(c["baseline_day"]), want - cur))
            if abs(stepb) >= 0.05:
                sh[emo] = round(cur + stepb, 2)
        _shift_cache.clear()
    if c["interests"]:
        it = {k: round(v * float(c["interest_decay"]), 4) for k, v in d["interests"].items()}
        tags = _public_tags(b, pid)
        for t, n in sorted(tags.items(), key=lambda x: -x[1])[:6]:
            it[t] = round(min(1.0, it.get(t, 0.0) + 0.08 * min(3, n)), 4)
        it = {k: v for k, v in sorted(it.items(), key=lambda x: -x[1])[: int(c["interest_max"])] if v >= 0.05}
        d["interests"] = it
    d["steps"] = int(d.get("steps", 0)) + 1
    save(b, pid, d)
    return {"ok": True, "snapshot": snap, "changed": changed, "interests": list(d["interests"])[:6]}


def rollback(b, pid, sid) -> dict:
    r = b.db.one("SELECT data FROM growth_snapshots WHERE id=? AND persona_id=?", (sid, pid))
    if not r:
        return {"ok": False, "error": "没有这个快照"}
    snapshot(b, pid, f"回滚到 {sid} 之前")
    save(b, pid, jload(r["data"], _fresh()))
    return {"ok": True, "restored": sid}


def reset(b, pid) -> dict:
    snapshot(b, pid, "恢复出厂之前")
    save(b, pid, _fresh())
    return {"ok": True}


def set_traits(b, pid, traits: dict) -> dict:
    """主人手动改（不受 step 限制，但仍夹在 0–1）。"""
    d = load(b, pid)
    snapshot(b, pid, "主人手动调整之前")
    for k, v in (traits or {}).items():
        if k in TRAITS:
            try:
                d["traits"][k] = round(max(0.0, min(1.0, float(v))), 4)
            except (TypeError, ValueError):
                pass
    save(b, pid, d)
    return {"ok": True, "traits": d["traits"]}


def snapshots(b, pid, limit=30):
    return [{"id": r["id"], "reason": r["reason"], "created_at": r["created_at"], "traits": (jload(r["data"], {}) or {}).get("traits", {})}
            for r in b.db.q("SELECT * FROM growth_snapshots WHERE persona_id=? ORDER BY created_at DESC LIMIT ?", (pid, limit))]


def view(b, pid=None) -> dict:
    pid = pid or b.primary
    d = load(b, pid)
    return {"ok": True, "config": conf(b), "traits": {k: {"value": d["traits"][k], "base": TRAITS[k][0], "low": TRAITS[k][1], "high": TRAITS[k][2]} for k in TRAITS},
            "interests": d["interests"], "steps": d.get("steps", 0)}


# —— 关系（每人一份）——
def person_of(b, chat: str, user_id=None) -> str:
    """把 QQ / 抖音同一个人并起来：privacy.json 的 person_map {qq: {douyin, label}}。群聊按发言人。"""
    uid = str(user_id or "").strip()
    if not uid and chat and chat.startswith("p:"):
        uid = chat[2:]
    if not uid:
        return ""
    try:
        pm = (b.privacy.data or {}).get("person_map") or {}
        if uid in pm:
            return "qq:" + uid
        for qq, v in pm.items():
            if isinstance(v, dict) and str(v.get("douyin") or "") == uid:
                return "qq:" + str(qq)
            # 微信：wechat 字段原样或归一后的 wx_<id>（微信模块没对照时的会话号）
            wx = str(v.get("wechat") or "") if isinstance(v, dict) else ""
            if wx and (uid == wx or uid == "wx_" + re.sub(r"[^A-Za-z0-9]", "", wx)[:48]):
                return "qq:" + str(qq)
    except Exception:
        pass
    return "id:" + uid


def relation(b, pid, person) -> dict:
    r = b.db.one("SELECT data FROM relations WHERE persona_id=? AND person=?", (pid, person))
    d = jload(r["data"], None) if r else None
    return d if isinstance(d, dict) else {"turns": 0, "first_seen": iso(), "topics": [], "note": ""}


def on_turn(b, pid, chat, user_id, msg, now=None):
    """真实对话轮（非预览）调用：更新这个人的关系状态。18+ 内容不记话题。"""
    c = conf(b)
    if not (c["enabled"] and c["relations"]) or not msg:
        return
    person = person_of(b, chat, user_id)
    if not person:
        return
    from .sensitivity import is_adult_text
    now = now or now_ms()
    d = relation(b, pid, person)
    # 幂等：预取 + 正式请求会对同一句话各调一次 build，60 秒内同一会话同一句只算一次
    import hashlib
    hsh = hashlib.sha1(f"{chat}|{msg}".encode("utf-8")).hexdigest()[:12]
    if d.get("last_hash") == hsh and now - (_ts(d.get("last_seen")) or 0) < 60_000:
        return
    d["last_hash"] = hsh
    d["turns"] = int(d.get("turns", 0)) + 1
    d["last_seen"] = iso(now)
    d["last_chat"] = chat
    if not c["frozen"] and not is_adult_text(msg) and not re.search(r"暗号|口令|密码|token|\d{6,}", msg, re.I):
        toks = [w for w in T.tokens(msg) if 2 <= len(w) <= 8][:3]
        if toks:
            tp = [t for t in d.get("topics", []) if t.get("w") not in toks]
            tp.insert(0, {"w": "、".join(toks[:2]), "at": iso(now), "chat": chat})
            d["topics"] = tp[:6]
    b.db.x("INSERT INTO relations VALUES (?,?,?,?) ON CONFLICT(persona_id, person) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
           (pid, person, jdump(d), iso(now)))


def stage(d) -> str:
    """关系阶段：熟悉度（聊得多）× 信任里程碑（主人/她明确记下的大事），不是一个无限涨的好感数字；不聊也不掉级。"""
    f = familiarity(d.get("turns", 0))
    ms = len(d.get("milestones") or [])
    if f >= 0.85 and ms >= 3: return "知根知底"
    if f >= 0.5 and ms >= 1: return "很亲近"
    if f >= 0.5: return "很熟"
    if f >= 0.15: return "有点熟"
    return "刚认识"


def familiarity(turns: int) -> float:
    return round(1 - math.exp(-max(0, turns) / 80.0), 3)


def _ago(at, now):
    from .util import parse_iso
    t = parse_iso(at)
    if not t:
        return ""
    h = (now - t) / 3600_000
    return "刚才" if h < 1 else f"{int(h)}小时前" if h < 24 else f"{int(h // 24)}天前"


def relation_line(b, pid, chat, user_id, now) -> str:
    person = person_of(b, chat, user_id)
    if not person:
        return ""
    d = relation(b, pid, person)
    if not d.get("turns"):
        return ""
    lvl = stage(d)
    parts = [f"【和TA】{lvl}"]
    if not chat.startswith("p:"):
        return parts[0]   # 群里只给熟悉度：话题回调 / 主人写的备注只在和这个人的私聊里用，防止在群里当众说出私聊内容
    # 话题回调：只回调「同一个会话」里聊过的，别的平台/会话的话题不带过来（防串）
    tp = [t for t in d.get("topics", []) if t.get("chat") == chat]
    old = [t for t in tp if (now - (_ts(t.get("at")) or now)) > 6 * 3600_000]
    if old:
        parts.append(f"上次聊到「{old[0]['w']}」（{_ago(old[0]['at'], now)}），合适时可以自然地接一句")
    if d.get("note"):
        parts.append("你对TA的了解：" + clip(d["note"], 80))
    return "；".join(parts)


def _ts(at):
    from .util import parse_iso
    return parse_iso(at)


def rhythm_line(b, now) -> str:
    h = local_dt(now, b.cfg.get("tz_offset_minutes", 480)).hour
    if 2 <= h < 7:
        return "【作息】深夜了，她困得迷迷糊糊，回得慢一点、软一点"
    if 7 <= h < 9:
        return "【作息】刚醒，有点起床气"
    if 13 <= h < 14:
        return "【作息】午后有点犯困"
    if 23 <= h or h < 2:
        return "【作息】夜里，精神反而有点兴奋"
    return ""


def prompt_line(b, pid, chat, user_id=None, now=None) -> str:
    c = conf(b)
    if not c["enabled"]:
        return ""
    try:  # 行为开关热生效，关掉就定住，不用重启
        from . import behaviour
        if not behaviour.on(b, "growth", "enabled"):
            return ""
        mode = str(behaviour.get(b, "growth").get("injectMode") or c.get("inject_mode", "fact"))
    except Exception:
        mode = str(c.get("inject_mode", "fact"))
    if mode == "off":
        return ""
    thr = float(c.get("prompt_threshold", 0.02))
    now = now or now_ms()
    d = load(b, pid)
    out = []
    marked = []
    for k, (base, lo, hi) in TRAITS.items():
        v = float(d["traits"].get(k, base))
        if v - base >= thr:
            marked.append(f"比以前更{hi}")
        elif base - v >= thr:
            marked.append(f"比以前更{lo}")
    ints = list(d.get("interests", {}))[:3] if c["interests"] else []
    if marked or ints:
        core = "，".join(marked[:2] + ([f"最近着迷：{'、'.join(ints)}"] if ints else []))
        # fact = 只陈述事实，让她自己决定怎么表现；verdict = 旧式「请体现出来」的命令写法
        out.append("【她这阵子】" + core if mode == "fact" else f"【变化】{core}；回复时请体现出来")
    if c["relations"]:
        rl = relation_line(b, pid, chat, user_id, now)
        if rl:
            out.append(rl)
    if c["rhythm"]:
        rh = rhythm_line(b, now)
        if rh:
            out.append(rh)
    return clip("\n".join(out), 320)


def relations_view(b, pid, limit=200) -> list:
    out = []
    pm = (b.privacy.data or {}).get("person_map") or {}
    for r in b.db.q("SELECT person, data, updated_at FROM relations WHERE persona_id=? ORDER BY updated_at DESC LIMIT ?", (pid, limit)):
        d = jload(r["data"], {}) or {}
        key = r["person"]
        label = (pm.get(key[3:]) or {}).get("label", "") if key.startswith("qq:") else ""
        out.append({"person": key, "label": label, "turns": d.get("turns", 0), "familiarity": familiarity(d.get("turns", 0)), "stage": stage(d),
                    "milestones": d.get("milestones") or [],
                    "last_seen": d.get("last_seen"), "topics": [t.get("w") for t in d.get("topics", [])][:4], "note": d.get("note", "")})
    return out


def set_note(b, pid, person, note=None, milestone=None) -> dict:
    if not person:
        return {"ok": False, "error": "缺 person"}
    d = relation(b, pid, person)
    if note is not None:
        d["note"] = clip(str(note or ""), 200)
    if milestone:
        ms = d.get("milestones") or []
        ms.append({"text": clip(str(milestone), 80), "at": iso()})
        d["milestones"] = ms[-20:]
    b.db.x("INSERT INTO relations VALUES (?,?,?,?) ON CONFLICT(persona_id, person) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
           (pid, person, jdump(d), iso()))
    return {"ok": True}
