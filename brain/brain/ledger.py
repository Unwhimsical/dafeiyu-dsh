"""话簿账本（Ledger）—— 原话逐句留存 + 她自己分配 + 冷热可见 + 按需调取。

设计要点（对应「一次弄好」）：
  * L0 底账 append-only：text_raw 平时永不 UPDATE；唯一例外是「彻底删除」——直接删掉底账行和条目行，只留不含内容的审计壳。
  * 册子是视图，不是抽屉：books 是 JSON 数组，一条可属多本；底层永远按时间序。
  * 主体不预设：suggest_assign 只给建议并写明理由，主人/她随时可改，改动进 ledger_audit。
  * 省 token：账本永不整本进 prompt。for_context() 只在触发词命中时查一次索引，
    取前 N 条、单条掐短、总字数封顶、结果缓存；平时零查询、零注入。
  * 隐私：按 chat_id（p:/g:）天然隔离，私聊原话不串到群；控制台（chat=None）才看全部。
  * 本地：原话只存在 brain.db 里，不写任何明文镜像文件；cfg.ledger_path 只放手动导出 / 手动生成的回顾。
  * 不记：18+ 轮次（调用方传 adult=true，或内容命中成人词）、隔离号 / 完全隔离会话里的话，一律不进底账。
"""
from __future__ import annotations
import hashlib, json, math, re, threading, time
from pathlib import Path

from .util import iso, now_ms, parse_iso, clip, jload, jdump, new_id, local_dt

DAY_MS = 86400 * 1000
_FILE_LOCK = threading.Lock()
_CACHE_LOCK = threading.Lock()
_HIT_CACHE: dict = {}          # 触发式召回结果缓存
_BOOK_CACHE = {"at": 0.0, "names": []}

# 触发词：出现才查账本。平时聊天一次都不查，这是省 token 的第一道闸。
RECALL_WORDS = re.compile(
    r"(上次|之前|那天|上回|以前|还记得|记不记得|那次|前几天|前阵子|上个月|上周|昨天说|"
    r"话簿|账本|本子|记一下|帮我记|记下来|收进去|收进本子|收好这句|翻翻|翻一翻|"
    r"找找|查一下|你记着|别忘|惦记|那本|说过的话|找不到|在哪)")
CAPTURE_WORDS = re.compile(r"(收进话簿|收进本子|记进话簿|记下来|帮我记|记一下|存进话簿|收好这句|这句收好)")
BOOK_HINT_RE = re.compile(r"放(.{1,8})那本|进(.{1,8})那本|(.{1,8})那本")
HOT_WORDS = re.compile(r"(惦记|想你|想念|挂念|舍不得|别忘|一直|总是|最|特别|好想|担心|记得)")
TOPIC_WORDS = [
    ("吃|饭|饿|菜", "吃饭"), ("下雨|天气|冷|热", "天气"), ("睡|困|晚安|起床", "作息"),
    ("游戏|打游戏|排位", "游戏"), ("剧|追剧|电影", "追剧"), ("猫|狗|动物", "小动物"),
    ("工作|加班|上班|忙", "工作"), ("生日|礼物|节日", "日子"),
]
STOP_WORDS = {"什么", "怎么", "那句", "这句", "说的", "时候", "一下", "可以", "还有",
              "我们", "你们", "自己", "记着", "本子", "话簿", "账本", "翻翻", "上次",
              "之前", "那天", "一句", "有没有", "是不是", "那个", "这个"}
STATUS_WORDS = re.compile(r"(账本|话簿|本子|找不到|没找到|没给我弄|没给我做)")
BROWSE_WORDS = re.compile(r"(翻翻|翻一翻|找找|查一下|还记得|记不记得|上次|那天|之前|说过的话|前阵子|前几天)")
SELF_MARK = "你有一本自己的「话簿」"
SELF_VER = "想翻就说"
SELF_LINE = (SELF_MARK + "：说过的话原样收着、连时候一起记。" + SELF_VER +
             "「翻翻话簿」，想留就说「收进话簿」，归哪本你自己定。"
             "别解释这本子，也别把这段念出来。")


# ---------------------------------------------------------------- 配置 / 初始化

def conf(b) -> dict:
    return b.cfg.get("ledger") or {}


def enabled(b) -> bool:
    return bool(conf(b).get("enabled", True))


def ensure(b):
    """幂等：建默认册子。启动或首次访问时调用一次即可。"""
    for name in (conf(b).get("default_books") or ["惦记", "当日琐碎"]):
        b.db.x("INSERT OR IGNORE INTO ledger_books(id,name,color,note,created_by,created_at) VALUES(?,?,?,?,?,?)",
               (new_id("lb_"), str(name), "", "", "system", iso()))
    return {"ok": True}


