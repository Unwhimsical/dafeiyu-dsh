"""只读视图：星图 atlas、统计、记忆花园（companion-memory 原版花园页接口）、抽卡 deck、伙伴互留言 peers。
所有带 chat 的视图都过 privacy.visible_sql；18+ 条目（欲望/身体）只在管理员视角或 owner_chat 视角出现。"""
from __future__ import annotations
import re

ADULT_RE = re.compile(r'湿润|湿了|高潮|情欲|做爱|插进|腿间|乳头|自慰|内裤|呻吟|色情|上床|舔|小穴|肉棒|阴道|淫|射了')


import random
from . import memory as M
from . import forgetting as F
from .util import iso, now_ms, new_id, jload, jdump, clip

EMBLEM = ["moon", "cat", "snake", "rose", "star", "leaf"]


def personas(b) -> list[dict]:
    out = []
    for r in b.db.q("SELECT * FROM personas ORDER BY created_at"):
        n = b.db.one("SELECT COUNT(*) c FROM memories WHERE owner_persona=? AND status='active'", (r["id"],))["c"]
        out.append({"id": r["id"], "name": r["display_name"], "display_name": r["display_name"], "relationship_to_user": r["relationship_to_user"] or "",
                    "self_card": r["self_card"] or "", "core": r["self_card"] or "", "memories": n})
    if not any(p["id"] == "family" for p in out) and b.db.one("SELECT 1 FROM memories WHERE owner_persona='family' LIMIT 1"):
        n = b.db.one("SELECT COUNT(*) c FROM memories WHERE owner_persona='family' AND status='active'")["c"]
        out.append({"id": "family", "name": "全家共享", "display_name": "全家共享", "relationship_to_user": "全家人都能看到的记忆", "self_card": "", "core": "", "memories": n})
    return out


def _adult_ok(b, chat):
    return chat is None or chat == (b.cfg.get("owner_chat") or "")


def items(b, persona=None, chat=None) -> list[dict]:
    """星图上的“非记忆”条目：梦、心痕、交接、未了的事、便条、欲望、回顾、花园条目、对话存档。"""
    pf = (lambda col: (f" WHERE {col}=?", [persona])) if persona else (lambda col: ("", []))
    out = []
    owner_view = _adult_ok(b, chat)
    if owner_view:
        w, p = pf("persona_id")
        for r in b.db.q(f"SELECT * FROM dreams{w} ORDER BY created_at DESC LIMIT 60", p):
            out.append({"id": "dream:" + r["id"], "type": "dream", "persona": r["persona_id"], "title": f"梦 · {(r['dream_date'] or '')[5:].replace('-', '.')}",
                        "content": r["text"], "created_at": r["created_at"], "extra": "", "links": jload(r["cited_ids"], []) or []})
        for r in b.db.q(f"SELECT * FROM heart_traces{w} ORDER BY created_at DESC LIMIT 60", p):
            out.append({"id": "heart:" + r["id"], "type": "heart", "persona": r["persona_id"], "title": r["title"], "content": r["content"], "created_at": r["created_at"], "extra": ""})
        for r in b.db.q(f"SELECT * FROM notes{w} ORDER BY created_at DESC LIMIT 60", p):
            out.append({"id": "note:" + r["id"], "type": "note", "persona": r["persona_id"], "title": "便条", "content": r["content"], "created_at": r["created_at"],
                        "extra": r["reply"] or "", "links": [r["memory_id"]] if r["memory_id"] else []})
        for r in b.db.q(f"SELECT * FROM desire_logs{w} ORDER BY created_at DESC LIMIT 60", p):
            out.append({"id": "desire:" + r["id"], "type": "desire", "persona": r["persona_id"], "title": r["trigger_text"] or r["level_label"] or "欲望",
                        "content": r["mood"] or "", "created_at": r["created_at"], "extra": r["status"] or ""})
        for r in b.db.q(f"SELECT * FROM reviews{w} ORDER BY created_at DESC LIMIT 30", p):
            out.append({"id": "review:" + r["id"], "type": "diary", "persona": r["persona_id"], "title": "回顾" if r["kind"] == "review" else "沉淀",
                        "content": r["content"], "created_at": r["created_at"], "extra": "", "links": jload(r["memory_ids"], []) or []})
        for r in b.db.q(f"SELECT * FROM garden_entries{w} ORDER BY created_at DESC LIMIT 100", p):
            out.append({"id": "entry:" + r["id"], "type": r["kind"] or "entry", "persona": r["persona_id"], "title": r["title"], "content": r["body"], "created_at": r["created_at"], "extra": ""})
        for r in b.db.q(f"SELECT * FROM conversations{w} ORDER BY created_at DESC LIMIT 60", p):
            out.append({"id": "chat:" + r["id"], "type": "chat", "persona": r["persona_id"], "title": r["title"], "content": r["summary"] or "", "created_at": r["created_at"], "extra": ""})
    # 交接 / 未了的事：按会话过滤（不跨会话）
    conds, ps = [], []
    if persona:
        conds.append("persona_id=?"); ps.append(persona)
    if chat is not None and not owner_view:
        conds.append("chat_id=?"); ps.append(chat)
    w = (" WHERE " + " AND ".join(conds)) if conds else ""
    for r in b.db.q(f"SELECT * FROM handoffs{w} ORDER BY created_at DESC LIMIT 40", ps):
        out.append({"id": "handoff:" + r["id"], "type": "handoff", "persona": r["persona_id"], "title": f"交接 · {(r['created_at'] or '')[5:10].replace('-', '.')}",
                    "content": r["summary"], "created_at": r["created_at"], "extra": r["mood"] or "", "chat_id": r["chat_id"]})
    for r in b.db.q(f"SELECT * FROM unresolved{w} {'AND' if w else 'WHERE'} status='open' ORDER BY created_at DESC LIMIT 40", ps):
        out.append({"id": "worry:" + r["id"], "type": "worry", "persona": r["persona_id"], "title": clip(r["content"], 16), "content": r["content"],
                    "created_at": r["created_at"], "extra": "", "chat_id": r["chat_id"]})
    return out


