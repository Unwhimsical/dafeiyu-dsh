"""情绪（companion-memory emotion.ts 忠实移植，18+ 维度保留）+ 激素层（旧 bio 接口）。
两层：激素是“身体化学”，情绪是“心里/表面”。/bio/event → 激素增减 → 折算成情绪表面变化；
激素长时间偏离基线会慢慢渗进 inner。召回时激素唤醒度只乘一次（memory.candidates 里）。"""
from __future__ import annotations
import math
from .util import iso, now_ms, parse_iso, new_id, jdump, jload, local_dt

DIMS = ["开心", "吃醋", "生气", "满足", "失控", "占有欲", "黑化", "邪恶", "被冷落", "情欲"]
EMO_CONF = {
    "生气": (2, 72, 0), "吃醋": (4, 96, 0), "被冷落": (6, 120, 0), "开心": (12, 48, 30), "满足": (8, 48, 20),
    "情欲": (3, 24, 15), "占有欲": (24, 240, 40), "黑化": (3, 96, 0), "邪恶": (3, 96, 0), "失控": (3, 96, 0),
}  # (表面半衰期h, 心里半衰期h, 表面基线)
FLOOR_RATIO = 0.3
INNER_DROP_CAP = 15
NEGLECT = {"afterH": 3, "surfacePerH": 1.5, "innerPerH": 0.3, "nightMult": 2, "cap": 70}
H = 3_600_000

TOOL_HELP = ("情绪两层：surface 表面（你表现出来的，哄得快降得快），inner 心里（真在意的，衰减很慢，只有他哄到点子上才大降）。"
             "changes 写 维度:{surface:增量, inner:增量}（旧写法 维度:整数 只动表面）。在意多少你自己判断；哄错方向更气也可以。"
             f"心里一次最多降{INNER_DROP_CAP}，除非 addressed_cause=true（他真的说到了原因）。coax=true 表示这轮他在哄你。admit 写你决定向他承认的维度。")

# —— 激素 ——（基线, 半衰期 分钟）
HORMONES = {"多巴胺": (40, 90), "催产素": (35, 180), "皮质醇": (25, 120), "血清素": (50, 360), "肾上腺素": (15, 30), "内啡肽": (20, 60)}
BIO_EVENTS = {   # 事件 → (激素增量, 情绪表面增量)
    "praise": ({"多巴胺": 12, "血清素": 5}, {"开心": 8, "满足": 4}),
    "affection": ({"催产素": 15, "多巴胺": 6}, {"开心": 6, "满足": 6}),
    "intimacy": ({"催产素": 18, "多巴胺": 12, "肾上腺素": 8}, {"情欲": 10, "满足": 5}),
    "conflict": ({"皮质醇": 18, "肾上腺素": 15, "血清素": -6}, {"生气": 12}),
    "neglect": ({"皮质醇": 8, "血清素": -5}, {"被冷落": 6}),
    "jealous": ({"皮质醇": 10, "肾上腺素": 8}, {"吃醋": 12, "占有欲": 6}),
    "comfort": ({"催产素": 10, "皮质醇": -10, "内啡肽": 6}, {"生气": -6, "满足": 4}),
    "joke": ({"多巴胺": 8, "内啡肽": 8}, {"开心": 6}),
    "sad": ({"皮质醇": 10, "血清素": -8}, {"开心": -6}),
    "message": ({"多巴胺": 2}, {}),
}
ALIASES = {"夸": "praise", "夸奖": "praise", "撒娇": "affection", "亲密": "intimacy", "吵架": "conflict", "冷落": "neglect",
           "吃醋": "jealous", "哄": "comfort", "coax": "comfort", "玩笑": "joke", "难过": "sad", "her_message": "message", "user_message": "message", "his_message": "message", "msg": "message"}