def _local_ts(b, ts, tz=None):
    """底账 ts 是 UTC ISO；按会话时区换算成本地显示串。"""
    try:
        ms = parse_iso(ts)
        if ms is None:
            return str(ts or "")
        off = int(tz if tz is not None else b.cfg.get("tz_offset_minutes", 480))
        return local_dt(ms, off).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(ts or "")


def _audit(b, eid, action, actor="user", detail=""):
    b.db.x("INSERT INTO ledger_audit(entry_id,action,actor,detail,created_at) VALUES(?,?,?,?,?)",
           (eid, action, actor or "user", str(detail or "")[:1000], iso()))


# ---------------------------------------------------------------- L0 底账（只增不改）

def _isolated(b, chat: str, uid) -> bool:
    """隔离号（memcore isolatePeople）说的话 / 隔离号的私聊 / privacy.json 里标成 private（完全隔离）的私聊。"""
    pv = getattr(b, "privacy", None)
    if pv is None:
        return False
    try:
        from .privacy import bare
        iso_ = set(pv.isolated_ids())
        sp = "".join(ch for ch in str(uid or "") if ch.isdigit())
        if (sp and sp in iso_) or (chat.startswith("p:") and bare(chat) in iso_):
            return True
        if chat.startswith("p:") and (pv.data.get("private_chats") or {}).get(bare(chat)) == "private":
            return True
        return pv.src_tier(str(uid or ""), chat) == "isolated"
    except Exception as e:
        b.log.debug("话簿隔离判断失败，按隔离处理：%s", e)
        return True


def append_utterance(b, chat, persona, role, uid, text, *, platform="",
                     speaker_label="", context_before="", context_after="",
                     turn_id=None, spill_file="", spill_line=None, adult=False, isolated=False):
    """由 context.record_turn() 订阅调用：逐句原话自动进底账，零额外模型调用。
    18+ 轮次、隔离号 / 隔离会话的话不记（返回 None）。"""
    if not enabled(b):
        return None
    if adult or isolated:
        return None
    txt = str(text or "")
    if not txt.strip():
        return None
    t = iso()
    tz = int(b.cfg.get("tz_offset_minutes", 480))
    chat = str(chat or "")
    if chat in ("system", "unknown"):
        return None       # 系统内部轮次不算「说过的话」，别污染账本
    from . import sensitivity as SENS
    if SENS.is_adult_text(txt) or _isolated(b, chat, uid):
        return None
    if not platform:
        platform = "douyin" if chat.startswith(("p:douyin", "g:douyin")) else "qq"
    try:
        r = b.db.one("SELECT COALESCE(MAX(seq),0)+1 n FROM ledger_utterances WHERE chat_id=?", (chat,))
        seq = int(r["n"]) if r else 1
    except Exception:
        seq = 0
    lid = new_id("lu_")
    digest = hashlib.sha256((t + "|" + chat + "|" + txt).encode("utf-8", "replace")).hexdigest()[:16]
    b.db.x(
        "INSERT INTO ledger_utterances(id,ts,tz_offset,created_at,platform,chat_id,speaker_id,speaker_label,role,seq,"
        "text_raw,context_before,context_after,turn_id,spill_file,spill_line,visibility,nsfw,hash,erased) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
        (lid, t, tz, t, platform, chat, str(uid or ""), str(speaker_label or ""), str(role or "user"), seq,
         clip(txt, 4000), str(context_before or "")[:400], str(context_after or "")[:400],
         turn_id, str(spill_file or ""), spill_line, "inherit", 0, digest))
    return lid


def recent_utterances(b, chat=None, limit=30):
    """控制台「自动收下的原话」/「从刚才的对话里收一句」用。排除系统轮次。"""
    w, ps = (("WHERE chat_id=? AND chat_id!='system' AND erased=0", [chat])
             if chat else ("WHERE chat_id!='system' AND erased=0", []))
    rows = b.db.q(f"SELECT id,ts,tz_offset,chat_id,role,speaker_label,text_raw FROM ledger_utterances {w} "
                  f"ORDER BY ts DESC LIMIT ?", ps + [min(200, int(limit))])
    out = []
    for r in rows:
        d = dict(r)
        d["ts_local"] = _local_ts(b, r["ts"], r["tz_offset"])
        out.append(d)
    return out


# ---------------------------------------------------------------- L1 条目 / 分配