def _is_adult_memory(r) -> bool:
    """18+ 记忆不进星图：标签优先，其次内容特征词。"""
    try:
        tags = r["tags"] if "tags" in r.keys() else ""
        meta = r["meta"] if "meta" in r.keys() else ""
        blob = (str(tags or "") + " " + str(meta or "")).lower()
        if "nsfw" in blob or "adult" in blob or "18+" in blob:
            return True
        text = str(r["content"] if "content" in r.keys() else "")
        return bool(ADULT_RE.search(text))
    except Exception:
        return False

def atlas(b, persona=None, chat=None) -> dict:
    now = now_ms()
    rows = M.visible_rows(b, chat, persona, limit=5000)
    # 18+ 的记忆不进星图：带 nsfw/adult 标签、或内容命中成人词的一律藏起来
    rows = [r for r in rows if not _is_adult_memory(r)]
    if chat is None:   # 主人视角：被更正/过时的旧记忆以灰雾显示（原文保留，强线索还能被唤醒）
        pc, pp = ("AND owner_persona=?", (persona,)) if persona else ("", ())
        old = b.db.q(f"SELECT * FROM memories WHERE status='superseded' {pc} ORDER BY updated_at DESC LIMIT 400", pp)
        rows = list(rows) + [r for r in old if not _is_adult_memory(r)]
    stars = []
    for r in rows:
        v = M.view(b, r, now)
        k = r.keys()
        v["outdated"] = r["status"] == "superseded" or ("credibility" in k and r["credibility"] in ("corrected", "denied"))
        v["walked"] = bool("last_surfaced_at" in k and r["last_surfaced_at"])          # 被「突然想起」过的星
        v["credibility"] = (r["credibility"] if "credibility" in k else "") or ""
        v["version"] = int((r["version"] if "version" in k else 1) or 1)
        stars.append(v)
    ids = {s["id"] for s in stars}
    its = items(b, persona, chat)
    ids |= {i["id"] for i in its}
    links = []
    if stars:
        for l in b.db.q("SELECT a_id, b_id, weight, kind FROM memory_links"):
            if l["a_id"] in ids and l["b_id"] in ids:
                links.append({"a": l["a_id"], "b": l["b_id"], "w": round(l["weight"], 3), "k": l["kind"]})
    for it in its:
        for mid in it.pop("links", []) or []:
            if mid in ids:
                links.append({"a": it["id"], "b": mid, "w": 0.45, "k": "semantic"})
    types = {}
    for it in its:
        types[it["type"]] = types.get(it["type"], 0) + 1
    cnt = {"total": len(stars), "pinned": sum(1 for s in stars if s["pinned"]), "links": len(links), "items": len(its),
           "recalled": sum(1 for s in stars if (s.get("recall_count") or 0) > 0), "cognitions": sum(1 for s in stars if s["kind"] == "cognition")}
    for st in ("clear", "faded", "trace"):
        cnt[st] = sum(1 for s in stars if s["state"] == st)
    return {"ok": True, "generated_at": iso(now), "primary": b.primary, "chat": chat, "counts": cnt, "personas": personas(b),
            "stars": stars, "items": its, "types": types, "links": links}