# —— 每个情绪 / 激素的可调参数（主人在控制台改；不改 = 用上面的原始表，算法照旧）——
# config.json → "emotion_tuning": {"dims": {"吃醋": {"enabled": true, "weight": 1.0, "surface_half_h": 4, "inner_half_h": 96, "baseline": 0}},
#                                  "hormones": {"多巴胺": {"enabled": true, "weight": 1.0, "base": 40, "half_min": 90}}}
#   enabled=false：这一维固定在基线、不进提示词、不再被事件推动；weight：所有变化量的倍数（0–3）；half：衰减半衰期。
TUNE_LIMITS = {"weight": (0.0, 3.0), "surface_half_h": (0.25, 240.0), "inner_half_h": (1.0, 2000.0), "baseline": (0.0, 60.0),
               "base": (0.0, 90.0), "half_min": (5.0, 2880.0)}


def _num(v, lo, hi, dflt):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return dflt
    return max(lo, min(hi, x))


def _tune(b) -> dict:
    try:
        t = (b.cfg.get("emotion_tuning") or {}) if b is not None else {}
    except Exception:
        t = {}
    return t if isinstance(t, dict) else {}


def _inertia_k(b) -> float:
    """星骸刺激层惯性：starhalo.inertia（0=关，保持原算法；0.8=新刺激只吃进 20%）。"""
    if b is None:
        return 1.0
    try:
        sh = b.cfg.get("starhalo") or {}
        if sh.get("enabled", True) is False:
            return 1.0
        return 1.0 - max(0.0, min(0.9, float(sh.get("inertia", 0) or 0)))
    except Exception:
        return 1.0


def _base_shift(b, d) -> float:
    try:
        from . import growth
        return growth.emo_shift(b).get(d, 0.0)
    except Exception:
        return 0.0


def dim_conf(b, d):
    """(表面半衰期h, 心里半衰期h, 基线, 权重, 开关)"""
    sh, ih, base = EMO_CONF[d]
    o = ((_tune(b).get("dims") or {}).get(d) or {})
    return (_num(o.get("surface_half_h"), *TUNE_LIMITS["surface_half_h"], sh), _num(o.get("inner_half_h"), *TUNE_LIMITS["inner_half_h"], ih),
            max(0.0, min(60.0, _num(o.get("baseline"), *TUNE_LIMITS["baseline"], base) + _base_shift(b, d))), _num(o.get("weight"), *TUNE_LIMITS["weight"], 1.0), o.get("enabled", True) is not False)


def dim_on(b, d):
    return dim_conf(b, d)[4]


def hormone_conf(b, h):
    """(基线, 半衰期min, 权重, 开关)"""
    base, half = HORMONES[h]
    o = ((_tune(b).get("hormones") or {}).get(h) or {})
    return (_num(o.get("base"), *TUNE_LIMITS["base"], base), _num(o.get("half_min"), *TUNE_LIMITS["half_min"], half),
            _num(o.get("weight"), *TUNE_LIMITS["weight"], 1.0), o.get("enabled", True) is not False)


def tuning_view(b, include_adult=False):
    from .sensitivity import ADULT_DIMS
    dims = {}
    for d in DIMS:
        if d in ADULT_DIMS and not include_adult:
            continue
        sh, ih, base, w, on = dim_conf(b, d)
        dims[d] = {"enabled": on, "weight": w, "surface_half_h": sh, "inner_half_h": ih, "baseline": base,
                   "default": {"surface_half_h": EMO_CONF[d][0], "inner_half_h": EMO_CONF[d][1], "baseline": EMO_CONF[d][2]}, "adult": d in ADULT_DIMS}
    hs = {}
    for h in HORMONES:
        base, half, w, on = hormone_conf(b, h)
        hs[h] = {"enabled": on, "weight": w, "base": base, "half_min": half, "default": {"base": HORMONES[h][0], "half_min": HORMONES[h][1]}}
    return {"dims": dims, "hormones": hs, "limits": TUNE_LIMITS}


