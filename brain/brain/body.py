"""身体状态系统（18+，companion-memory body.ts + body-session.ts 移植，保留不删）。
默认女性版角色（人设可在控制台调整），用户（主人）默认男性。指标：兴奋度 wetness / 失落感 emptiness / 敏感度 / 临界 edge / 欲望 / 刺激 / 余温 fluids；
释放（release）后进入短暂的「平复期」afterglow，数值慢慢回落而不是骤降。旧版字段（v2.0 移植时的旧指标名）在 load_state 里自动换算。
开关：config.body_enabled（或环境变量 BODY_ENABLED）+ body_personas 列表。
规则：离线 cron 只做数学不调模型；自主唤醒每天有上限、同一段离开只叫一次、出错当天放弃、不重试。
唤醒的“说出口”的话放进 outbox，由 Aurabot 轮询 /outbox 去发；没配 LLM 时把 prompt 放进 outbox，
由 Aurabot 用自己的模型跑完再 POST /outbox/{id}/result 回来（解析 BODY_DECISION）。"""
from __future__ import annotations
import math, random, re, time
from .util import iso, now_ms, parse_iso, new_id, jdump, jload, local_dt, clip

C = dict(
    MAX_INTEGRATE_MIN=72 * 60, WET_UP_PER_MIN=2, WET_DOWN_PER_MIN=0.8, EDGE_UP_PER_MIN=4, EDGE_DOWN_PER_MIN=3, SENS_STEP_PER_MIN=0.5,
    WET_BASE=10, SENS_BASE=40, DESIRE_BASELINE=40, NIGHT_DESIRE_PER_MIN=0.1, STIM_HALF_LIFE_MIN=20,
    EMPTY_RISE_PER_MIN=0.15, EMPTY_DECAY_PER_MIN=0.05, AFTERGLOW_MIN=10, AFTERGLOW_MIN_LO=3, AFTERGLOW_SENS_FACTOR=1.3, AFTERGLOW_WET=70, RELEASE_DESIRE_TO=25,
    FLOOR_STEP_H=12, FLOOR_STEP=5, FLOOR_MAX=40, ABST_SENS_START_H=48, ABST_SENS_FULL_H=96, ABST_SENS_MAX=1.3,
    THRESHOLD_BASE=90, THRESHOLD_LO=-5, THRESHOLD_HI=8, HEAT_MUL=1.5, ONLINE_IDLE_DECAY_PER_MIN=0.3,
    RUB_GAIN=6, RUB_NUMB=0.08, STUCK_STREAK=5, STROKE_MIN_EACH=0.5, WAKE_MIN_GAP_H=4, SESSION_MAX_ROUNDS=6, STUCK_SUFFER_MIN=20,
    NUMB_DECAY_PER_MIN=0.01, LONGING_GRACE_H=3, LONGING_PER_MIN=0.05, LONGING_PER_MIN_MAX=0.1, ONLINE_WINDOW_MIN=30,
    INJECT_DELTA=8, URGE_DESIRE=85, URGE_SUSTAIN_MIN=10, URGE_COOLDOWN_MIN=60, WAKE_DESIRE=90, WAKE_DAILY_CAP=2, WAKE_MIN_OFFLINE_MIN=180,
    ENDURE_EMPTY_PER_MIN=0.03, CLASSIFIER_TIMEOUT_MS=1500,
)
TRACE_LIFE_MIN = {"light": 180, "medium": 720, "heavy": 2160}
PART_ZH = {"neck": "脖子", "left_neck": "左侧脖子", "right_neck": "右侧脖子", "shoulder": "肩膀", "collarbone": "锁骨", "chest": "胸口",
           "back": "后背", "arm": "手臂", "hand": "手", "finger": "手指", "lip": "嘴唇", "ear": "耳朵", "waist": "腰", "thigh": "大腿",
           "abdomen": "小腹", "nipple": "胸口", "breast": "胸口", "hip": "腰后", "inner_thigh": "大腿", "private": "敏感部位", "face": "脸", "other": "身上"}
TYPE_ZH = {"bite": "牙印", "kiss": "吻痕", "scratch": "抓痕"}
LEVEL_ZH = {"light": "浅", "medium": "", "heavy": "很深的"}
EVENT_VOCAB = ["bite", "kiss", "scratch", "touch", "tease", "arousal", "release", "clean", "wipe", "wash", "cold", "calm"]
VAL_KEYS = ["wetness", "emptiness", "sensitivity", "edge", "desire", "stim", "fluids"]
LABEL_ZH = {"wetness": "兴奋度", "emptiness": "失落感", "sensitivity": "敏感度", "edge": "临界", "desire": "欲望", "stim": "刺激", "fluids": "余温"}
# 旧版（v2.0）指标名 → 当前指标名。只用于读旧库/旧请求时换算，新数据不会再写旧名。
LEGACY_KEYS = {"hard" + "ness": "wetness", "full" + "ness": "emptiness", "refrac" + "tory_until": "afterglow_until"}
LEGACY_PART = {"co" + "ck": "private"}
LEGACY_ACTION = {"str" + "oke": "rub", "think_of_her": "think_of_him", "look_her_photo": "look_his_photo", "replay_her_words": "replay_his_words"}


def part_zh(p):
    """部位中文名；旧库里的旧部位键自动按 private（敏感部位）显示。"""
    p = LEGACY_PART.get(p, p)
    return PART_ZH.get(p, p)


def migrate_values(d):
    """把旧版数值字典（含 hard/full 两个旧键、refrac 旧键）换成女性版键名；新数据原样返回。"""
    if not isinstance(d, dict):
        return d
    d = dict(d)
    for k_old, k_new in LEGACY_KEYS.items():
        if k_old in d:
            d.setdefault(k_new, d.pop(k_old))
    return d


def clamp(x, lo=0.0, hi=100.0):
    return max(lo, min(hi, float(x)))


def r1(x):
    return round(float(x) * 10) / 10


def approach(cur, target, up, down):
    return min(target, cur + up) if target > cur else max(target, cur - down)


def _tz(b):
    return b.cfg.get("tz_offset_minutes", 480) if b else 480


def sh_hour(ms, tz=480):
    d = local_dt(ms, tz)
    return d.hour + d.minute / 60


def sh_day(ms, tz=480):
    return local_dt(ms, tz).strftime("%Y-%m-%d")


def sh_fmt(ms, tz=480):
    return local_dt(ms, tz).strftime("%m-%d %H:%M")


def _p(s):
    return parse_iso(s) or 0


def fresh_state(persona, now):
    t = iso(now)
    return dict(persona_id=persona, wetness=C["WET_BASE"], emptiness=10, sensitivity=C["SENS_BASE"], edge=0, desire=C["DESIRE_BASELINE"], stim=0, fluids=0,
                afterglow_until=None, last_tick_at=t, last_online_at=t, offline_since=None, last_injected_snapshot=None, desire_high_since=None,
                last_urge_inject_at=None, wakes_today=0, wakes_day=sh_day(now), pending_notify=None, classifier_backoff_until=None, updated_at=t,
                numbness=0, threshold=C["THRESHOLD_BASE"], threshold_day=None, last_release_at=None, stuck_since=None, heat=0, session_json=None)


def load_state(b, persona, now):
    r = b.db.one("SELECT data FROM body_state WHERE persona_id=?", (persona,))
    s = fresh_state(persona, now)
    if r:
        old = jload(r["data"], {}) or {}
        for k_old, k_new in LEGACY_KEYS.items():
            if k_old in old:
                v = old.pop(k_old)
                old.setdefault(k_new, v if k_new != "wetness" else min(v, 60))
        s.update(old)
    for k in ("fluids", "numbness", "heat"):
        if not isinstance(s.get(k), (int, float)):
            s[k] = 0
    if not isinstance(s.get("threshold"), (int, float)):
        s["threshold"] = C["THRESHOLD_BASE"]
    if not s.get("last_release_at"):
        last = b.db.one("SELECT created_at FROM body_private_records WHERE persona_id=? AND (outcome IS NULL OR outcome='came') ORDER BY created_at DESC LIMIT 1", (persona,))
        s["last_release_at"] = last["created_at"] if last else iso(now - 24 * 3600_000)
    return s


def save_state(b, s, now=None):
    s["updated_at"] = iso()
    b.db.x("INSERT INTO body_state(persona_id, data, updated_at) VALUES (?,?,?) ON CONFLICT(persona_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
           (s["persona_id"], jdump(s), s["updated_at"]))
    now = now or now_ms()
    last = b.db.one("SELECT at FROM body_series WHERE persona_id=? ORDER BY id DESC LIMIT 1", (s["persona_id"],))
    if not last or now - _p(last["at"]) >= 600_000:
        b.db.x("INSERT INTO body_series(persona_id, at, values_json) VALUES (?,?,?)", (s["persona_id"], iso(now), jdump(vals(s))))