def stats(b) -> dict:
    now = now_ms()
    bs, bk, bsc = {}, {}, {}
    rows = b.db.q("SELECT * FROM memories WHERE status='active'")
    for r in rows:
        st = F.state_of(r, now); bs[st] = bs.get(st, 0) + 1
        bk[r["kind"]] = bk.get(r["kind"], 0) + 1
        e = b.privacy.effective(r); bsc[e] = bsc.get(e, 0) + 1
    arch = b.db.one("SELECT COUNT(*) c FROM memories WHERE status='archived'")["c"]
    sup = b.db.one("SELECT COUNT(*) c FROM memories WHERE status='superseded'")["c"]
    return {"ok": True, "memories": {"total": len(rows), "archived": arch, "superseded": sup, "by_state": bs, "by_kind": bk, "by_scope": bsc},
            "links": b.db.one("SELECT COUNT(*) c FROM memory_links")["c"],
            "turns": b.db.one("SELECT COUNT(*) c FROM turns")["c"],
            "pulses_24h": b.db.one("SELECT COUNT(*) c FROM pulses WHERE at_ms>=?", (now - 86400_000,))["c"],
            "chats": b.db.one("SELECT COUNT(*) c FROM chat_counters")["c"],
            "spill_lines": b.db.one("SELECT COUNT(*) c FROM spill_index")["c"]}


# —— 花园（companion-memory gardenOverview 结构） ——

def garden(b, chat=None) -> dict:
    people = []
    for i, p in enumerate(x for x in personas(b) if x["id"] != "family"):
        meta = b.db.one("SELECT * FROM garden_persona_meta WHERE persona_id=?", (p["id"],))
        people.append({"id": p["id"], "name": p["name"], "note": (meta["note"] if meta and meta["note"] else p["relationship_to_user"]),
                       "emblem": (meta["emblem"] if meta and meta["emblem"] else EMBLEM[i % len(EMBLEM)]), "relationship_to_user": p["relationship_to_user"]})
    favs = {(r["kind"], r["ref_id"]) for r in b.db.q("SELECT kind, ref_id FROM garden_favorites")}
    cards = []
    for r in M.visible_rows(b, chat, None, limit=3000):
        v = M.view(b, r)
        title = (r["content"].split("\n")[0])
        import re as _re
        title = clip(_re.sub(r"【[^】]*】", "", title).strip() or r["content"], 20)
        cards.append({"id": "memory:" + r["id"], "source": "memory", "ref_id": r["id"], "persona_id": r["owner_persona"], "type": "memory", "title": title,
                      "summary": clip(r["content"], 120), "date": (r["event_date"] or r["created_at"] or "")[:10], "favorite": bool(v["pinned"] or ("memory", r["id"]) in favs),
                      "kind": r["kind"], "state": v["state"]})
    for it in items(b, None, chat):
        src, rid = _src_of(it)
        cards.append({"id": f"{src}:{rid}", "source": src, "ref_id": rid, "persona_id": it["persona"], "type": TMAP.get(it["type"], "diary"),
                      "title": it["title"], "summary": clip(it["content"] or "", 120), "date": (it["created_at"] or "")[:10], "favorite": (src, rid) in favs,
                      "kind_label": it["type"]})
    cards.sort(key=lambda c: c["date"] or "", reverse=True)
    return {"ok": True, "people": people, "cards": cards, "counts": {"people": len(people), "cards": len(cards)}}


TMAP = {"dream": "diary", "heart": "heart", "handoff": "handoff", "desire": "desire", "note": "note", "worry": "unresolved", "diary": "diary",
        "mood": "diary", "chat": "conversation", "entry": "diary", "promise": "promise", "novel": "novel"}