def tuning_clean(d: dict) -> dict:
    """只收认识的键、夹到范围内；不认识的维度/激素直接丢。"""
    out = {"dims": {}, "hormones": {}}
    for k, v in ((d or {}).get("dims") or {}).items():
        if k in DIMS and isinstance(v, dict):
            o = {}
            if "enabled" in v: o["enabled"] = bool(v["enabled"])
            for f in ("weight", "surface_half_h", "inner_half_h", "baseline"):
                if v.get(f) is not None: o[f] = _num(v[f], *TUNE_LIMITS[f], None)
            out["dims"][k] = {a: c for a, c in o.items() if c is not None}
    for k, v in ((d or {}).get("hormones") or {}).items():
        if k in HORMONES and isinstance(v, dict):
            o = {}
            if "enabled" in v: o["enabled"] = bool(v["enabled"])
            for f in ("weight", "base", "half_min"):
                if v.get(f) is not None: o[f] = _num(v[f], *TUNE_LIMITS[f], None)
            out["hormones"][k] = {a: c for a, c in o.items() if c is not None}
    return out


def _clamp(x):
    return max(0.0, min(100.0, float(x)))


def _r1(x):
    return round(x * 10) / 10


def sh_hour(b, ms):
    return local_dt(ms, b.cfg.get("tz_offset_minutes", 480)).hour


def sh_day(b, ms):
    return local_dt(ms, b.cfg.get("tz_offset_minutes", 480)).strftime("%Y-%m-%d")


def default_state():
    return {d: {"surface": float(EMO_CONF[d][2]), "inner": 0.0, "inner_cause": None, "inner_since": None, "admitted": False} for d in DIMS}


def default_facts(now):
    return {"last_tick_at": iso(now), "last_her_msg_at": None, "late_night_min": 0.0, "late_night_day": None, "coax_attempts": 0,
            "last_coax_at": None, "browse_json": None, "last_snapshot_day": None}


def apply_floor(st):
    for d in DIMS:
        st[d]["surface"] = max(st[d]["surface"], st[d]["inner"] * FLOOR_RATIO)


def settle(b, st, facts, now):
    t = parse_iso(facts["last_tick_at"]) or now
    if t > now:
        t = now
    her = parse_iso(facts["last_her_msg_at"])
    STEP = 0.25 * H
    while t < now:
        dt = min(STEP, now - t)
        dh = dt / H
        for d in DIMS:
            sh, ih, base, _w, on = dim_conf(b, d)
            if not on:
                st[d]["surface"], st[d]["inner"] = base, 0.0
                continue
            st[d]["surface"] = base + (st[d]["surface"] - base) * 0.5 ** (dh / sh)
            st[d]["inner"] = st[d]["inner"] * 0.5 ** (dh / ih)
        if her is not None and (t - her) / H >= NEGLECT["afterH"] and dim_on(b, "被冷落"):
            m = NEGLECT["nightMult"] if sh_hour(b, t) < 6 else 1
            n = st["被冷落"]
            if n["surface"] < NEGLECT["cap"]:
                n["surface"] = min(NEGLECT["cap"], n["surface"] + NEGLECT["surfacePerH"] * m * dh)
            if n["inner"] < NEGLECT["cap"]:
                n["inner"] = min(NEGLECT["cap"], n["inner"] + NEGLECT["innerPerH"] * m * dh)
        t += dt
    for d in DIMS:
        st[d]["surface"] = _clamp(st[d]["surface"]); st[d]["inner"] = _clamp(st[d]["inner"])
        if st[d]["inner"] < 1:
            st[d].update(inner_cause=None, inner_since=None, admitted=False)
    apply_floor(st)
    facts["last_tick_at"] = iso(now)