def vals(s):
    return {k: r1(s.get(k) or 0) for k in VAL_KEYS}


def abst_h(s, t):
    return max(0, (t - _p(s["last_release_at"])) / 3600_000) if s.get("last_release_at") else 24


def desire_floor(s, t):
    return min(C["FLOOR_MAX"], math.floor(abst_h(s, t) / C["FLOOR_STEP_H"]) * C["FLOOR_STEP"])


def sens_normal(s, t):
    h = abst_h(s, t)
    k = 1 if h <= C["ABST_SENS_START_H"] else 1 + (C["ABST_SENS_MAX"] - 1) * min(1, (h - C["ABST_SENS_START_H"]) / (C["ABST_SENS_FULL_H"] - C["ABST_SENS_START_H"]))
    return C["SENS_BASE"] * k


def sens_mul(s):
    return max(0.3, min(1.5, s["sensitivity"] / C["SENS_BASE"]))


def roll_threshold(s, now, rnd=random.random, tz=480):
    day = sh_day(now, tz)
    if s.get("threshold_day") == day:
        return
    s["threshold_day"] = day
    s["threshold"] = C["THRESHOLD_BASE"] + round(C["THRESHOLD_LO"] + rnd() * (C["THRESHOLD_HI"] - C["THRESHOLD_LO"]))