SRC = {"dream": "dream", "heart": "heart", "handoff": "handoff", "desire": "desire", "note": "note", "worry": "unresolved", "review": "review",
       "entry": "garden", "chat": "conversation"}


def _src_of(it):
    pre, rid = it["id"].split(":", 1)
    return SRC.get(pre, pre), rid


def card(b, source, ref_id, chat=None) -> dict | None:
    if source == "memory":
        r = M.get(b, ref_id)
        if not r or (chat is not None and not b.privacy.is_visible(r, chat)):
            return None
        return {"id": "memory:" + ref_id, "source": "memory", "ref_id": ref_id, "persona_id": r["owner_persona"], "type": "memory",
                "title": clip(r["content"].split("\n")[0], 20), "summary": clip(r["content"], 180), "full_text": r["content"],
                "date": (r["created_at"] or "")[:10], "favorite": bool(r["pinned"]), "memory": M.view(b, r)}
    for it in items(b, None, chat):
        src, rid = _src_of(it)
        if src == source and rid == ref_id:
            d = {"id": f"{src}:{rid}", "source": src, "ref_id": rid, "persona_id": it["persona"], "type": TMAP.get(it["type"], "diary"), "title": it["title"],
                 "summary": clip(it["content"] or "", 180), "full_text": it["content"], "date": (it["created_at"] or "")[:10], "favorite": False}
            if src == "handoff":
                h = b.db.one("SELECT * FROM handoffs WHERE id=?", (rid,))
                d["handoff"] = dict(h) if h else None
            if src == "unresolved":
                u = b.db.one("SELECT * FROM unresolved WHERE id=?", (rid,))
                d["unresolved"] = dict(u) if u else None
            if src == "conversation":
                c = b.db.one("SELECT * FROM conversations WHERE id=?", (rid,))
                if c: d["full_text"] = c["full_text"] or c["summary"]; d["conversation"] = dict(c)
            if src == "garden":
                g = b.db.one("SELECT * FROM garden_entries WHERE id=?", (rid,))
                if g: d["entry"] = dict(g)
            if src == "note":
                n = b.db.one("SELECT * FROM notes WHERE id=?", (rid,))
                if n: d["note"] = dict(n)
            return d
    return None


def favorite(b, kind, ref_id, on=True):
    if on:
        b.db.x("INSERT OR IGNORE INTO garden_favorites(kind, ref_id, created_at) VALUES (?,?,?)", (kind, ref_id, iso()))
    else:
        b.db.x("DELETE FROM garden_favorites WHERE kind=? AND ref_id=?", (kind, ref_id))
    return {"ok": True}


def status_get(b):
    r = b.db.one("SELECT * FROM her_status ORDER BY created_at DESC LIMIT 1")
    return {"ok": True, "status": dict(r) if r else None}


def status_set(b, d):
    sid = new_id("s_")
    try:
        energy = int(d.get("energy") or 3)
    except (TypeError, ValueError):
        energy = 3
    b.db.x("INSERT INTO her_status(id, mood, energy, note, created_at) VALUES (?,?,?,?,?)", (sid, clip(str(d.get("mood") or ""), 20), energy, clip(str(d.get("note") or ""), 200), iso()))
    return {"ok": True, "status": dict(b.db.one("SELECT * FROM her_status WHERE id=?", (sid,)))}


def status_history(b, limit=30):
    return {"ok": True, "items": [dict(r) for r in b.db.q("SELECT * FROM her_status ORDER BY created_at DESC LIMIT ?", (limit,))]}


def companion_notes(b, persona=None):
    rows = [dict(r) for r in b.db.q("SELECT * FROM companion_notes ORDER BY created_at DESC LIMIT 50")]
    if persona:
        rows = [r for r in rows if r["persona_id"] == persona]
    return {"ok": True, "items": rows, "unread": sum(1 for r in rows if not r["seen"])}


def companion_note_add(b, persona, content):
    nid = new_id("cn_")
    b.db.x("INSERT INTO companion_notes(id, persona_id, content, seen, created_at) VALUES (?,?,?,0,?)", (nid, persona or b.primary, clip(content, 500), iso()))
    return {"ok": True, "id": nid}