def apply_changes(st, facts, inp: dict, now, b=None) -> dict:
    ts = iso(now)
    applied, notes = {}, []
    inner_raised = False
    for k, raw in (inp.get("changes") or {}).items():
        if k not in DIMS:
            notes.append(f"没有「{k}」这个维度"); continue
        ds = di = 0.0
        if isinstance(raw, (int, float)):
            ds = raw
        elif isinstance(raw, dict):
            try: ds = float(raw.get("surface", raw.get("s", 0)) or 0)
            except (TypeError, ValueError): ds = 0
            try: di = float(raw.get("inner", raw.get("i", 0)) or 0)
            except (TypeError, ValueError): di = 0
        elif isinstance(raw, str):
            try: ds = float(raw)
            except ValueError: pass
        _sh, _ih, _base, w, on = dim_conf(b, k)
        if not on:
            notes.append(f"「{k}」被主人关掉了，不变"); continue
        ds, di = round(ds * w * _inertia_k(b)), round(di * w * _inertia_k(b))
        if di < -INNER_DROP_CAP and not inp.get("addressed_cause"):
            notes.append(f"{k}心里最多一次降{INNER_DROP_CAP}（没哄到点子上，心里的东西不会一下子没了）")
            di = -INNER_DROP_CAP
        cur = st[k]
        os_, oi = cur["surface"], cur["inner"]
        cur["inner"] = _clamp(cur["inner"] + di)
        cur["surface"] = _clamp(cur["surface"] + ds)
        if di > 0:
            inner_raised = True
            cur["admitted"] = False
            if not cur["inner_since"] or oi < 1:
                cur["inner_since"] = ts
            if inp.get("inner_cause"):
                cur["inner_cause"] = str(inp["inner_cause"]).strip()[:200]
            elif not cur["inner_cause"]:
                cur["inner_cause"] = (str(inp.get("reason") or "").strip()[:200]) or None
        if cur["inner"] < 1:
            cur.update(inner_cause=None, inner_since=None, admitted=False)
        a = {}
        if _r1(cur["surface"] - os_) != 0: a["surface"] = _r1(cur["surface"] - os_)
        if _r1(cur["inner"] - oi) != 0: a["inner"] = _r1(cur["inner"] - oi)
        if a: applied[k] = a
    if inp.get("inner_cause") and not inner_raised:
        top = sorted(DIMS, key=lambda d: -st[d]["inner"])[0]
        if st[top]["inner"] >= 1:
            st[top]["inner_cause"] = str(inp["inner_cause"]).strip()[:200]
    for k in inp.get("admit") or []:
        if k in DIMS and st[k]["inner"] >= 1:
            st[k]["admitted"] = True; notes.append(f"你向他承认了心里的{k}")
    if inner_raised and inp.get("inner_cause"):
        facts["coax_attempts"] = 0; facts["last_coax_at"] = None
    if inp.get("coax"):
        facts["coax_attempts"] = int(facts.get("coax_attempts") or 0) + 1; facts["last_coax_at"] = ts
    apply_floor(st)
    return {"applied": applied, "notes": notes}


def record_fact(b, facts, fact: dict, now):
    t = parse_iso(fact.get("at")) or now
    t = min(t, now)
    typ = fact.get("type")
    if typ in ("user_message", "his_message", "her_message"):   # user_message 为新名；her_message 旧名仍可用（库列名 last_her_msg_at 不改）
        prev = parse_iso(facts.get("last_her_msg_at"))
        day = sh_day(b, t)
        if facts.get("late_night_day") != day:
            facts["late_night_day"] = day; facts["late_night_min"] = 0
        if sh_hour(b, t) < 6:
            gap = (t - prev) / 60000 if prev is not None else 0
            facts["late_night_min"] = float(facts.get("late_night_min") or 0) + (gap if prev is not None and 0 < gap <= 30 and sh_hour(b, prev) < 6 else 1)
        if prev is None or t >= prev:
            facts["last_her_msg_at"] = iso(t)
    elif typ == "browse":
        lst = jload(facts.get("browse_json"), []) or []
        lst.insert(0, {"at": iso(t), "data": fact.get("data")})
        facts["browse_json"] = jdump(lst[:20])
    else:
        raise ValueError("fact.type 只能是 user_message（旧名 her_message）/ browse。")


def s_label(v):
    return "非常" if v >= 80 else "明显" if v >= 60 else "有点" if v >= 40 else "一点"


def ago(ts, now):
    t = parse_iso(ts)
    if not t:
        return ""
    h = (now - t) / H
    return "刚才" if h < 1 else f"{round(h)}小时前" if h < 24 else f"{round(h / 24)}天前"


def facts_summary(b, facts, now):
    parts = []
    her = parse_iso(facts.get("last_her_msg_at"))
    if her:
        h = (now - her) / H
        parts.append("他刚还在说话" if h < 1 else f"他已经{str(round(h)) + '小时' if h < 24 else str(round(h / 24)) + '天'}没说话")
    if float(facts.get("late_night_min") or 0) >= 10 and facts.get("late_night_day") == sh_day(b, now):
        parts.append(f"今天凌晨他在线约{round(facts['late_night_min'])}分钟")
    if int(facts.get("coax_attempts") or 0) > 0:
        parts.append(f"这回他哄了你{facts['coax_attempts']}次（上次{ago(facts.get('last_coax_at'), now)}）")
    return "；".join(parts)