def suggest_assign(b, text, chat=None):
    """纯本地规则，永不调模型。只给建议，绝不写死任何主体。"""
    if conf(b).get("auto_assign") == "off":
        return {"subject": "", "subject_type": "person", "books": [], "tags": [],
                "why_kept": "", "reason": "自动分配已关，等她自己分", "by": "none"}
    t = str(text or "")
    hot = bool(HOT_WORDS.search(t))
    books = ["惦记"] if hot else ["当日琐碎"]
    subject, stype = "", "person"
    labels = b.cfg.get("chat_labels") or {}
    if chat and chat in labels:
        subject, stype = str(labels[chat]), "person"
    tags = []
    for rx, tag in TOPIC_WORDS:
        if re.search(rx, t):
            tags.append(tag)
        if len(tags) >= 3:
            break
    reason = ("命中「" + (HOT_WORDS.search(t).group(0) if hot else "日常") + "」，建议放"
              + books[0] + "；主体" + (subject or "留空等你分配"))
    return {"subject": subject, "subject_type": stype, "books": books, "tags": tags,
            "why_kept": "", "reason": reason, "by": "rule"}


def _fts_set(b, eid, quote, why, tags):
    b.db.x("DELETE FROM ledger_fts WHERE id=?", (eid,))
    b.db.x("INSERT INTO ledger_fts(id,quote,why_kept,tags) VALUES(?,?,?,?)",
           (eid, str(quote or ""), str(why or ""), " ".join(tags or [])))


def add_entry(b, utterance_id, *, subject=None, books=None, tags=None, why_kept="",
              note="", importance=3, emotion=0.3, assigned_by="user", auto=True, chat=None):
    if not enabled(b):
        raise ValueError("话簿没开")
    u = b.db.one("SELECT * FROM ledger_utterances WHERE id=?", (utterance_id,))
    if not u or u["erased"]:
        raise ValueError("没有这句原话，或它已被抹掉")
    quote = u["text_raw"]
    reason, by = "", assigned_by or "user"
    if auto:
        s = suggest_assign(b, quote, chat=u["chat_id"])
        subject = s["subject"] if subject is None else subject
        books = s["books"] if books is None else books
        tags = s["tags"] if tags is None else tags
        why_kept = why_kept or s["why_kept"]
        reason, by = s["reason"], s["by"]
    subject = str(subject or "")
    books = [str(x) for x in (books or [])][:8]
    tags = [str(x) for x in (tags or [])][:12]
    # 册子可以现场新建，不用先去建
    for name in books:
        b.db.x("INSERT OR IGNORE INTO ledger_books(id,name,color,note,created_by,created_at) VALUES(?,?,?,?,?,?)",
               (new_id("lb_"), name, "", "", by, iso()))
        _BOOK_CACHE["at"] = 0.0
    eid = new_id("le_")
    fp = hashlib.sha256(quote.encode("utf-8", "replace")).hexdigest()[:16]
    hl = 14.0
    try:
        from . import forgetting as F
        hl = float(F.base_half_life(importance, emotion) or 45)
    except Exception:
        pass
    t = iso()
    b.db.x(
        "INSERT INTO ledger_entries(id,utterance_id,quote,subject,subject_type,books,tags,why_kept,note,"
        "assigned_by,assign_reason,importance,emotion,recall_count,half_life_days,heat,heat_pinned,status,"
        "created_at,updated_at,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,0.5,0,'active',?,?,?)",
        (eid, utterance_id, quote, subject, "person", jdump(books), jdump(tags), str(why_kept or "")[:300],
         str(note or "")[:500], by, reason, int(importance), float(emotion), hl, t, t, fp))
    _fts_set(b, eid, quote, why_kept, tags)
    _audit(b, eid, "add", by, reason)
    # 新条目立刻算一次热度
    r = b.db.one("SELECT * FROM ledger_entries WHERE id=?", (eid,))
    h, _ = heat_of(b, r)
    b.db.x("UPDATE ledger_entries SET heat=? WHERE id=?", (h, eid))
    return {"ok": True, "id": eid, "item": view(b, r)}