def companion_notes_seen(b):
    b.db.x("UPDATE companion_notes SET seen=1")
    return {"ok": True}


# —— 抽卡 deck：话题卡 + 记忆卡（随机摇一颗星） ——

def deck_topics(b):
    out = []
    for t in b.db.q("SELECT * FROM topics ORDER BY created_at"):
        n = b.db.one("SELECT COUNT(*) c FROM deck_items WHERE topic_id=?", (t["id"],))["c"]
        out.append({"id": t["id"], "name": t["name"], "description": t["description"], "count": n})
    return {"ok": True, "items": out}


def deck_add(b, d):
    tid = d.get("topic_id")
    if not tid and d.get("topic"):
        r = b.db.one("SELECT id FROM topics WHERE name=?", (d["topic"],))
        tid = r["id"] if r else new_id("t_")
        if not r:
            b.db.x("INSERT INTO topics(id, name, description, created_at) VALUES (?,?,?,?)", (tid, d["topic"], "", iso()))
    iid = new_id("dk_")
    b.db.x("INSERT INTO deck_items(id, topic_id, kind, title, content, created_by, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
           (iid, tid, d.get("kind") or "card", clip(str(d.get("title") or ""), 40), clip(str(d.get("content") or ""), 1000), d.get("created_by") or "user", jdump(d.get("tags") or []), iso(), iso()))
    return {"ok": True, "id": iid}


def deck_draw(b, topic=None, persona=None, chat=None):
    rows = b.db.q("SELECT * FROM deck_items WHERE topic_id=?", (topic,)) if topic else b.db.q("SELECT * FROM deck_items")
    if rows and (topic or random.random() < 0.5):
        r = random.choice(rows)
        b.db.x("INSERT INTO deck_draws(item_id, persona, drawn_at) VALUES (?,?,?)", (r["id"], persona or b.primary, iso()))
        return {"ok": True, "item": {"id": r["id"], "title": r["title"], "content": r["content"], "source": "deck"}}
    mems = M.visible_rows(b, chat, persona, limit=1500)
    if not mems:
        return {"ok": True, "item": None}
    weights = [0.2 + F.strength_now(m) for m in mems]
    m = random.choices(mems, weights=weights)[0]
    b.pulse([m["id"]], "review", chat or "", [0.6])
    return {"ok": True, "item": {"id": m["id"], "title": "摇到一颗星", "content": m["content"], "source": "memory"}}


# —— 伙伴之间互留言（peers） ——

def peer_send(b, frm, to, content):
    pid = new_id("pm_")
    b.db.x("INSERT INTO peer_messages(id, from_persona, to_persona, content, read, created_at) VALUES (?,?,?,?,0,?)", (pid, frm, to, clip(content, 1000), iso()))
    return {"ok": True, "id": pid}


def peer_inbox(b, persona, mark_read=True):
    rows = [dict(r) for r in b.db.q("SELECT * FROM peer_messages WHERE to_persona=? ORDER BY created_at DESC LIMIT 50", (persona,))]
    if mark_read:
        b.db.x("UPDATE peer_messages SET read=1 WHERE to_persona=?", (persona,))
    return {"ok": True, "items": rows}


def view_list(b, name, chat=None, persona=None):
    """/api/view/<name> 的通用列表。"""
    if name == "conversations":
        return {"ok": True, "items": [dict(r) for r in b.db.q("SELECT * FROM conversations ORDER BY created_at DESC LIMIT 100")]}
    if name == "garden-entries":
        return {"ok": True, "items": [dict(r) for r in b.db.q("SELECT * FROM garden_entries ORDER BY created_at DESC LIMIT 200")]}
    if name == "favorites":
        return {"ok": True, "items": [dict(r) for r in b.db.q("SELECT * FROM garden_favorites ORDER BY created_at DESC")]}
    if name == "heart-traces":
        return {"ok": True, "items": [dict(r) for r in b.db.q("SELECT * FROM heart_traces ORDER BY created_at DESC LIMIT 100")]}
    if name == "desires":
        if not _adult_ok(b, chat):
            return {"ok": True, "items": []}
        from . import desire
        return {"ok": True, "items": desire.listing(b, persona, 100)}
    if name == "dreams":
        from . import dream
        return {"ok": True, "items": dream.listing(b, persona, 60)["items"]}
    return {"ok": True, "items": []}