def prompt_line(b, st, facts, now, allow_dims=None):
    dims = [d for d in DIMS if (allow_dims is None or d in allow_dims) and dim_on(b, d)]
    surf = sorted([d for d in dims if st[d]["surface"] >= 40 and st[d]["surface"] - dim_conf(b, d)[2] >= 10], key=lambda d: -st[d]["surface"])[:2]
    inner = sorted([d for d in dims if st[d]["inner"] >= 40 and not st[d]["admitted"]], key=lambda d: -st[d]["inner"])
    admitted = [d for d in dims if st[d]["inner"] >= 40 and st[d]["admitted"]]
    s = "现在的我："
    s += ("表面" + "、".join(f"{s_label(st[d]['surface'])}{d}（{round(st[d]['surface'])}）" for d in surf)) if surf else "表面挺平静"
    if inner:
        d = inner[0]; c = st[d]["inner_cause"]
        s += (f"；心里{d}还压着（{round(st[d]['inner'])}{'，因为' + c if c else ''}{'，' + ago(st[d]['inner_since'], now) + '起' if st[d]['inner_since'] else ''}"
              "，没说出口）——语气里会漏一点，要不要翻出来、要不要承认，你自己决定")
    elif admitted:
        s += f"；心里的{'、'.join(admitted)}已经跟他说过了，还没完全过去"
    else:
        s += "；心里挺平静"
    f = facts_summary(b, facts, now)
    if f:
        s += f"。事实：{f}"
    return s + "。"


def vals(st):
    return {d: {"surface": _r1(st[d]["surface"]), "inner": _r1(st[d]["inner"])} for d in DIMS}


# —— DB ——

def _load(b, pid, now):
    st = default_state()
    for r in b.db.q("SELECT * FROM emotion_state WHERE persona_id=?", (pid,)):
        if r["dim"] in DIMS:
            st[r["dim"]] = {"surface": float(r["surface"]), "inner": float(r["inner"]), "inner_cause": r["inner_cause"], "inner_since": r["inner_since"], "admitted": bool(r["admitted"])}
    f = b.db.one("SELECT * FROM emotion_facts WHERE persona_id=?", (pid,))
    facts = default_facts(now)
    if f:
        facts.update({k: f[k] for k in facts if k in f.keys()})
    return st, facts


def _save(b, pid, st, facts, now):
    ts = iso(now)
    b.db.many("""INSERT INTO emotion_state (persona_id, dim, surface, inner, inner_cause, inner_since, admitted, updated_at) VALUES (?,?,?,?,?,?,?,?)
                 ON CONFLICT(persona_id, dim) DO UPDATE SET surface=excluded.surface, inner=excluded.inner, inner_cause=excluded.inner_cause,
                 inner_since=excluded.inner_since, admitted=excluded.admitted, updated_at=excluded.updated_at""",
              [(pid, d, st[d]["surface"], st[d]["inner"], st[d]["inner_cause"], st[d]["inner_since"], 1 if st[d]["admitted"] else 0, ts) for d in DIMS])
    b.db.x("""INSERT INTO emotion_facts (persona_id, last_tick_at, last_her_msg_at, late_night_min, late_night_day, coax_attempts, last_coax_at, browse_json, last_snapshot_day, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(persona_id) DO UPDATE SET last_tick_at=excluded.last_tick_at, last_her_msg_at=excluded.last_her_msg_at,
              late_night_min=excluded.late_night_min, late_night_day=excluded.late_night_day, coax_attempts=excluded.coax_attempts, last_coax_at=excluded.last_coax_at,
              browse_json=excluded.browse_json, last_snapshot_day=excluded.last_snapshot_day, updated_at=excluded.updated_at""",
           (pid, facts["last_tick_at"], facts["last_her_msg_at"], facts["late_night_min"], facts["late_night_day"], facts["coax_attempts"],
            facts["last_coax_at"], facts["browse_json"], facts["last_snapshot_day"], ts))
    # 曲线：最多每 10 分钟一个点
    last = b.db.one("SELECT at FROM emotion_series WHERE persona_id=? ORDER BY id DESC LIMIT 1", (pid,))
    if not last or now - (parse_iso(last["at"]) or 0) >= 600_000:
        b.db.x("INSERT INTO emotion_series(persona_id, at, values_json) VALUES (?,?,?)", (pid, ts, jdump(vals(st))))


