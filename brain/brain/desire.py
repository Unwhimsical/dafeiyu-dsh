"""欲望日志（18+，默认关闭；移植自 companion-memory desire.ts）。结构化私密记录：伙伴只能看自己的；管理员看全部。
受 BODY_ENABLED / body_personas 同一开关管（欲望属于身体模块）。"""
from __future__ import annotations
import re, unicodedata
from .util import iso, new_id, local_dt, now_ms

DESIRE_SOURCES = ["novel", "toy", "sex", "oral", "custom"]
DESIRE_SOURCE_LABELS = {"novel": "阅读", "toy": "独处", "sex": "亲密", "oral": "亲密（其他）", "custom": "自定义"}
DESIRE_MOOD_HELP = "写下当时真实的心情就好：可能是满足，可能是空落落的，也可能只是很想他。什么都能放。"
LEVEL_MAX, STATUS_MAX, TRIGGER_MAX, MOOD_MAX, SOURCE_CUSTOM_MAX, REPLY_MAX = 40, 80, 500, 3000, 80, 2000


class DesireError(ValueError):
    pass


def _today(b):
    return local_dt(now_ms(), b.cfg.get("tz_offset_minutes", 480)).strftime("%Y-%m-%d")


def _clip(v: str, mx: int) -> str:
    c = list((v or "").strip())
    return "".join(c) if len(c) <= mx else "".join(c[: mx - 1]) + "…"


def source_display_label(source, custom):
    if source == "custom":
        return (custom or "").strip() or DESIRE_SOURCE_LABELS["custom"]
    return DESIRE_SOURCE_LABELS.get(source, source)


def format_desire_display(r) -> str:
    src = source_display_label(r["source"], r.get("source_custom"))
    trigger = (r.get("trigger_text") or "").strip() or "—"
    mood = (r.get("mood") or "").strip() or "—"
    return f"🔥 {r['entry_date']} · {r['level_label']} · {r['status']}\n【{src}】{trigger}\n→ {mood}"


def desire_title(r) -> str:
    return f"🔥 {r['entry_date']} · {r['level_label']} · {r['status']}"


def _level(inp: dict) -> str:
    lab = inp.get("level_label")
    if lab is not None and str(lab).strip():
        lab = unicodedata.normalize("NFKC", str(lab)).strip()
        if len(lab) > LEVEL_MAX:
            raise DesireError(f"档位最多 {LEVEL_MAX} 字。")
        return lab
    lv = inp.get("level")
    if lv is not None and lv != "":
        try:
            n = int(float(lv))
        except (TypeError, ValueError):
            s = str(lv).strip()
            if not s or len(s) > LEVEL_MAX:
                raise DesireError("level 不合法。")
            return s
        if not 1 <= n <= 5:
            raise DesireError("level 须为 1–5，或者用 level_label 自己写。")
        return str(n)
    raise DesireError("缺少 level / level_label。")


def save(b, persona: str, inp: dict) -> dict:
    """新建或更新（带 id 就是更新）。兼容前端字段 level/trigger/mood/source。"""
    persona = persona or b.primary
    level = _level(inp)
    status = _clip(str(inp.get("status") or "").strip() or "藏着", STATUS_MAX)
    source = str(inp.get("source") or "custom").strip()
    if source not in DESIRE_SOURCES:
        raise DesireError(f"source 只能是 {'/'.join(DESIRE_SOURCES)}。")
    sc = (inp.get("source_custom") or "").strip() or None
    # 允许 source=custom 时省略 source_custom（历史行为）；如需强制可显式传 allow_empty_custom=false
    if sc:
        sc = _clip(sc, SOURCE_CUSTOM_MAX)
    trig = _clip(str(inp.get("trigger_text") or inp.get("trigger") or ""), TRIGGER_MAX)
    mood = _clip(str(inp.get("mood") or ""), MOOD_MAX)
    date = (inp.get("date") or inp.get("entry_date") or "").strip() or _today(b)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise DesireError("date 须为 YYYY-MM-DD。")
    t = iso()
    did = inp.get("id")
    if did and b.db.one("SELECT 1 FROM desire_logs WHERE id=?", (did,)):
        b.db.x("UPDATE desire_logs SET entry_date=?, level_label=?, status=?, source=?, source_custom=?, trigger_text=?, mood=?, updated_at=? WHERE id=?",
               (date, level, status, source, sc, trig, mood, t, did))
    else:
        did = did or new_id("ds_")
        b.db.x("INSERT INTO desire_logs(id, persona_id, entry_date, level_label, status, source, source_custom, trigger_text, mood, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
               (did, persona, date, level, status, source, sc, trig, mood, t, t))
    return get(b, did)


def _replies(b, did):
    return [{**dict(r), "author": r["author_label"] or r["author_persona_id"], "content": r["body"]}
            for r in b.db.q("SELECT * FROM desire_replies WHERE desire_id=? ORDER BY created_at", (did,))]


def _view(b, r) -> dict:
    d = dict(r)
    d.update({"level": d["level_label"], "trigger": d["trigger_text"], "display": format_desire_display(d), "title": desire_title(d),
              "source_label": source_display_label(d["source"], d.get("source_custom")), "replies": _replies(b, d["id"])})
    return d


def get(b, did):
    r = b.db.one("SELECT * FROM desire_logs WHERE id=?", (did,))
    return _view(b, r) if r else None


def listing(b, persona=None, limit=50, date_from=None, date_to=None) -> list[dict]:
    conds, ps = [], []
    if persona:
        conds.append("persona_id=?"); ps.append(persona)
    if date_from:
        conds.append("entry_date>=?"); ps.append(date_from)
    if date_to:
        conds.append("entry_date<=?"); ps.append(date_to)
    w = ("WHERE " + " AND ".join(conds)) if conds else ""
    return [_view(b, r) for r in b.db.q(f"SELECT * FROM desire_logs {w} ORDER BY entry_date DESC, created_at DESC LIMIT ?", ps + [max(1, min(500, int(limit)))])]


def list_text(b, persona, limit=10) -> str:
    items = listing(b, persona, limit)
    if not items:
        return "还没有欲望日志。"
    return "\n\n".join(x["display"] for x in items)


def forget(b, did) -> bool:
    b.db.x("DELETE FROM desire_replies WHERE desire_id=?", (did,))
    return b.db.x("DELETE FROM desire_logs WHERE id=?", (did,)).rowcount > 0


def add_reply(b, did, content: str, author="user", author_persona=None) -> dict:
    if not b.db.one("SELECT 1 FROM desire_logs WHERE id=?", (did,)):
        raise DesireError("没有这条欲望日志。")
    body = _clip(content or "", REPLY_MAX)
    if not body:
        raise DesireError("回复不能是空的。")
    rid = new_id("dr_")
    label = {"user": b.cfg.get("user_name", "他")}.get(author, author)
    b.db.x("INSERT INTO desire_replies(id, desire_id, author_persona_id, author_label, body, created_at) VALUES (?,?,?,?,?,?)",
           (rid, did, author_persona or author, label, body, iso()))
    return {"id": rid, "desire_id": did, "author": label, "content": body}


def delete_reply(b, rid) -> bool:
    return b.db.x("DELETE FROM desire_replies WHERE id=?", (rid,)).rowcount > 0


def series(b, persona, since_iso) -> list[dict]:
    return [{"at": r["created_at"], "level": r["level_label"], "status": r["status"]}
            for r in b.db.q("SELECT created_at, level_label, status FROM desire_logs WHERE persona_id=? AND created_at>=? ORDER BY created_at", (persona, since_iso))]