def set_entry(b, eid, fields: dict, actor="user"):
    """只改元数据，绝不改 quote / text_raw。每次改动留痕可回滚。"""
    allow = {"subject", "subject_type", "books", "tags", "why_kept", "note",
             "importance", "emotion", "heat_pinned", "status", "assigned_by"}
    r = b.db.one("SELECT * FROM ledger_entries WHERE id=?", (eid,))
    if not r:
        raise ValueError("没有这条")
    sets, ps, changed = [], [], {}
    for k, v in (fields or {}).items():
        if k not in allow:
            continue
        if k in ("books", "tags"):
            v = jdump([str(x) for x in (v or [])])
        elif k in ("importance", "heat_pinned"):
            v = int(v)
        elif k == "emotion":
            v = float(v)
        else:
            v = str(v or "")
        sets.append(k + "=?"); ps.append(v); changed[k] = v
    if not sets:
        return {"ok": True, "changed": 0, "item": view(b, r)}
    sets.append("updated_at=?"); ps.append(iso()); ps.append(eid)
    b.db.x("UPDATE ledger_entries SET " + ",".join(sets) + " WHERE id=?", ps)
    if "books" in changed:
        for name in (jload(changed["books"], []) or []):
            b.db.x("INSERT OR IGNORE INTO ledger_books(id,name,color,note,created_by,created_at) VALUES(?,?,?,?,?,?)",
                   (new_id("lb_"), str(name), "", "", actor, iso()))
        _BOOK_CACHE["at"] = 0.0
    if any(k in changed for k in ("tags", "why_kept")):
        nr = b.db.one("SELECT * FROM ledger_entries WHERE id=?", (eid,))
        _fts_set(b, eid, nr["quote"], nr["why_kept"], jload(nr["tags"], []))
    _audit(b, eid, "assign", actor, json.dumps(changed, ensure_ascii=False)[:600])
    nr = b.db.one("SELECT * FROM ledger_entries WHERE id=?", (eid,))
    h, _ = heat_of(b, nr)
    b.db.x("UPDATE ledger_entries SET heat=? WHERE id=?", (h, eid))
    return {"ok": True, "changed": len(changed), "item": view(b, nr)}


def correct(b, eid, note, actor="user"):
    """记错了：追加更正记录，不改原话。"""
    r = b.db.one("SELECT * FROM ledger_entries WHERE id=?", (eid,))
    if not r:
        raise ValueError("没有这条")
    _audit(b, eid, "correct", actor, str(note or "")[:500])
    return {"ok": True, "note": "原话保留，更正已追加"}


def erase(b, eid, actor="user"):
    """彻底删除：唯一允许动底账的情况 —— 底账原话行、引用它的所有条目、全文索引一起真删，只留不含内容的审计壳。"""
    r = b.db.one("SELECT * FROM ledger_entries WHERE id=?", (eid,))
    if not r:
        raise ValueError("没有这条")
    uid = r["utterance_id"]
    eids = [x["id"] for x in b.db.q("SELECT id FROM ledger_entries WHERE utterance_id=?", (uid,))] if uid else []
    for x in set(eids) | {eid}:
        b.db.x("DELETE FROM ledger_fts WHERE id=?", (x,))
        b.db.x("DELETE FROM ledger_entries WHERE id=?", (x,))
        _audit(b, x, "erase", actor, "已彻底删除（底账与条目均不留内容）")
    if uid:
        b.db.x("DELETE FROM ledger_utterances WHERE id=?", (uid,))
    _HIT_CACHE.clear()
    return {"ok": True}


# ---------------------------------------------------------------- 冷热（可解释）

def heat_of(b, r, now=None):
    now = now or now_ms()
    if r["heat_pinned"]:
        return 1.0, ["你置顶"]
    if r["status"] == "archived":
        return 0.0, ["已归档"]
    if r["status"] == "deleted":
        return 0.0, ["已删除"]
    hl = max(0.5, float(r["half_life_days"] or 14))
    try:
        age_days = max(0.0, (now - (parse_iso(r["created_at"]) or now)) / DAY_MS)
    except Exception:
        age_days = 0.0
    recent = math.exp(-age_days / hl)
    rc = int(r["recall_count"] or 0)
    freq = min(1.0, math.log(1 + rc) / math.log(21))
    emo = min(1.0, max(0.0, float(r["emotion"] or 0)))
    imp = min(1.0, max(0.0, float(r["importance"] or 3) / 5))
    heat = max(0.0, min(1.0, 0.40 * recent + 0.25 * freq + 0.20 * emo + 0.15 * imp))
    why = []
    if recent > 0.6:
        why.append("刚说的")
    if freq > 0.3:
        why.append("常被想起")
    if emo > 0.5:
        why.append("情绪重")
    if imp >= 0.8:
        why.append("很重要")
    if not why:
        why.append("时间久了")
    return round(heat, 4), why


def state_of(heat: float, status="active") -> str:
    if status == "archived":
        return "冰"
    if status == "deleted":
        return "已删除"
    return "热" if heat >= 0.5 else ("温" if heat >= 0.15 else "冷")


def refresh_heat(b):
    rows = b.db.q("SELECT * FROM ledger_entries WHERE status!='deleted'")
    n = 0
    for r in rows:
        h, _ = heat_of(b, r)
        b.db.x("UPDATE ledger_entries SET heat=? WHERE id=?", (h, r["id"]))
        n += 1
    return {"ok": True, "updated": n}