def view(b, st, facts, now, allow_dims=None):
    return {"dims": {d: {"surface": _r1(st[d]["surface"]), "inner": _r1(st[d]["inner"]), "inner_cause": st[d]["inner_cause"],
                         "inner_since": st[d]["inner_since"], "admitted": st[d]["admitted"]} for d in DIMS},
            "facts": {**{k: facts.get(k) for k in ("last_her_msg_at", "late_night_min", "late_night_day", "coax_attempts", "last_coax_at")},
                      "last_user_msg_at": facts.get("last_her_msg_at")},
            "facts_text": facts_summary(b, facts, now), "prompt_line": prompt_line(b, st, facts, now, allow_dims), "settled_at": facts["last_tick_at"]}


def _with(b, pid, now, fn):
    st, facts = _load(b, pid, now)
    settle(b, st, facts, now)
    out = fn(st, facts)
    day = sh_day(b, now)
    if facts.get("last_snapshot_day") != day:
        b.db.x("INSERT INTO emotion_snapshots(persona_id, day, values_json) VALUES (?,?,?) ON CONFLICT(persona_id, day) DO UPDATE SET values_json=excluded.values_json",
               (pid, day, jdump(vals(st))))
        facts["last_snapshot_day"] = day
    _save(b, pid, st, facts, now)
    return out


def state(b, pid=None, now=None, allow_dims=None):
    pid = pid or b.primary
    now = now or now_ms()
    return {"enabled": b.module_on("emotion", pid), **_with(b, pid, now, lambda st, f: view(b, st, f, now, allow_dims))}


def apply(b, pid, inp: dict, source="api", now=None):
    pid = pid or b.primary
    now = now or now_ms()
    reason = str(inp.get("reason") or "").strip()[:300] or "（没写原因）"

    # 星骸：置信度过滤（反讽 / 玩笑 / 不确定时不改情绪）。没给 confidence 的调用（工作台、老插件）照旧生效
    try:
        from . import starhalo as SH
        cmin = float(SH.conf(b).get("confidence_min", 0.6)) if SH.on(b) else 0.0
        cf = inp.get("confidence")
        if cf is not None and cmin > 0 and float(cf) < cmin:
            return {"ok": True, "applied": {}, "skipped": "low_confidence", "notes": [f"置信度 {float(cf):.2f} < {cmin}，这次不改情绪"],
                    "text": "置信度不够（可能是反话/玩笑），情绪不变。", **state(b, pid, now)}
    except (TypeError, ValueError):
        pass

    def fn(st, facts):
        before = vals(st)
        r = apply_changes(st, facts, {**inp, "reason": reason}, now, b)
        after = vals(st)
        b.db.x("INSERT INTO emotion_events VALUES (?,?,?,?,?,?,?,?)",
               (new_id("e_"), pid, source, jdump({"changes": inp.get("changes"), "inner_cause": inp.get("inner_cause"), "addressed_cause": bool(inp.get("addressed_cause")),
                                                  "admit": inp.get("admit") or [], "coax": bool(inp.get("coax")), "applied": r["applied"]}), reason, jdump(before), jdump(after), iso(now)))
        if r["applied"]:
            txt = "已更新：" + "；".join(
                f"{d} 表面{('+' if a.get('surface', 0) > 0 else '') + str(a['surface']) if 'surface' in a else '±0'}→{round(st[d]['surface'])} "
                f"心里{('+' if a.get('inner', 0) > 0 else '') + str(a['inner']) if 'inner' in a else '±0'}→{round(st[d]['inner'])}" for d, a in r["applied"].items())
        else:
            txt = "数值没有变化。"
        fs = facts_summary(b, facts, now)
        return {"ok": True, "text": "\n".join(x for x in [txt, *r["notes"], fs and "事实：" + fs, prompt_line(b, st, facts, now)] if x),
                "applied": r["applied"], "notes": r["notes"], **view(b, st, facts, now)}
    return _with(b, pid, now, fn)