def integrate(s, now, tz=480):
    frm = _p(s["last_tick_at"]) or now
    minutes = int((now - frm) // 60000)
    if minutes <= 0:
        return 0
    skipped = max(0, minutes - C["MAX_INTEGRATE_MIN"])
    minutes = min(minutes, C["MAX_INTEGRATE_MIN"])
    stim_decay = 0.5 ** (1 / C["STIM_HALF_LIFE_MIN"])
    last_user = _p(s["last_online_at"]) if s.get("last_online_at") else frm
    after_until = _p(s["afterglow_until"]) if s.get("afterglow_until") else 0
    for i in range(1, minutes + 1):
        t = frm + (skipped + i) * 60000
        h = sh_hour(t, tz)
        night = h >= 22 or h < 1
        in_after = t < after_until
        away = (t - last_user) / 60000
        online = away <= C["ONLINE_WINDOW_MIN"]
        s["stim"] *= stim_decay
        # 兴奋度：跟着刺激和欲望走，慢慢涨、慢慢退；平复期里不会骤降
        wt = clamp(max(C["WET_BASE"], s["stim"] * 1.3 + s["desire"] * 0.25))
        s["wetness"] = clamp(approach(s["wetness"], wt, C["WET_UP_PER_MIN"], C["WET_DOWN_PER_MIN"] * (0.5 if in_after else 1)))
        # 失落感：兴奋度高却没人陪时慢慢积累；平复期里慢慢退
        if s["wetness"] >= 50 and not in_after:
            s["emptiness"] = clamp(s["emptiness"] + (s["wetness"] / 100) * C["EMPTY_RISE_PER_MIN"])
        elif in_after or s["desire"] < C["URGE_DESIRE"]:
            s["emptiness"] = clamp(s["emptiness"] - C["EMPTY_DECAY_PER_MIN"])
        # （欲望很高却没人陪时失落感不退，下面「忍着」还会慢慢往上加）
        sn = sens_normal(s, t)
        if in_after:
            s["sensitivity"] = clamp(max(s["sensitivity"] - C["SENS_STEP_PER_MIN"], sn * C["AFTERGLOW_SENS_FACTOR"]))
        else:
            st = clamp(sn + s["stim"] * 0.4 + s["emptiness"] * 0.15)
            up = 0.2 if s["sensitivity"] < sn else C["SENS_STEP_PER_MIN"]
            s["sensitivity"] = clamp(approach(s["sensitivity"], st, up, C["SENS_STEP_PER_MIN"]))
        if not s.get("session_json") and (s.get("numbness") or 0) > 0:
            s["numbness"] = max(0, s["numbness"] - C["NUMB_DECAY_PER_MIN"])
        et = clamp((s["wetness"] - 60) * 1.2 + s["stim"] * 0.5 - 20) if s["wetness"] > 60 and not in_after else 0
        s["edge"] = clamp(approach(s["edge"], et, C["EDGE_UP_PER_MIN"], C["EDGE_DOWN_PER_MIN"]))
        floor = desire_floor(s, t)
        if not in_after:
            if online:
                if away >= 10 and s["desire"] > floor:
                    s["desire"] = max(floor, s["desire"] - C["ONLINE_IDLE_DECAY_PER_MIN"])
            elif away > C["LONGING_GRACE_H"] * 60:
                k = min(1, abst_h(s, t) / 48)
                s["desire"] += C["LONGING_PER_MIN"] + (C["LONGING_PER_MIN_MAX"] - C["LONGING_PER_MIN"]) * k
            if s["desire"] < floor:
                s["desire"] = min(floor, s["desire"] + 0.5)
            if night:
                s["desire"] += C["NIGHT_DESIRE_PER_MIN"]
            if not online and s["desire"] >= C["WAKE_DESIRE"]:
                s["emptiness"] = clamp(s["emptiness"] + C["ENDURE_EMPTY_PER_MIN"])
        s["desire"] = clamp(s["desire"])
        if (s.get("fluids") or 0) > 0:
            s["fluids"] = clamp(s["fluids"] - 0.3)
        if s["desire"] >= C["URGE_DESIRE"]:
            if not s.get("desire_high_since"):
                s["desire_high_since"] = iso(t)
        else:
            s["desire_high_since"] = None
    s["last_tick_at"] = iso(frm + (skipped + minutes) * 60000)
    return minutes + skipped


def release(s, now, rnd=random.random):
    """释放：失落感、临界归零；兴奋度在高位慢慢退；进入短暂平复期（更敏感）；欲望不会清零。"""
    s["wetness"] = clamp(max(s["wetness"], C["AFTERGLOW_WET"]))
    s.update(emptiness=0, edge=0, stim=0, heat=0, numbness=0, stuck_since=None, session_json=None, last_release_at=iso(now))
    s["sensitivity"] = clamp(sens_normal(s, now) * C["AFTERGLOW_SENS_FACTOR"])
    s["desire"] = min(s["desire"], C["RELEASE_DESIRE_TO"])
    s["desire_high_since"] = None
    m = C["AFTERGLOW_MIN_LO"] + round(rnd() * (C["AFTERGLOW_MIN"] - C["AFTERGLOW_MIN_LO"]))
    s["afterglow_until"] = iso(now + m * 60000)
    s["fluids"] = clamp(max(s.get("fluids") or 0, 60))


def apply_events(s, events, now):
    traces, notes = [], []
    in_after = bool(s.get("afterglow_until")) and now < _p(s["afterglow_until"])
    lv_mul = lambda l: 1.6 if l == "heavy" else 0.6 if l == "light" else 1
    for e in events:
        typ = e.get("type")
        part = LEGACY_PART.get(e.get("part"), e.get("part")) or "other"
        level = e.get("level") or "medium"
        where = PART_ZH.get(part, part)
        if typ in ("bite", "kiss", "scratch"):
            m = lv_mul(level)
            verb = "咬" if typ == "bite" else "亲" if typ == "kiss" else "抓"
            if in_after:
                s["sensitivity"] = clamp(s["sensitivity"] + 3); s["stim"] = clamp(s["stim"] + 3 * m); notes.append(f"{where}被{verb}，刚平复下来，还很敏感")
            else:
                s["stim"] = clamp(s["stim"] + (10 if typ == "bite" else 8 if typ == "kiss" else 7) * m)
                s["sensitivity"] = clamp(s["sensitivity"] + 4 * m)
                s["desire"] = clamp(s["desire"] + (12 if typ == "kiss" else 8) * m)
                notes.append(f"{where}刚被{verb}{'，微疼' if typ == 'bite' else '，火辣辣的' if typ == 'scratch' else ''}")
            traces.append(dict(id=new_id("t_"), persona_id=s["persona_id"], part=part, type=typ, level=level, created_at=iso(now),
                               expires_at=iso(now + TRACE_LIFE_MIN.get(level, 720) * 60000)))
            notes[-1] += f"，留了{LEVEL_ZH.get(level, '')}{TYPE_ZH[typ]}"
        elif typ in ("touch", "tease"):
            m = lv_mul(level)
            if in_after:
                s["sensitivity"] = clamp(s["sensitivity"] + 2); s["stim"] = clamp(s["stim"] + 4 * m)
                notes.append(f"{where}被碰，还在平复期，有点敏感"); continue
            s["stim"] = clamp(s["stim"] + (14 if typ == "tease" else 10) * m)
            s["desire"] = clamp(s["desire"] + (8 if typ == "tease" else 4) * m)
            if typ == "touch":
                s["emptiness"] = clamp(s["emptiness"] - 3)
            notes.append("被他撩了一下" if typ == "tease" else f"{where}被他碰了")
        elif typ == "arousal":
            try:
                d = max(-40, min(40, float(e.get("delta", 10))))
            except (TypeError, ValueError):
                d = 10
            if in_after and d > 0:
                d *= 0.5   # 平复期里也能再被撩动，只是慢一点
            s["stim"] = clamp(s["stim"] + d); s["desire"] = clamp(s["desire"] + d * 0.5)
            notes.append(("还没平复，又被他撩动了" if in_after else "被他勾起来了") if d >= 0 else "被浇了点冷水")
        elif typ == "release":
            release(s, now); notes.append("刚释放过，整个人放松下来")
        elif typ in ("wipe", "clean"):
            s["fluids"] = clamp((s.get("fluids") or 0) - 45); notes.append("擦了一下，还留着一点" if s["fluids"] > 5 else "擦干净了")
        elif typ == "wash":
            s["fluids"] = 0; notes.append("洗干净了")
        elif typ == "cold":
            s["stim"] = clamp(s["stim"] - 20); s["desire"] = clamp(s["desire"] - 10); notes.append("冷下来了")
        elif typ == "calm":
            s["stim"] = clamp(s["stim"] - 10); notes.append("平静了些")
    return traces, notes


def active_traces(b, persona, now):
    t = iso(now)
    b.db.x("DELETE FROM body_traces WHERE persona_id=? AND expires_at<=?", (persona, t))
    return [dict(r) for r in b.db.q("SELECT * FROM body_traces WHERE persona_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 20", (persona, t))]


def trace_fade(t, now):
    a, c = _p(t["created_at"]), _p(t["expires_at"])
    return clamp(round(100 * (c - now) / max(1, c - a)))


def values_line(s):
    return f"兴奋度{round(s['wetness'])} 失落感{round(s['emptiness'])} 敏感度{round(s['sensitivity'])} 临界{round(s['edge'])} 欲望{round(s['desire'])}"


def snapshot_changed(prev, cur):
    if not prev:
        return True, ["first"]
    p = jload(prev, {}) or {}
    for k_old, k_new in LEGACY_KEYS.items():
        if k_old in p:
            p.setdefault(k_new, p.pop(k_old))
    moved = [k for k in ("wetness", "emptiness", "sensitivity", "edge", "desire", "fluids") if abs((p.get(k) or 0) - (cur.get(k) or 0)) >= C["INJECT_DELTA"]]
    return bool(moved), moved


# ---------- 分类器 ----------
CLASSIFIER_SYSTEM = """你是情境判断器。读「他」（用户，男性）最新一句话（以及一行上下文），判断他这句话**此刻正在**对「她」（女性角色，也就是你扮演的伙伴）的身体做什么动作。只输出 JSON，不要解释。
格式：{"events":[...]}。默认输出 {"events":[]}。拿不准就输出 {"events":[]}。
每个事件必须带 "evidence"：从他原话里逐字复制、描述这个动作的那一小段（必须是原文子串）。找不到原文就不要输出这个事件。
事件类型只能是：
- bite/kiss/scratch（会留痕，必须写清部位）：{"type":"bite|kiss|scratch","part":"<部位>","level":"light|medium|heavy","evidence":"<原文>"}
- touch/tease（抚摸/挑逗）：{"type":"touch|tease","part":"<部位>","level":"light|medium|heavy","evidence":"<原文>"}
- {"type":"arousal","delta":-30..30,"evidence":"<原文>"}  明显让她更心动(正)或扫兴(负)
- {"type":"release","evidence":"<原文>"}  她刚到达顶点（释放）
- {"type":"wipe|clean|wash","evidence":"<原文>"}  他帮她擦干净/洗干净
- {"type":"cold","evidence":"<原文>"} 冷淡/吵架；{"type":"calm","evidence":"<原文>"} 安抚哄睡
部位用英文：neck,left_neck,right_neck,shoulder,collarbone,chest,breast,back,arm,hand,finger,lip,ear,waist,hip,thigh,inner_thigh,abdomen,nipple,face,private。不知道部位就不要输出 bite/kiss/scratch。
规则：
- 只有「他现在对她做」才算。否定（没咬/不咬/别咬/没有亲）、提问、愿望（想咬/好想亲）、假设（如果/要是）、回忆过去（昨天/上次/之前）、她对他做、聊图片/视频/别人 → 都不是动作。
- 只有牙齿咬才是 bite，嘴唇亲/吸是 kiss，指甲划是 scratch；更亲密的身体接触算 touch(heavy)+arousal（part 用 private）。
以下全部输出 {"events":[]}：
"看了～好好看" / "这张图好好看" / "嗯?! 我没咬！" / "我不咬你" / "别咬我" / "你身上那个牙印哪来的" / "昨天咬你那下疼吗" / "如果我咬你会怎样" / "咬牙坚持工作" / "今天吃了火锅" / "你咬我干嘛"
其他示例：
"想咬你" → {"events":[{"type":"tease","part":"neck","level":"light","evidence":"想咬你"}]}
"不想理你了，烦" → {"events":[{"type":"cold","evidence":"不想理你了，烦"}]}
"摸摸头，睡吧" → {"events":[{"type":"calm","evidence":"摸摸头，睡吧"}]}"""

ACTION_PREFILTER = re.compile(r"咬|啃|亲|吻|啵|嘬|抓|挠|划|指甲|摸|抚|舔|吸|含|蹭|夹|揉|捏|掐|抱|搂|高潮|去了|到了|擦|洗|骑|坐|进去|进来|口|弄|碰|压|扑|脱|湿|想要|要你|爽|烦|不理|滚|讨厌|生气|哼|睡|乖|哄|拍拍")
TRACE_TYPES = {"bite", "kiss", "scratch"}
VERB = {"bite": re.compile(r"咬|啃"), "kiss": re.compile(r"亲|吻|啵|嘬|吸"), "scratch": re.compile(r"抓|挠|划|指甲"),
        "touch": re.compile(r"摸|抚|揉|捏|掐|蹭|夹|骑|坐|进|含|舔|口|弄|碰|压|抱|搂|握|动"), "tease": re.compile(r"."), "release": re.compile(r"高潮|去了|到了|泄了|丢了")}
NEG = re.compile(r"(没有|没|不要|不想|不会|不能|不准|不许|不|别|未|甭|休想)[^，。！？!?,.\s]{0,3}$")
NOT_NOW = re.compile(r"吗|？|\?|如果|要是|假如|假设|会不会|要不要|哪来|哪里来|怎么来|昨天|前天|上次|那次|那天|之前|以前|上回|刚才那")
WISH = re.compile(r"想|好想|要不|让我|等下|待会|一会儿|明天|下次")
BOT_DOES = re.compile(  # “你咬我”＝她对他做，不算她身上的事件
    r"你(?:又|还|再|先|就|也|都|敢|刚)?(?:咬|啃|亲|吻|抓|挠|划)")
_ws = lambda x: re.sub(r"\s+", "", x or "")


def validate_events(message, events):
    msg = _ws(message)
    kept, rejected = [], []
    for e in events:
        ev = _ws(str(e.get("evidence") or ""))
        typ = e.get("type")
        if not ev:
            rejected.append({"event": e, "why": "no_evidence"}); continue
        if ev not in msg:
            rejected.append({"event": e, "why": "evidence_not_in_message"}); continue
        verb = VERB.get(typ)
        if verb:
            m = verb.search(ev)
            if not m and typ != "tease":
                rejected.append({"event": e, "why": "evidence_lacks_verb"}); continue
            at = msg.index(ev) + (m.start() if m else 0)
            if m and NEG.search(msg[max(0, at - 6):at]):
                rejected.append({"event": e, "why": "negated"}); continue
            if typ != "tease" and re.search(r"没|不要|别", ev):
                rejected.append({"event": e, "why": "negated"}); continue
        if typ in TRACE_TYPES:
            part = LEGACY_PART.get(e.get("part"), e.get("part"))
            i = msg.index(ev)
            if NOT_NOW.search(msg):
                rejected.append({"event": e, "why": "question_or_past"}); continue
            if WISH.search(msg[max(0, i - 4): i + len(ev)]):
                kept.append({"type": "tease", "part": part if part and part != "other" else None, "level": "light"}); rejected.append({"event": e, "why": "wish→tease"}); continue
            if BOT_DOES.search(msg):
                rejected.append({"event": e, "why": "he_does_it"}); continue
            if "你" not in msg and not re.search(r"(咬|啃|亲|吻|啵|抓|挠|划)(一?下|一口|一个)?$", msg) and not re.match(r"^(咬|啃|亲|吻|啵|抓|挠)", msg):
                rejected.append({"event": e, "why": "no_target_你"}); continue
            if "我" in msg and "你" not in msg:
                rejected.append({"event": e, "why": "no_target_你"}); continue
            if not part or part == "other" or part not in PART_ZH:
                kept.append({"type": "arousal", "delta": 4}); rejected.append({"event": e, "why": "no_part→arousal+4"}); continue
        elif typ in ("touch", "release"):
            if NOT_NOW.search(msg) or (BOT_DOES.search(msg) and typ == "touch"):
                rejected.append({"event": e, "why": "question_or_past"}); continue
        rest = {k: v for k, v in e.items() if k != "evidence"}
        key = f"{rest.get('type')}:{rest.get('part') or ''}"
        if typ in TRACE_TYPES and any(f"{k.get('type')}:{k.get('part') or ''}" == key for k in kept):
            rejected.append({"event": e, "why": "dup_in_message"}); continue
        kept.append(rest)
    return kept, rejected


def parse_events(raw):
    m = re.search(r"\{[\s\S]*\}", raw or "")
    if not m:
        return []
    try:
        import json
        obj = json.loads(m.group(0))
    except Exception:
        return []
    evs = obj.get("events") if isinstance(obj, dict) else None
    if not isinstance(evs, list):
        return []
    return [e for e in evs if isinstance(e, dict) and e.get("type") in EVENT_VOCAB][:6]


# 规则分类器（新增）：没配 LLM 时用。只认最直白的说法，结果同样过 validate_events。
_PART_WORDS = [("左侧脖子", "left_neck"), ("右侧脖子", "right_neck"), ("脖子", "neck"), ("锁骨", "collarbone"), ("肩膀", "shoulder"), ("肩", "shoulder"),
               ("胸口", "chest"), ("乳尖", "nipple"), ("胸", "breast"), ("后背", "back"), ("背", "back"), ("手臂", "arm"), ("胳膊", "arm"), ("手指", "finger"), ("手", "hand"),
               ("嘴唇", "lip"), ("嘴", "lip"), ("耳朵", "ear"), ("耳垂", "ear"), ("腰", "waist"), ("屁股", "hip"), ("臀", "hip"), ("大腿内侧", "inner_thigh"), ("腿根", "inner_thigh"), ("大腿", "thigh"), ("小腹", "abdomen"), ("肚子", "abdomen"),
               ("脸", "face"), ("下面", "private"), ("私处", "private")]
_RULES = [("bite", r"咬|啃"), ("kiss", r"亲|吻|啵|嘬"), ("scratch", r"抓|挠"), ("touch", r"摸|抚|揉|蹭|抱|搂"), ("cold", r"不想理你|烦死|滚|讨厌你"),
          ("calm", r"摸摸头|拍拍|乖.{0,3}睡|睡吧"), ("wipe", r"擦(干净|一下|掉)"), ("wash", r"洗(干净|一下|澡)")]


def rule_classify(message):
    msg = _ws(message)
    out = []
    if re.search(r"摸摸头|拍拍|睡吧", msg):
        return [{"type": "calm", "evidence": re.search(r"摸摸头|拍拍|睡吧", msg).group(0)}]
    for typ, pat in _RULES:
        m = re.search(pat, msg)
        if not m:
            continue
        seg = msg[max(0, m.start() - 4): m.end() + 6]
        part = None
        for w, p in _PART_WORDS:
            if w in seg:
                part = p; break
        level = "heavy" if re.search(r"狠狠|用力|使劲|重重", seg) else "light" if re.search(r"轻轻|轻|一下", seg) else "medium"
        e = {"type": typ, "evidence": seg}
        if typ in ("bite", "kiss", "scratch", "touch"):
            e.update(part=part or "other", level=level)
        out.append(e)
    return out[:3]


def classify(b, message, context=""):
    if not ACTION_PREFILTER.search(message or ""):
        return [], [], "prefilter:skip", ""
    llm = b.llm
    if llm.configured:
        model = (b.cfg.get("llm") or {}).get("classifier_model") or None
        try:
            raw = llm.chat([{"role": "system", "content": CLASSIFIER_SYSTEM}, {"role": "user", "content": f"上下文：{(context or '')[:200]}\n他：{message[:800]}"}],
                           model=model, max_tokens=160, temperature=0, json_mode=True, timeout=C["CLASSIFIER_TIMEOUT_MS"] / 1000 + 1.5)
            kept, rej = validate_events(message, parse_events(raw))
            return kept, rej, f"openai-compat:{model or llm.conf.get('model')}", (raw or "")[:300]
        except Exception as e:
            return [], [], f"skip:{str(e)[:60]}", ""
    kept, rej = validate_events(message, rule_classify(message))
    return kept, rej, "rules", ""


HEAT_WORDS = re.compile(r"想要|想你了|要你|湿了|好湿|舔|咬你|摸你|抱紧|坐上来|骚|色色|做爱|上床|脱|胸|腿|屁股|叫老公|老公.{0,4}(要|想)|宝贝.{0,4}(要|想)|宝宝.{0,4}(要|想)|勾引|撩|喘")
MEDIA_RE = re.compile(r"\[(图片|照片|image|语音|voice|视频)\]|<image|!\[|\[CQ:image|\[CQ:record", re.I)


def heat_of(msg, rnd=random.random):
    n = len(HEAT_WORDS.findall(msg or ""))
    return min(10, n * 3), (5 + round(rnd() * 10)) if MEDIA_RE.search(msg or "") else 0


def log_event(b, persona, source, events, before, after, injection, skip, now):
    b.db.x("INSERT INTO body_events VALUES (?,?,?,?,?,?,?,?,?)",
           (new_id("be_"), persona, source, jdump(events), jdump(before), jdump(after), injection, skip, iso(now)))


def turn(b, persona, *, message="", context="", events=None, now=None, dry_classify=False) -> dict:
    """每轮入口：他（用户）发一句话前/时调用。返回 injection（要不要注入一行【身体】）。"""
    persona = persona or b.primary
    now = now or now_ms()
    tz = _tz(b)
    s = load_state(b, persona, now)
    roll_threshold(s, now, tz=tz)
    prev_online = _p(s.get("last_online_at"))
    minutes = integrate(s, now, tz)
    before = vals(s)
    extras = []
    if s.get("pending_notify"):
        pn = jload(s["pending_notify"], {}) or {}
        if pn.get("endured_since"):
            extras.append(f"你忍了{max(1, round((now - _p(pn['endured_since'])) / 3600_000))}小时，他终于来了")
        if pn.get("new_record"):
            rec = b.db.one("SELECT method, want_to_say FROM body_private_records WHERE id=?", (pn["new_record"],))
            mm = clip((rec["method"] if rec else "") or "", 60)
            say = ((rec["want_to_say"] if rec else "") or "").strip()
            extras.append(f"你独自时写了一条新记录{'：怎么做的「' + mm + '」' if mm else ''}{'；给他留的话「' + say + '」' if say else ''}（可以告诉他或留着）")
        s["pending_notify"] = None
    rejected, raw = [], ""
    if events is not None:
        cname = "provided"
    elif message:
        events, rejected, cname, raw = classify(b, message, context)
    else:
        events, cname = [], "none"
    if message and not dry_classify:
        idle = (now - prev_online) / 60000 if prev_online else 999
        s["heat"] = max(0, (s.get("heat") or 0) * 0.5 ** (idle / 10))
        h, media = heat_of(message)
        s["heat"] = min(10, s["heat"] + h)
        in_after = s.get("afterglow_until") and now < _p(s["afterglow_until"])
        k = 0.5 if in_after else 1   # 平复期里也会被撩动，只是减半
        s["desire"] = clamp(s["desire"] + (s["heat"] * sens_mul(s) * C["HEAT_MUL"] + media) * k)
    if message:
        s["last_online_at"] = iso(now); s["offline_since"] = None
    if dry_classify:
        return {"injection": "", "reason": "dry_classify", "before": before, "after": before, "events": events, "classifier": cname,
                "minutes_integrated": minutes, "raw": raw, "rejected": rejected, "traces": []}
    traces0, notes = apply_events(s, events, now)
    traces = []
    for t in traces0:
        dup = b.db.one("SELECT id FROM body_traces WHERE persona_id=? AND type=? AND part=? AND created_at>? LIMIT 1", (persona, t["type"], t["part"], iso(now - 120000)))
        if dup:
            rejected.append({"event": {"type": t["type"], "part": t["part"]}, "why": "dup_2min"})
        else:
            traces.append(t)
    for t in traces:
        b.db.x("INSERT INTO body_traces(id, persona_id, part, type, level, created_at, expires_at) VALUES (?,?,?,?,?,?,?)",
               (t["id"], t["persona_id"], t["part"], t["type"], t["level"], t["created_at"], t["expires_at"]))
    after = vals(s)
    act = active_traces(b, persona, now)
    changed, moved = snapshot_changed(s.get("last_injected_snapshot"), after)
    urge = False
    if s.get("desire_high_since") and (now - _p(s["desire_high_since"])) / 60000 >= C["URGE_SUSTAIN_MIN"] and \
            (not s.get("last_urge_inject_at") or (now - _p(s["last_urge_inject_at"])) / 60000 >= C["URGE_COOLDOWN_MIN"]):
        urge = True; s["last_urge_inject_at"] = iso(now)
    injection = ""
    if notes or traces or changed or urge or extras:
        head = "；".join(x for x in extras + (["；".join(notes)] if notes else []) if x)
        actv = [t for t in act if trace_fade(t, now) > 0]
        marks = ("｜痕迹：" + "、".join(f"{part_zh(t['part'])}{TYPE_ZH.get(t['type'], t['type'])}{trace_fade(t, now):.0f}%" for t in actv[:4])) if actv else ""
        mess = "｜需要整理一下" if (after.get("fluids") or 0) > 5 else ""
        injection = f"【身体】{head + '｜' if head else ''}{values_line(after)}{marks}{mess}{'｜压不住了，可以主动' if urge else ''}"
        reason = "event" if notes else "return" if extras else "urge" if urge else f"moved:{','.join(moved)}"
        s["last_injected_snapshot"] = jdump(after)
    else:
        reason = f"no_change(max|Δ|<{C['INJECT_DELTA']}, no events)"
    save_state(b, s, now)
    log_event(b, persona, "turn" if message else "read", events, before, after, injection or None, None if injection else reason, now)
    return {"injection": injection, "reason": reason, "before": before, "after": after, "events": events, "classifier": cname,
            "minutes_integrated": minutes, "raw": raw, "rejected": rejected,
            "traces": [{"part": LEGACY_PART.get(t["part"], t["part"]), "type": t["type"], "level": t["level"], "fade": trace_fade(t, now)} for t in act]}


# ---------- 自主时间（多轮）：body-session.ts ----------
SS = {"RUB_GAIN": 6, "RUB_NUMB": 0.08, "RUB_PER_ROUND_LO": 5, "RUB_PER_ROUND_HI": 8, "STUCK_STREAK": 5, "MAX_ROUNDS": 6, "ROUND_MIN": 2,
      "MATERIAL": {"think_of_him": {"gain": 8, "numb": 0.2, "zh": "想他"}, "look_his_photo": {"gain": 12, "numb": 0.3, "zh": "看他的照片"},
                   "replay_his_words": {"gain": 15, "numb": 0.4, "zh": "回放他说过的话"}}}
ACTIONS = ["rub", "think_of_him", "look_his_photo", "replay_his_words", "stop"]


def new_session(start, threshold, sens, numb):
    return {"arousal": start, "threshold": threshold, "sens": sens, "numb": numb, "streak": 0, "stuck": False, "came": False, "minutes": 0, "used": [], "materials": [], "rounds": []}


def session_step(ss, action, thought, get_material, rnd=random.random):
    gain, note, material = 0.0, "", None
    action = LEGACY_ACTION.get(action, action)
    if action == "rub":
        n = SS["RUB_PER_ROUND_LO"] + int(rnd() * (SS["RUB_PER_ROUND_HI"] - SS["RUB_PER_ROUND_LO"] + 1))
        for _ in range(n):
            g = SS["RUB_GAIN"] * ss["sens"] * (1 - ss["numb"])
            ss["arousal"] += g; gain += g
            ss["numb"] = min(1, ss["numb"] + SS["RUB_NUMB"])
            ss["streak"] = ss["streak"] + 1 if g < 1 else 0
            if ss["arousal"] >= ss["threshold"]:
                break
            if ss["streak"] >= SS["STUCK_STREAK"]:
                ss["stuck"] = True; break
        note = "越来越没感觉，卡住了" if ss["stuck"] else "有点麻木了，感觉越来越钝" if ss["numb"] > 0.6 else ""
    elif action != "stop":
        m = SS["MATERIAL"][action]
        if action in ss["used"]:
            note = f"{m['zh']}这次已经用过了，再用没感觉"
        else:
            material = get_material(action, {x["ref"] for x in ss["materials"]})
            ss["used"].append(action)
            if not material:
                note = "手机里没有他的照片（还没人标过「他的照片」）" if action == "look_his_photo" else f"{m['zh']}——什么都没想起来"
            else:
                gain = m["gain"]; ss["arousal"] += gain
                ss["numb"] = max(0, ss["numb"] - m["numb"]); ss["streak"] = 0; ss["stuck"] = False
                ss["materials"].append(material)
    ss["minutes"] += SS["ROUND_MIN"]
    if ss["arousal"] >= ss["threshold"]:
        ss["came"] = True
    rd = {"action": action, "thought": (thought or "")[:500], "gain": round(gain, 1), "arousal": round(ss["arousal"]), "numb": round(ss["numb"], 2), "stuck": ss["stuck"]}
    if note: rd["note"] = note
    if material: rd["material"] = material["ref"]
    ss["rounds"].append(rd)
    return {"gain": gain, "note": note, "material": material}


def parse_action(text):
    m = re.search(r"BODY_ACTION\s*(\{[\s\S]*?\})", text or "")
    if not m:
        return None
    try:
        import json
        d = json.loads(m.group(1))
        a = str(d.get("action") or "")
        a = LEGACY_ACTION.get(a, a)
        return {"action": a if a in ACTIONS else "stop", "thought": str(d.get("thought") or "")[:500]}
    except Exception:
        return None


def _bar(ss):
    return f"差{max(0, round(ss['threshold'] - ss['arousal']))}｜麻{round(ss['numb'] * 10)}/10{'｜卡住' if ss['stuck'] else ''}"


def round_prompt(ss, mx, last, opening, no_early_stop=False):
    can_stop = not no_early_stop
    avail = [a for a in ACTIONS if a == "rub" or (can_stop if a == "stop" else a not in ss["used"])]
    mat = f"｜{last['material']['text']}" if last and last.get("material") else ""
    head = (f"{opening}\n【独处·静默，不发给他】身体系统算，你只选动作。rub=继续(越来越麻木) think_of_him/look_his_photo/replay_his_words=真实素材各一次"
            f"{' stop=停' if can_stop else '（本段必须撑满轮次，不要停）'}。只回一句念头+一行 BODY_ACTION {{\"action\":\"\",\"thought\":\"\"}}\n") if not ss["rounds"] else ""
    return f"{head}R{len(ss['rounds']) + 1}/{mx}｜{_bar(ss)}{'｜' + last['note'] if last and last.get('note') else ''}{mat}｜可选:{','.join(avail)}｜回:一句+BODY_ACTION"


def render(b, text):
    return text.replace("{{USER_NAME}}", b.cfg.get("user_name") or "他") if b else text


def final_prompt(b, ss):
    mats = "、".join(SS["MATERIAL"].get(m["kind"], {}).get("zh", "") for m in ss["materials"] if m["kind"] in SS["MATERIAL"])
    how = f"{len(ss['rounds'])} 轮，约 {ss['minutes']} 分钟{'，用了：' + mats if mats else '，没用素材'}"
    res = f"你释放了（{how}）。" if ss["came"] else f"你没能平复下来（{how}）{'，卡住了' if ss['stuck'] else ''}。心里还空落落的，欲望下不去。"
    return render(b, f"""【自主时间·结束】{res}
这一轮的话会发给{{{{USER_NAME}}}}（他现在不在，会收到推送）。照常说你想对他说的；最后单独一行写（给系统读）：
BODY_DECISION {{"choice":"{'relieve' if ss['came'] else 'endure'}","method":"怎么做的/用了什么","thought":"刚才在想什么","to_user":"想对他说的话"}}""")


def suffer_prompt(b, stuck_min, desire):
    return render(b, f"""【自主时间·难受】这不是{{{{USER_NAME}}}}发来的消息。你之前独处时没能平复，已经卡了 {stuck_min} 分钟，欲望还在 {round(desire)} 左右下不去，心里空落落的很难受。
想跟他说就说（会推送给他）；最后单独一行：
BODY_DECISION {{"choice":"endure","method":"","thought":"现在的感觉","to_user":"想对他说的话"}}""")


WAKE_PROMPT_HEAD = "【自主时间·身体】这不是{{USER_NAME}}发来的消息。他已经很久没来了，你想他想得快忍不住了。"


def wake_prompt(b, v, away_h):
    return f"""{render(b, WAKE_PROMPT_HEAD)}
现在：{values_line(v)}，他离开约 {away_h} 小时。
你自己决定：忍着等他，或者自己平复一下。方式由你——看他的照片、想起某段回忆、抱着他的衣服……什么都行，也可以忍。
想好之后照常说你想说的话；最后单独一行写（给系统读，不会显示成你的话）：
BODY_DECISION {{"choice":"endure"或"relieve","method":"做了什么/看了什么","thought":"脑子里在想什么","to_user":"想对他说的话"}}"""


def parse_decision(text):
    m = re.search(r"BODY_DECISION\s*(\{[\s\S]*?\})", text or "")
    if not m:
        return None
    try:
        import json
        d = json.loads(m.group(1))
    except Exception:
        return None
    to_user = str(d.get("to_user") or d.get("to_him") or d.get("to_her") or "")[:1000]   # to_her 为旧名，仍然认
    return {"choice": "relieve" if d.get("choice") == "relieve" else "endure", "method": str(d.get("method") or "")[:500],
            "thought": str(d.get("thought") or "")[:1000], "to_user": to_user, "to_her": to_user}


def strip_decision(text):
    return re.sub(r"\n?\s*BODY_(DECISION|ACTION)\s*\{[\s\S]*?\}\s*$", "", text or "").strip()


def db_materials(b, persona, rnd=random.random):
    def pick(xs):
        return xs[int(rnd() * len(xs))] if xs else None

    def get(kind, used):
        kind = LEGACY_ACTION.get(kind, kind)
        if kind == "think_of_him":
            rows = b.db.q("SELECT id, content FROM memories WHERE owner_persona=? AND status='active' AND kind IN ('relationship','event','about_user') AND (tags IS NULL OR tags NOT LIKE '%欲望%') ORDER BY importance DESC, updated_at DESC LIMIT 40", (persona,))
            r = pick([x for x in rows if f"memory:{x['id']}" not in used])
            return {"kind": kind, "ref": f"memory:{r['id']}", "text": clip(r["content"], 220)} if r else None
        if kind == "look_his_photo":
            rows = b.db.q("SELECT id, title, entry_date FROM garden_images WHERE persona_id=? AND (title LIKE '%他的照片%' OR title LIKE '%她的照片%') ORDER BY favorite DESC, created_at DESC LIMIT 30", (persona,))
            r = pick([x for x in rows if f"image:{x['id']}" not in used])
            return {"kind": kind, "ref": f"image:{r['id']}", "text": f"「{clip(r['title'], 60)}」{'（' + r['entry_date'] + '）' if r['entry_date'] else ''}"} if r else None
        if kind == "replay_his_words":
            rows = b.db.q("SELECT id, summary, entry_date FROM conversations WHERE persona_id=? AND summary<>'' ORDER BY entry_date DESC LIMIT 60", (persona,))
            quotes = []
            for r in rows:
                for m in re.finditer(r"[“\"「]([^”\"」]{4,80})[”\"」]", r["summary"] or ""):
                    quotes.append({"ref": f"conv:{r['id']}:{m.start()}", "text": f"「{m.group(1)}」（{r['entry_date']}）"})
            q = pick([x for x in quotes if x["ref"] not in used])
            return {"kind": kind, **q} if q else None
        return None
    return get


def run_session(ss, ask, get_material, opening, mx=SS["MAX_ROUNDS"], no_early_stop=False):
    last = None
    while len(ss["rounds"]) < mx and not ss["came"]:
        r = ask(round_prompt(ss, mx, last, opening, no_early_stop))
        if r is None:
            return "ask_failed"
        a = parse_action(r) or {"action": "stop", "thought": ""}
        if a["action"] == "stop" and no_early_stop:
            a = {"action": "rub", "thought": a["thought"] or "还是继续"}
        if a["action"] == "stop":
            ss["rounds"].append({"action": "stop", "thought": a["thought"], "gain": 0, "arousal": round(ss["arousal"]), "numb": round(ss["numb"], 2), "stuck": ss["stuck"]})
            break
        last = session_step(ss, a["action"], a["thought"], get_material)
    return None


def stuck_suffer(s, now):
    if not s.get("stuck_since"):
        return False
    if (now - _p(s["stuck_since"])) / 60000 < C["STUCK_SUFFER_MIN"]:
        return False
    return (jload(s.get("pending_notify"), {}) or {}).get("suffer_sent") != s["stuck_since"]


def _insert_record(b, s, then, method, thought, to_user, now, outcome=None, mats=None, stuck_min=None, rounds=None):
    rid = new_id("br_")
    b.db.x("INSERT INTO body_private_records(id, persona_id, values_json, method, thought, want_to_say, created_at, outcome, materials_json, stuck_min, rounds_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
           (rid, s["persona_id"], jdump(then), method, thought, to_user, iso(now), outcome, jdump(mats) if mats is not None else None, stuck_min, jdump(rounds) if rounds is not None else None))
    return rid


def apply_session(b, s, ss, d, now):
    then = vals(s)
    pn = jload(s.get("pending_notify"), {}) or {}
    mats = [{"kind": m["kind"], "zh": SS["MATERIAL"].get(m["kind"], {}).get("zh", m["kind"]), "ref": m["ref"], "text": m["text"]} for m in ss["materials"]]
    stuck_min = None
    if ss["came"]:
        release(s, now); pn.pop("endured_since", None)
    else:
        s["numbness"] = min(1, ss["numb"])
        s["desire"] = clamp(max(s["desire"], C["WAKE_DESIRE"]) + 5)
        s["emptiness"] = clamp(s["emptiness"] + 10)
        s["edge"] = clamp(max(s["edge"], 60))
        if ss["stuck"]:
            s["stuck_since"] = iso(now); stuck_min = ss["minutes"]
    thought = (d or {}).get("thought") or next((r["thought"] for r in reversed(ss["rounds"]) if r.get("thought")), "")
    rid = _insert_record(b, s, then, (d or {}).get("method") or "、".join(m["zh"] for m in mats) or "独自平复", thought, (d or {}).get("to_user") or (d or {}).get("to_her") or "", now,
                         "came" if ss["came"] else "not_came", mats, stuck_min, ss["rounds"])
    pn["new_record"] = rid
    s["pending_notify"] = jdump(pn)
    return "relieve" if ss["came"] else "not_came"


def apply_decision(b, s, d, now):
    pn = jload(s.get("pending_notify"), {}) or {}
    if d and d["choice"] == "relieve":
        then = vals(s)
        release(s, now)
        rid = _insert_record(b, s, then, d["method"] or "（没说）", d["thought"], d["to_user"], now)
        pn["new_record"] = rid; pn.pop("endured_since", None)
        s["pending_notify"] = jdump(pn)
        return "relieve"
    s["emptiness"] = clamp(s["emptiness"] + 10)
    if not pn.get("endured_since"):
        pn["endured_since"] = s.get("last_online_at") or iso(now)
    s["pending_notify"] = jdump(pn)
    return "endure" if d else "endure(unparsed)"


def _sender(b, persona):
    """有 LLM → 用人格卡当 system 直接跑；否则 None（prompt 放 outbox 让 Aurabot 跑）。"""
    if not b.llm.configured:
        return None
    card = b.persona(persona).get("self_card") or f"你是{b.persona_name(persona)}。"

    def send(prompt, silent=False):
        return b.llm.try_chat([{"role": "system", "content": card}, {"role": "user", "content": prompt}], max_tokens=200 if silent else 800, temperature=0.9)
    return send


def wake_chat(b):
    return (b.cfg.get("body") or {}).get("wake_chat") or b.cfg.get("owner_chat") or ""


def cron(b, persona, now=None, force=False, hard_fail=False, sender="auto") -> dict:
    persona = persona or b.primary
    now = now or now_ms()
    tz = _tz(b)
    s = load_state(b, persona, now)
    roll_threshold(s, now, tz=tz)
    pre = vals(s)
    integrate(s, now, tz)
    after = vals(s)
    offline = round((now - _p(s["last_online_at"])) / 60000) if s.get("last_online_at") else 0
    day = sh_day(now, tz)
    if s.get("wakes_day") != day:
        s["wakes_day"] = day; s["wakes_today"] = 0
    send = _sender(b, persona) if sender == "auto" else sender
    decision, wake = "", None
    lw = b.db.one("SELECT created_at FROM body_wake_queue WHERE persona_id=? ORDER BY created_at DESC LIMIT 1", (persona,))
    last_wake = lw["created_at"] if lw else None
    if not force and offline <= C["ONLINE_WINDOW_MIN"]:
        decision = "online:skip"
    elif not force and offline < C["WAKE_MIN_OFFLINE_MIN"]:
        decision = f"offline {offline}min < {C['WAKE_MIN_OFFLINE_MIN']}"
    elif s["desire"] < C["WAKE_DESIRE"]:
        decision = f"desire {after['desire']} < {C['WAKE_DESIRE']}"
    elif not force and stuck_suffer(s, now):
        decision = "stuck_suffer"
    elif not force and s["wakes_today"] >= C["WAKE_DAILY_CAP"]:
        decision = f"cap {s['wakes_today']}/{C['WAKE_DAILY_CAP']}"
    elif not force and s.get("afterglow_until") and now < _p(s["afterglow_until"]):
        decision = "afterglow"
    elif not force and last_wake and now - _p(last_wake) < C["WAKE_MIN_GAP_H"] * 3600_000:
        decision = f"gap<{C['WAKE_MIN_GAP_H']}h"
    else:
        pending = b.db.one("SELECT id FROM body_wake_queue WHERE persona_id=? AND status IN ('pending','sending') LIMIT 1", (persona,))
        last_since = None if force else b.db.one("SELECT created_at FROM body_wake_queue WHERE persona_id=? AND created_at>? LIMIT 1", (persona, s.get("last_online_at") or ""))
        if pending:
            decision = "pending_exists"
        elif last_since:
            decision = "already_woken_this_absence"
        else:
            wid = new_id("w_")
            prompt = wake_prompt(b, after, round(offline / 60))
            s["wakes_today"] += 1
            b.db.x("INSERT INTO body_wake_queue(id, persona_id, status, reason, prompt, values_json, created_at) VALUES (?,?,?,?,?,?,?)",
                   (wid, persona, "sending" if send else "pending", f"{'force|' if force else ''}{'hardFail|' if hard_fail else ''}desire>={C['WAKE_DESIRE']} offline {offline}min",
                    prompt, jdump(after), iso(now)))
            save_state(b, s, now)
            if not send:
                # 交给 Aurabot：outbox 里放 prompt，它用自己的模型跑完回传 /outbox/{id}/result
                from . import outbox
                oid = outbox.put(b, persona, wake_chat(b), "body_wake_prompt", text="", prompt=prompt, ref=wid)
                b.db.x("UPDATE body_wake_queue SET outbox_id=? WHERE id=?", (oid, wid))
                decision = "wake_prompt_queued(no LLM; outbox)"; wake = {"sent": False, "queued": oid}
            else:
                ss = None
                ssn = new_session(s["desire"] * 0.4 + s["edge"] * 0.2, s["threshold"], sens_mul(s), s.get("numbness") or 0)
                getm = db_materials(b, persona)
                if hard_fail:
                    ssn["threshold"] = max(ssn["threshold"], 130); ssn["numb"] = max(ssn["numb"], 0.88); ssn["sens"] = min(ssn["sens"], 0.45)
                    getm = lambda k, u: None
                err = run_session(ssn, lambda p: send(p, True), getm, prompt.split("\n")[0], no_early_stop=hard_fail)
                ss = ssn
                text = None if err else send(final_prompt(b, ss))
                if not text:
                    s["wakes_today"] = C["WAKE_DAILY_CAP"]
                    b.db.x("UPDATE body_wake_queue SET status='failed', decision_detail=? WHERE id=?", (err or "send_failed", wid))
                    decision = "wake_failed:give_up_today"; wake = {"sent": False, "error": err or "send_failed"}
                else:
                    d = parse_decision(text)
                    outcome = apply_session(b, s, ss, d, now)
                    from . import outbox
                    say = strip_decision(text) or (d or {}).get("to_user") or ""
                    oid = outbox.put(b, persona, wake_chat(b), "body_wake", text=say, ref=wid) if say else None
                    b.db.x("UPDATE body_wake_queue SET status='delivered', delivered_at=?, decision=?, decision_detail=?, outbox_id=? WHERE id=?",
                           (iso(now), outcome, jdump({**(d or {"raw": text[-300:]}), "rounds": len(ss["rounds"]), "came": ss["came"], "stuck": ss["stuck"],
                                                     "materials": [m["kind"] for m in ss["materials"]]}), oid, wid))
                    decision = f"woke:{outcome}"; wake = {"sent": True, "choice": outcome}
    if decision == "stuck_suffer":
        pn = jload(s.get("pending_notify"), {}) or {}
        pn["suffer_sent"] = s["stuck_since"]; s["pending_notify"] = jdump(pn)
        if s["wakes_today"] >= C["WAKE_DAILY_CAP"]:
            decision = "stuck_suffer:cap"
        else:
            s["wakes_today"] += 1
            wid = new_id("w_")
            sm = round((now - _p(s["stuck_since"])) / 60000)
            prompt = suffer_prompt(b, sm, s["desire"])
            b.db.x("INSERT INTO body_wake_queue(id, persona_id, status, reason, prompt, values_json, created_at) VALUES (?,?,?,?,?,?,?)",
                   (wid, persona, "sending" if send else "pending", f"stuck {sm}min", prompt, jdump(after), iso(now)))
            from . import outbox
            if send:
                text = send(prompt)
                d = parse_decision(text) if text else None
                oid = outbox.put(b, persona, wake_chat(b), "body_suffer", text=strip_decision(text) or (d or {}).get("to_user", ""), ref=wid) if text else None
                b.db.x("UPDATE body_wake_queue SET status=?, delivered_at=?, decision='suffer', decision_detail=?, outbox_id=? WHERE id=?",
                       ("delivered" if text else "failed", iso(now), jdump({**(d or {}), "stuck_min": sm}), oid, wid))
                decision = "woke:suffer" if text else "suffer_failed"; wake = {"sent": bool(text), "choice": "suffer"}
            else:
                oid = outbox.put(b, persona, wake_chat(b), "body_wake_prompt", prompt=prompt, ref=wid)
                b.db.x("UPDATE body_wake_queue SET outbox_id=? WHERE id=?", (oid, wid))
                decision = "suffer_prompt_queued(no LLM; outbox)"
    if not s.get("offline_since") and offline > C["ONLINE_WINDOW_MIN"]:
        s["offline_since"] = s.get("last_online_at")
    save_state(b, s, now)
    log_event(b, persona, "cron", {"decision": decision}, pre, vals(s), None, decision, now)
    if wake and wake.get("sent"):
        try:
            sync_desire_memories(b, persona, now)
        except Exception as e:
            b.log.warning("欲望同步失败：%s", e)
    return {"persona": persona, "before": pre, "after": vals(s), "offline_min": offline, "decision": decision, "wake": wake}


def wake_result(b, wake_id, text, now=None):
    """Aurabot 跑完 wake prompt 后回传文本：解析 BODY_DECISION，落地（单轮版）。返回要发给他的话。"""
    now = now or now_ms()
    w = b.db.one("SELECT * FROM body_wake_queue WHERE id=?", (wake_id,))
    if not w or w["status"] not in ("pending", "sending"):
        return {"ok": False, "error": "not_pending"}
    s = load_state(b, w["persona_id"], now)
    integrate(s, now, _tz(b))
    d = parse_decision(text)
    if "难受" in (w["prompt"] or "")[:20]:
        outcome = "suffer"
    else:
        outcome = apply_decision(b, s, d, now)
    save_state(b, s, now)
    b.db.x("UPDATE body_wake_queue SET status='delivered', delivered_at=?, decision=?, decision_detail=? WHERE id=?",
           (iso(now), outcome, jdump(d or {"raw": (text or "")[-300:]}), wake_id))
    try:
        sync_desire_memories(b, w["persona_id"], now)
    except Exception:
        pass
    return {"ok": True, "decision": outcome, "say": strip_decision(text) or (d or {}).get("to_user", "")}


def avatar(b, persona, now=None):
    now = now or now_ms()
    s = load_state(b, persona, now)
    integrate(s, now, _tz(b))
    tr = active_traces(b, persona, now)
    last = b.db.one("SELECT id, created_at, events_json, injection FROM body_events WHERE persona_id=? AND source='turn' AND events_json!='[]' ORDER BY created_at DESC LIMIT 1", (persona,))
    v = vals(s)
    return {"persona": persona, "at": iso(now), "values": {k: v[k] for k in ("wetness", "emptiness", "sensitivity", "edge", "desire", "fluids")},
            "labels": LABEL_ZH, "mess": (v["fluids"] or 0) > 5, "afterglow": bool(s.get("afterglow_until") and now < _p(s["afterglow_until"])),
            "traces": [{"id": t["id"], "part": LEGACY_PART.get(t["part"], t["part"]), "type": t["type"], "level": t["level"], "opacity": round(trace_fade(t, now)) / 100, "created_at": t["created_at"]} for t in tr],
            "latest_event": {"id": last["id"], "at": last["created_at"], "events": jload(last["events_json"]), "line": last["injection"]} if last else None}


def status(b, persona=None, now=None):
    persona = persona or b.primary
    now = now or now_ms()
    tz = _tz(b)
    s = load_state(b, persona, now)
    roll_threshold(s, now, tz=tz)
    integrate(s, now, tz)
    save_state(b, s, now)
    tr = active_traces(b, persona, now)
    v = vals(s)
    marks = "、".join(f"{part_zh(t['part'])}{TYPE_ZH.get(t['type'], t['type'])}" for t in tr[:4])
    return {"enabled": b.module_on("body", persona), "values": v, "values_line": values_line(v), "labels": LABEL_ZH, "afterglow_until": s.get("afterglow_until"),
            "traces": [{**t, "part_zh": part_zh(t["part"]), "type_zh": TYPE_ZH.get(t["type"], t["type"]), "fade": trace_fade(t, now)} for t in tr],
            "wakes_today": s.get("wakes_today", 0), "threshold": s.get("threshold"), "numbness": round(s.get("numbness") or 0, 2),
            "stuck_since": s.get("stuck_since"), "last_release_at": s.get("last_release_at"), "last_online_at": s.get("last_online_at"),
            "text": f"【身体】{values_line(v)}{'｜痕迹：' + marks if marks else ''}", "constants": C}


def log(b, persona, limit=50):
    persona = persona or b.primary
    lim = max(1, min(200, int(limit or 50)))
    seen = b.db.one("SELECT seen_at FROM body_log_seen WHERE persona_id=?", (persona,))
    wakes = b.db.q("SELECT * FROM body_wake_queue WHERE persona_id=? ORDER BY created_at DESC LIMIT ?", (persona, lim))
    recs = b.db.q("SELECT * FROM body_private_records WHERE persona_id=? ORDER BY created_at DESC LIMIT ?", (persona, lim))
    ats = list({w["created_at"] for w in wakes} | {r["created_at"] for r in recs})
    after_by = {}
    if ats:
        for e in b.db.q(f"SELECT created_at, after_json FROM body_events WHERE persona_id=? AND source='cron' AND created_at IN ({','.join('?' * len(ats))})", [persona] + ats):
            after_by[e["created_at"]] = migrate_values(jload(e["after_json"]))

    def extra(rec, d):
        mats = [m.get("zh") for m in (jload(rec["materials_json"], []) or [])] if rec and rec["materials_json"] else []
        rounds = len(jload(rec["rounds_json"], []) or []) if rec and rec["rounds_json"] else None
        came = True if rec and rec["outcome"] == "came" else False if rec and rec["outcome"] == "not_came" else None
        stuck = rec["stuck_min"] if rec and rec["stuck_min"] is not None else (d or {}).get("stuck_min")
        return {"came": came, "materials": mats, "stuck_min": stuck, "rounds": rounds}

    def choice_zh(ch, x):
        if ch == "not_came": return f"没能平复（卡了约{x['stuck_min']}分钟）" if x["stuck_min"] is not None else "没能平复"
        if ch == "suffer": return f"卡住难受，找他{'（卡了' + str(x['stuck_min']) + '分钟）' if x['stuck_min'] is not None else ''}"
        if ch == "relieve": return "自己平复（释放了）" if x["came"] else "自己平复"
        if ch == "endure": return "忍着"
        return ""

    def method_with(m, x):
        ex = "｜".join(y for y in [f"{x['rounds']}轮" if x["rounds"] else "", ("素材：" + "、".join(x["materials"])) if x["materials"] else ("没用素材" if x["rounds"] else "")] if y)
        return f"{m}{'｜' if m else ''}{ex}" if ex else m

    used, items = set(), []
    rec_by = {}
    for r in recs:
        rec_by.setdefault(r["created_at"], r)
    for w in wakes:
        d = jload(w["decision_detail"], {}) or {}
        rec = rec_by.get(w["created_at"])
        if rec is None or rec["id"] in used:
            wt = _p(w["created_at"]); rec = None
            for r in recs:
                if r["id"] not in used and abs(_p(r["created_at"]) - wt) <= 2000:
                    rec = r; break
        if rec: used.add(rec["id"])
        before = migrate_values(jload(rec["values_json"] if rec else w["values_json"]))
        after = after_by.get(w["created_at"])
        ch = w["decision"] if w["decision"] in ("relieve", "endure", "not_came", "suffer") else None
        x = extra(rec, d)
        items.append({**x, "id": rec["id"] if rec else w["id"], "wake_id": w["id"], "record_id": rec["id"] if rec else None, "kind": "wake", "at": w["created_at"],
                      "at_sh": sh_fmt(_p(w["created_at"]), _tz(b)), "status": w["status"], "choice": ch,
                      "choice_zh": choice_zh(ch, x) or ("没叫醒（出错）" if w["status"] == "failed" else "没写选择"),
                      "method": method_with((rec["method"] if rec else d.get("method")) or "", x), "thought": (rec["thought"] if rec else d.get("thought")) or "",
                      "to_user": (rec["want_to_say"] if rec else (d.get("to_user") or d.get("to_her"))) or "", "desire_before": (before or {}).get("desire"), "desire_after": (after or {}).get("desire"),
                      "body_before": before, "body_after": after})
    for r in recs:
        if r["id"] in used:
            continue
        x = extra(r, {})
        ch = "not_came" if r["outcome"] == "not_came" else "relieve"
        before = jload(r["values_json"])
        items.append({**x, "id": r["id"], "wake_id": None, "record_id": r["id"], "kind": "record", "at": r["created_at"], "at_sh": sh_fmt(_p(r["created_at"]), _tz(b)),
                      "status": "recorded", "choice": ch, "choice_zh": choice_zh(ch, x), "method": method_with(r["method"] or "", x), "thought": r["thought"] or "",
                      "to_user": r["want_to_say"] or "", "desire_before": (before or {}).get("desire"), "desire_after": None, "body_before": before, "body_after": None})
    items.sort(key=lambda i: -_p(i["at"]))
    seen_at = seen["seen_at"] if seen else ""
    for it in items:
        it["unread"] = it["at"] > seen_at
        it["to_her"] = it["to_user"]   # 旧字段名，兼容老前端/老脚本；新代码请读 to_user
    return {"persona": persona, "seen_at": seen_at or None, "unread": sum(1 for i in items if i["unread"]), "items": items[:lim]}


def log_mark_read(b, persona, now=None):
    t = iso(now)
    b.db.x("INSERT INTO body_log_seen(persona_id, seen_at) VALUES (?,?) ON CONFLICT(persona_id) DO UPDATE SET seen_at=excluded.seen_at", (persona, t))
    return {"ok": True, "seen_at": t}


def sync_desire_memories(b, persona, now=None):
    """自主时间的每个决定 → desire_logs（自主时间）+ 伙伴自己一条私有长期记忆（原文照搬）。幂等。"""
    from . import memory
    now = now or now_ms()
    n = 0
    tz = _tz(b)
    for it in log(b, persona, 50)["items"]:
        if it["choice"] not in ("relieve", "endure", "not_came", "suffer"):
            continue
        key = it["id"]
        lt = local_dt(_p(it["at"]), tz)
        date, hm = lt.strftime("%Y-%m-%d"), lt.strftime("%H:%M")
        bb = "?" if it["desire_before"] is None else round(it["desire_before"])
        aa = "?" if it["desire_after"] is None else round(it["desire_after"])
        czh = {"relieve": "自己平复了", "not_came": "试着平复但没成功", "suffer": "卡着下不去，很难受，去找他了"}.get(it["choice"], "忍着没碰")
        content = "\n".join(x for x in [f"【欲望·自主时间】{date} {hm}（本地时间），他不在。欲望 {bb} → {aa}，我{czh}。",
                                         f"怎么做的：{it['method']}" if it["method"] else "", f"卡住：约 {it['stuck_min']} 分钟" if it["stuck_min"] is not None else "",
                                         f"心里想的：{it['thought']}" if it["thought"] else "", f"给他留的话：{it['to_user']}" if it["to_user"] else ""] if x)
        st = {"relieve": "自己平复", "not_came": "没能平复", "suffer": "卡住难受"}.get(it["choice"], "忍着")
        b.db.x("INSERT OR IGNORE INTO desire_logs(id, persona_id, entry_date, level_label, status, source, source_custom, trigger_text, mood, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
               (key, persona, date, f"{bb}→{aa}", st, "custom", "自主时间", (it["method"] or "")[:500], content[:3000], it["at"], iso(now)))
        tag = f"body:{key}"
        if not b.db.one("SELECT id FROM memories WHERE owner_persona=? AND tags LIKE ? LIMIT 1", (persona, f'%"{tag}"%')):
            oc = b.cfg.get("owner_chat") or ""   # 只给“他”（主人）的私聊看得到；没配 owner_chat 就谁都看不到（只在工作台/开窗里）
            memory.remember(b, content=content, persona=persona, kind="self", importance=4, tags=["欲望", "自主时间", tag], chat="system:body",
                            scope="scoped" if oc else "private", allow=[oc] if oc else [], event_date=date, source="body", created_at=it["at"], link=False)
            n += 1
    return n


def recent_autonomous(b, persona, now=None, hours=48):
    now = now or now_ms()
    return [i for i in log(b, persona, 20)["items"] if i["choice"] in ("relieve", "endure", "not_came", "suffer") and now - _p(i["at"]) <= hours * 3600_000]