def view(b, r) -> dict:
    h, why = heat_of(b, r)
    return {"id": r["id"], "utterance_id": r["utterance_id"], "quote": r["quote"],
            "subject": r["subject"] or "", "subject_type": r["subject_type"],
            "books": jload(r["books"], []) or [], "tags": jload(r["tags"], []) or [],
            "why_kept": r["why_kept"] or "", "note": r["note"] or "",
            "assigned_by": r["assigned_by"], "assign_reason": r["assign_reason"] or "",
            "importance": r["importance"], "emotion": r["emotion"],
            "recall_count": r["recall_count"], "last_recalled_at": r["last_recalled_at"],
            "heat": h, "state": state_of(h, r["status"]), "hot_why": why,
            "heat_pinned": bool(r["heat_pinned"]), "status": r["status"],
            "created_at": r["created_at"], "updated_at": r["updated_at"],
            "ts": r["ts"] if "ts" in r.keys() else "",
            "ts_local": _local_ts(b, r["ts"]) if "ts" in r.keys() else "",
            "chat_id": r["chat_id"] if "chat_id" in r.keys() else "",
            "speaker_label": r["speaker_label"] if "speaker_label" in r.keys() else "",
            "role": r["role"] if "role" in r.keys() else ""}


# ---------------------------------------------------------------- 检索（索引 + LIMIT，绝不遍历）

def _search_utterances(b, query, chat=None, limit=6, strict=False):
    """底账（逐句原话）也能翻：条目为空时用它。仍然子串+LIMIT，绝不整本读给模型。"""
    cap = max(1, min(50, int(limit)))
    clean = RECALL_WORDS.sub(" ", str(query or "")).strip()
    try:
        from . import textutil as T
        toks = [t for t in T.tokens(clean) if len(t) >= 2 and t not in STOP_WORDS][:6]
    except Exception:
        toks = [t for t in re.split(r"[\s,，。！？、;；:：]+", clean) if len(t) >= 2][:6]
    conds, ps = ["erased=0", "chat_id!='system'"], []
    if chat:
        conds.append("chat_id=?"); ps.append(chat)
    where = " AND ".join(conds)
    if toks:
        like = " OR ".join(["text_raw LIKE ?" for _ in toks])
        rows = b.db.q(f"SELECT * FROM ledger_utterances WHERE {where} AND ({like}) ORDER BY ts DESC LIMIT ?",
                      ps + ["%" + t + "%" for t in toks] + [cap])
        if not rows and strict:
            return []
    else:
        rows = b.db.q(f"SELECT * FROM ledger_utterances WHERE {where} ORDER BY ts DESC LIMIT ?", ps + [cap])
    return [{"id": "u:" + r["id"], "from_raw": True, "quote": r["text_raw"],
             "subject": "", "books": [], "tags": [], "why_kept": "", "hot_why": ["自动收下的"],
             "state": "温", "heat": 0.5, "heat_pinned": False, "status": "active",
             "ts": r["ts"], "ts_local": _local_ts(b, r["ts"], r["tz_offset"]),
             "chat_id": r["chat_id"], "speaker_label": r["speaker_label"], "role": r["role"]}
            for r in rows]


def search(b, query, chat=None, limit=6, book=None, subject=None, strict=False):
    """按需检索：先 FTS 索引圈候选 → 再按热度排序 → 统一 LIMIT。
    strict=True（给模型用）：关键词一个都没命中就返回空，绝不拿「最热的几句」凑数。"""
    cap = max(1, min(50, int(limit)))
    conds = ["e.status='active'", "u.erased=0"]
    ps: list = []
    if chat:
        conds.append("u.chat_id=?"); ps.append(chat)
    if subject:
        conds.append("e.subject=?"); ps.append(subject)
    q = str(query or "").strip()
    clean = RECALL_WORDS.sub(" ", q).strip()
    try:
        from . import textutil as T          # 复用项目现成的中文分词，短词也能命中
        toks = [t for t in T.tokens(clean) if len(t) >= 2 and t not in STOP_WORDS][:6]
    except Exception:
        toks = [t for t in re.split(r"[\s,，。！？、;；:：]+", clean) if len(t) >= 2][:6]
    ids = []
    if toks:
        try:
            match = " OR ".join('"' + t.replace('"', " ") + '"' for t in toks)
            fts = b.db.q("SELECT f.id FROM ledger_fts f WHERE ledger_fts MATCH ? LIMIT ?", (match, cap * 4))
            ids = [x["id"] for x in fts]
        except Exception:
            ids = []
    where = " AND ".join(conds)
    base = ("SELECT e.*, u.ts, u.chat_id, u.speaker_label, u.role FROM ledger_entries e "
            "JOIN ledger_utterances u ON u.id=e.utterance_id WHERE ")
    if ids:
        marks = ",".join("?" for _ in ids)
        rows = b.db.q(base + where + f" AND e.id IN ({marks}) ORDER BY e.heat DESC LIMIT ?", ps + ids + [cap])
    elif toks:
        # FTS 没命中（短词 / trigram 切分不吻合）时退到 LIKE 子串，仍然带 LIMIT，不遍历整本给模型
        like = " OR ".join(["e.quote LIKE ?" for _ in toks])
        rows = b.db.q(base + where + f" AND ({like}) ORDER BY e.heat DESC LIMIT ?",
                      ps + ["%" + t + "%" for t in toks] + [cap])
    else:
        rows = b.db.q(base + where + " ORDER BY e.heat DESC LIMIT ?", ps + [cap])
    out = [view(b, r) for r in rows]
    if not out and not (book or subject):
        out = _search_utterances(b, q, chat=chat, limit=cap, strict=strict)
    if book:
        out = [x for x in out if book in (x["books"] or [])]
    return out