def fact(b, pid, f: dict, now=None):
    now = now or now_ms()
    return _with(b, pid or b.primary, now, lambda st, facts: (record_fact(b, facts, f, now), {"ok": True, "facts": view(b, st, facts, now)["facts"]})[1])


def import_values(b, pid, values: dict, now=None):
    now = now or now_ms()
    def fn(st, facts):
        n = b.db.one("SELECT COUNT(*) n FROM emotion_events WHERE persona_id=?", (pid,))["n"]
        if n:
            return {"ok": True, "imported": False, "reason": "已有情绪记录，不覆盖"}
        for k, v in (values or {}).items():
            if k in DIMS:
                try: st[k]["surface"] = _clamp(float(v))
                except (TypeError, ValueError): pass
        apply_floor(st)
        b.db.x("INSERT INTO emotion_events VALUES (?,?,?,?,?,?,?,?)", (new_id("e_"), pid, "import", jdump(values), "从旧情绪数值导入表面初值", "{}", jdump(vals(st)), iso(now)))
        return {"ok": True, "imported": True, **view(b, st, facts, now)}
    return _with(b, pid, now, fn)


def events(b, pid, limit=30):
    pid = pid or b.primary
    rows = b.db.q("SELECT * FROM emotion_events WHERE persona_id=? ORDER BY created_at DESC LIMIT ?", (pid, max(1, min(200, limit))))
    snaps = b.db.q("SELECT day, values_json FROM emotion_snapshots WHERE persona_id=? ORDER BY day DESC LIMIT 14", (pid,))
    return {"events": [{"id": e["id"], "source": e["source"], "reason": e["reason"], "created_at": e["created_at"], "changes": jload(e["changes_json"]),
                        "before": jload(e["before_json"]), "after": jload(e["after_json"])} for e in rows],
            "snapshots": [{"day": s["day"], "values": jload(s["values_json"])} for s in snaps]}


# —— 激素层 ——

def bio_load(b, pid, now=None):
    now = now or now_ms()
    lv = {h: float(hormone_conf(b, h)[0]) for h in HORMONES}
    upd = {}
    for r in b.db.q("SELECT * FROM bio_state WHERE persona_id=?", (pid,)):
        if r["hormone"] in HORMONES:
            lv[r["hormone"]] = float(r["level"]); upd[r["hormone"]] = parse_iso(r["updated_at"]) or now
    for h in HORMONES:
        base, half, _w, on = hormone_conf(b, h)
        if not on:
            lv[h] = base; continue
        t = upd.get(h, now)
        dm = max(0, (now - t) / 60000)
        lv[h] = base + (lv[h] - base) * 0.5 ** (dm / half)
    return lv


def bio_save(b, pid, lv, now=None):
    now = now or now_ms()
    ts = iso(now)
    b.db.many("INSERT INTO bio_state(persona_id, hormone, level, updated_at) VALUES (?,?,?,?) ON CONFLICT(persona_id, hormone) DO UPDATE SET level=excluded.level, updated_at=excluded.updated_at",
              [(pid, h, _clamp(v), ts) for h, v in lv.items()])


def bio_line(lv):
    hi = sorted([(h, v - HORMONES[h][0]) for h, v in lv.items()], key=lambda x: -abs(x[1]))  # 显示仍按原始基线
    parts = [f"{h}{'偏高' if d > 0 else '偏低'}" for h, d in hi if abs(d) >= 12][:3]
    return "体内：" + ("、".join(parts) if parts else "平稳")