def list_entries(b, chat=None, book=None, subject=None, state=None, q="", limit=100, offset=0):
    """控制台列表：照样走索引 + LIMIT，不整本读。"""
    cap = max(1, min(300, int(limit)))
    conds = ["e.status!='deleted'", "u.erased=0"]
    ps: list = []
    if chat:
        conds.append("u.chat_id=?"); ps.append(chat)
    if subject:
        conds.append("e.subject=?"); ps.append(subject)
    if q:
        conds.append("(e.quote LIKE ? OR e.why_kept LIKE ? OR e.tags LIKE ?)")
        ps += ["%" + q + "%"] * 3
    base = ("SELECT e.*, u.ts, u.chat_id, u.speaker_label, u.role FROM ledger_entries e "
            "JOIN ledger_utterances u ON u.id=e.utterance_id WHERE ")
    rows = b.db.q(base + " AND ".join(conds) + " ORDER BY e.heat DESC, e.created_at DESC LIMIT ? OFFSET ?",
                  ps + [cap, max(0, int(offset))])
    out = [view(b, r) for r in rows]
    if book:
        out = [x for x in out if book in (x["books"] or [])]
    if state:
        out = [x for x in out if x["state"] == state]
    return out


def books(b):
    rows = b.db.q("SELECT * FROM ledger_books ORDER BY created_at")
    out = []
    for r in rows:
        n = b.db.one("SELECT COUNT(*) c FROM ledger_entries WHERE status!='deleted' AND books LIKE ?",
                     ("%" + str(r["name"]) + "%",))["c"]
        out.append({**dict(r), "count": int(n)})
    return out


def add_book(b, name, color="", note="", actor="her"):
    name = str(name or "").strip()
    if not name:
        raise ValueError("册子得有个名字")
    b.db.x("INSERT OR IGNORE INTO ledger_books(id,name,color,note,created_by,created_at) VALUES(?,?,?,?,?,?)",
           (new_id("lb_"), name, str(color or ""), str(note or "")[:200], actor, iso()))
    _BOOK_CACHE["at"] = 0.0
    _audit(b, "", "book_add", actor, name)
    return {"ok": True, "books": books(b)}


def rename_book(b, old, new, actor="her"):
    rows = b.db.q("SELECT * FROM ledger_entries WHERE books LIKE ?", ("%" + str(old) + "%",))
    for r in rows:
        cur = jload(r["books"], []) or []
        b.db.x("UPDATE ledger_entries SET books=?, updated_at=? WHERE id=?",
               (jdump([str(new) if x == old else x for x in cur]), iso(), r["id"]))
    b.db.x("UPDATE ledger_books SET name=? WHERE name=?", (str(new), str(old)))
    _BOOK_CACHE["at"] = 0.0
    _audit(b, "", "book_rename", actor, str(old) + " → " + str(new))
    return {"ok": True, "books": books(b)}


def delete_book(b, name, actor="her"):
    for r in b.db.q("SELECT * FROM ledger_entries WHERE books LIKE ?", ("%" + str(name) + "%",)):
        cur = [x for x in (jload(r["books"], []) or []) if x != name]
        b.db.x("UPDATE ledger_entries SET books=?, updated_at=? WHERE id=?", (jdump(cur), iso(), r["id"]))
    b.db.x("DELETE FROM ledger_books WHERE name=?", (str(name),))
    _BOOK_CACHE["at"] = 0.0
    _audit(b, "", "book_del", actor, str(name))
    return {"ok": True, "books": books(b)}


# ---------------------------------------------------------------- 按需调取（省 token 的核心）

def _book_names(b):
    with _CACHE_LOCK:
        if time.time() - _BOOK_CACHE["at"] < 60 and _BOOK_CACHE["names"]:
            return list(_BOOK_CACHE["names"])
    try:
        names = [x["name"] for x in b.db.q("SELECT name FROM ledger_books")]
    except Exception:
        names = []
    with _CACHE_LOCK:
        _BOOK_CACHE["at"] = time.time()
        _BOOK_CACHE["names"] = names
    return names


def wants(b, message: str):
    """四道触发闸；平时返回 False，账本零查询。"""
    m = str(message or "")
    if RECALL_WORDS.search(m):
        return True, "recall"
    for n in _book_names(b):
        if n and n in m:
            return True, "book"
    return False, ""


def capture_last(b, chat, message, preview=False):
    """对话里一句「把刚才那句收进话簿」就真的收一句：本地写入，零模型调用。"""
    if preview:
        return None
    cmd = str(message or "").strip()
    rows = recent_utterances(b, chat=chat, limit=8)
    cand = [r for r in rows if r["text_raw"].strip() != cmd and len(r["text_raw"].strip()) >= 2]
    if not cand:
        return None
    hint = BOOK_HINT_RE.search(cmd)
    book = next((g for g in hint.groups() if g), None) if hint else None
    try:
        return add_entry(b, cand[0]["id"], books=[book.strip()] if book else None, auto=True, chat=chat)
    except Exception:
        return None


def for_context(b, message, chat=None, persona=None, preview=False, prev=""):
    """只在触发时查一次索引，取前 N 条、掐短、封顶、缓存；也可用一句话收进账本。平时返回空串，一分钱不花。"""
    if not enabled(b) or not conf(b).get("trigger", True):
        return "", []
    # 一句「收进话簿」就真的写一句，不是只嘴上答应
    if CAPTURE_WORDS.search(str(message or "")):
        if preview:
            return "", []
        got = capture_last(b, chat, message)
        if got:
            names = got["item"]["books"] or []
            tail = ("，放在「" + "、".join(names) + "」") if names else ""
            return "你想起自己那本话簿：刚把上一句收好了" + tail + "。", [got["id"]]
        return "【话簿】还没找到要收的那句，也可以去控制台「话簿」页点「收一句」。", []
    # 她自己说「我去翻翻」这类话，通过上一句上下文也能带出来（不额外注入、不额外调模型）
    ok, mode = wants(b, str(message or "") + " " + str(prev or ""))
    if not ok:
        return "", []
    key = str(chat or "") + "|" + str(message or "")[:80]
    with _CACHE_LOCK:
        hit = _HIT_CACHE.get(key)
        if hit and time.time() - hit[0] < int(conf(b).get("cache_seconds", 120)):
            return hit[1], hit[2]
    cap = int(conf(b).get("max_chars", 600))
    cc = int(conf(b).get("clip_chars", 110))
    rows = search(b, message, chat=chat, limit=int(conf(b).get("max_entries", 6)), strict=True)
    probe = str(message or "") + " " + str(prev or "")
    if not rows and not BROWSE_WORDS.search(probe):
        n = b.db.one("SELECT COUNT(*) c FROM ledger_utterances WHERE erased=0 AND chat_id!='system'")["c"]
        return (f"【话簿】本子一直在，已经自动收了 {n} 句原话；想翻就说「翻翻话簿」，"
                f"想留就说「收进话簿」。别再说没找到。"), []
    lines, ids, used = [], [], 0
    for r in rows:
        date = (r.get("ts_local") or r.get("ts") or "")[5:10].replace("-", ".")
        who = r.get("speaker_label") or ("对方" if r.get("role") == "user" else "我")
        ln = "- 【话簿" + (date or "") + "】" + who + "：" + clip(r["quote"], cc) + "（" + "/".join(r["hot_why"][:2]) + "）"
        if used + len(ln) + 1 > cap:
            break
        lines.append(ln); used += len(ln) + 1; ids.append(r["id"])
    text = ("你想起自己那本话簿里记着：\n" + "\n".join(lines)) if lines else ""
    if ids and not preview:
        for eid in ids:
            if not str(eid).startswith("u:"):
                b.db.x("UPDATE ledger_entries SET recall_count=recall_count+1,last_recalled_at=? WHERE id=?", (iso(), eid))
    with _CACHE_LOCK:
        _HIT_CACHE[key] = (time.time(), text, ids)
        if len(_HIT_CACHE) > 64:
            for k in list(_HIT_CACHE)[:16]:
                _HIT_CACHE.pop(k, None)
    return text, ids