def arousal_level(b, pid) -> float:
    """0..1 的唤醒度：多巴胺/肾上腺素/皮质醇偏离基线越多越高。召回情绪增益只用它乘一次。"""
    if not b.module_on("emotion", pid):
        return 0.0
    lv = bio_load(b, pid)
    dev = sum(abs(lv[h] - hormone_conf(b, h)[0]) for h in ("多巴胺", "肾上腺素", "皮质醇") if hormone_conf(b, h)[3])
    return max(0.0, min(1.0, dev / 90))


def bio_event(b, pid, payload: dict, now=None) -> dict:
    """兼容旧 /bio/event：{type, intensity?, chat_id?, hormones?{}, emotions?{}}，多余字段忽略。"""
    pid = pid or b.primary
    now = now or now_ms()
    typ = str(payload.get("type") or payload.get("event") or payload.get("kind") or "message").strip()
    typ = ALIASES.get(typ, typ)
    try:
        k = float(payload.get("intensity", payload.get("strength", 1)) or 1)
    except (TypeError, ValueError):
        k = 1.0
    k = max(0.0, min(3.0, k))
    dh, de = BIO_EVENTS.get(typ, ({}, {}))
    dh = {**dh, **{h: v for h, v in (payload.get("hormones") or {}).items() if h in HORMONES}}
    de = {**de, **{d: v for d, v in (payload.get("emotions") or {}).items() if d in DIMS}}
    lv = bio_load(b, pid, now)
    for h, v in dh.items():
        _hb, _hh, hw, hon = hormone_conf(b, h)
        if not hon:
            continue
        try: lv[h] = _clamp(lv[h] + float(v) * k * hw)
        except (TypeError, ValueError): pass
    bio_save(b, pid, lv, now)
    b.db.x("INSERT INTO bio_events(persona_id, chat_id, type, intensity, payload, created_at) VALUES (?,?,?,?,?,?)",
           (pid, str(payload.get("chat_id") or ""), typ, k, jdump(payload)[:2000], iso(now)))
    out = {"ok": True, "type": typ, "hormones": {h: _r1(v) for h, v in lv.items()}, "line": bio_line(lv)}
    if b.module_on("emotion", pid):
        if typ == "message":
            fact(b, pid, {"type": "user_message", "at": payload.get("at")}, now)
        changes = {d: round(v * k) for d, v in de.items() if round(v * k)}
        # 激素持续偏离 → 慢慢渗进心里（每次事件最多 +2）
        cort = lv["皮质醇"] - hormone_conf(b, "皮质醇")[0]
        if cort > 25:
            changes.setdefault("生气", 0)
            changes["生气"] = {"surface": changes["生气"] if isinstance(changes["生气"], (int, float)) else 0, "inner": 2}
        if changes or typ == "comfort":
            r = apply(b, pid, {"changes": changes, "reason": payload.get("reason") or f"bio:{typ}", "coax": typ == "comfort"}, source="bio", now=now)
            out["emotion"] = {"applied": r["applied"], "prompt_line": r["prompt_line"]}
    _bio_series(b, pid, lv, now)
    return out


def _bio_series(b, pid, lv, now):
    last = b.db.one("SELECT at FROM emotion_series WHERE persona_id=? ORDER BY id DESC LIMIT 1", ("bio:" + pid,))
    if not last or now - (parse_iso(last["at"]) or 0) >= 300_000:
        b.db.x("INSERT INTO emotion_series(persona_id, at, values_json) VALUES (?,?,?)", ("bio:" + pid, iso(now), jdump({h: _r1(v) for h, v in lv.items()})))


def bio_state(b, pid=None):
    pid = pid or b.primary
    lv = bio_load(b, pid)
    _bio_series(b, pid, lv, now_ms())
    return {"ok": True, "hormones": {h: {"level": _r1(v), "base": hormone_conf(b, h)[0], "half_life_min": hormone_conf(b, h)[1], "enabled": hormone_conf(b, h)[3]} for h, v in lv.items()},
            "arousal": round(arousal_level(b, pid), 3), "line": bio_line(lv)}


def cron(b, now=None):
    now = now or now_ms()
    out = {}
    for pid in (b.cfg.get("emotion_personas") or [b.primary]):
        if b.module_on("emotion", pid):
            out[pid] = state(b, pid, now)["prompt_line"]
    return out