def knows_self_text(b) -> str:
    return SELF_LINE if conf(b).get("know_self", True) else ""


def awareness(b, persona=None):
    """「让她自己知道」：把一小段自我认知写进人格卡（self_card 本来就在每轮 prompt 里，零额外预算）。"""
    pid = persona or b.primary
    line = knows_self_text(b)
    if not line:
        return {"ok": True, "skipped": True}
    r = b.db.one("SELECT self_card FROM personas WHERE id=?", (pid,))
    card = (r["self_card"] if r else "") or ""
    if SELF_MARK in card and SELF_VER in card:
        return {"ok": True, "already": True}
    if SELF_MARK in card:
        # 旧版文案自动升级成带「怎么说」的新版（只换这一行，不动人设卡别的内容）
        card = re.sub(r"(?m)^.*" + re.escape(SELF_MARK) + r".*$", "", card).rstrip()
    if not r:
        b.db.x("INSERT OR IGNORE INTO personas(id,display_name,created_at,updated_at) VALUES(?,?,?,?)",
               (pid, b.cfg.persona_name(pid), iso(), iso()))
    b.db.x("UPDATE personas SET self_card=?, updated_at=? WHERE id=?",
           ((card.rstrip() + "\n\n" + line).strip(), iso(), pid))
    return {"ok": True, "already": False, "line": line}


# ---------------------------------------------------------------- 每日回顾 / 导出 / 统计

def echo(b, write_file=True):
    """每日回顾：最热几条 + 快凉几条 + 一句回声。只写本地文件，不发消息、不调模型。"""
    rows = list_entries(b, limit=200)
    hot = [x for x in rows if x["state"] == "热"][:int(conf(b).get("echo_per_day", 3))]
    cold = [x for x in rows if x["state"] in ("温", "冷")][-int(conf(b).get("echo_per_day", 3)):]
    day = local_dt(now_ms(), int(b.cfg.get("tz_offset_minutes", 480))).strftime("%Y-%m-%d")
    lines = ["话簿 · 每日回顾 " + day, "", "今天最热："] + [f"  · {x['quote'][:60]}（{x['state']}）" for x in hot]
    lines += ["", "快凉了："] + [f"  · {x['quote'][:60]}（{x['state']}）" for x in cold]
    if hot and cold:
        lines += ["", "昨日回声：", "  " + (hot[0]["ts"] or "")[:10] + " 说过「" + hot[0]["quote"][:40] + "」",
                  "  和后来那句「" + cold[-1]["quote"][:40] + "」摆在一起，不评判，只是让你自己看见。"]
    text = "\n".join(lines)
    if write_file:
        try:
            d = Path(b.cfg.ledger_path)
            with _FILE_LOCK:
                (d / ("echo-" + day + ".txt")).write_text(text, encoding="utf-8")
        except Exception as e:
            b.log.debug("话簿回顾写入失败：%s", e)
    return {"ok": True, "day": day, "hot": hot, "cold": cold, "text": text}


def export(b, book=None, subject=None):
    rows = list_entries(b, book=book, subject=subject, limit=300)
    day = local_dt(now_ms(), int(b.cfg.get("tz_offset_minutes", 480))).strftime("%Y-%m-%d")
    d = Path(b.cfg.ledger_path) / "exports"
    d.mkdir(parents=True, exist_ok=True)
    f = d / ("ledger-" + day + "-" + new_id("")[:6] + ".json")
    f.write_text(json.dumps({"exported_at": iso(), "count": len(rows), "items": rows},
                            ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "path": str(f), "count": len(rows)}


def stats(b):
    rows = b.db.q("SELECT heat,status FROM ledger_entries WHERE status!='deleted'")
    dist = {"热": 0, "温": 0, "冷": 0, "冰": 0}
    for r in rows:
        dist[state_of(float(r["heat"] or 0), r["status"])] = dist.get(state_of(float(r["heat"] or 0), r["status"]), 0) + 1
    return {"ok": True, "entries": len(rows),
            "utterances": b.db.one("SELECT COUNT(*) c FROM ledger_utterances WHERE erased=0")["c"],
            "books": len(books(b)), "heat": dist,
            "aware": awareness_status(b), "dir": str(b.cfg.ledger_path)}


def awareness_status(b, persona=None):
    pid = persona or b.primary
    r = b.db.one("SELECT self_card FROM personas WHERE id=?", (pid,))
    return bool(r and SELF_MARK in (r["self_card"] or ""))
