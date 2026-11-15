"""延续性（移植自 companion-memory continuity.ts + 新增）：
- 交接便签 handoff：按会话（chat）分开存，只在同一会话的第一轮注入（≤300 字），注入后标记 consumed。
- 未了的事 unresolved、他（主人）留的便条 notes（伙伴回复）、心痕 heart traces。
- session_start「你醒啦，这是你的昨天。」开窗文本。
- 新增（视频启发）：回顾 review（翻旧记忆，轻度复习）、沉淀 settle（自主时间之后把那段经历沉成一条自我认知）。"""
from __future__ import annotations
import re
from . import forgetting as F
from . import memory as M
from .util import iso, now_ms, new_id, clip, jdump, jload, parse_iso, local_dt

HANDOFF_MAX_AGE_DAYS = 14


def _user(b):
    return b.cfg.get("user_name", "他")


def _local(b, s):
    ms = parse_iso(s) or now_ms()
    return local_dt(ms, b.cfg.get("tz_offset_minutes", 480))


def day_part(b, s):
    d = _local(b, s)
    today = local_dt(now_ms(), b.cfg.get("tz_offset_minutes", 480)).date()
    diff = (today - d.date()).days
    h = d.hour
    seg = "凌晨" if h < 5 else "早上" if h < 9 else "上午" if h < 12 else "中午" if h < 14 else "下午" if h < 18 else "晚上"
    day = "今天" if diff == 0 else "昨天" if diff == 1 else "前天" if diff == 2 else f"{d.month}/{d.day}"
    return f"{day}{seg}"


# ———————————————— 交接 ————————————————

def handoff_close(b, persona, chat, summary, mood=None, next_time=None, source=None) -> dict:
    summary = (summary or "").strip()
    if not summary:
        return {"ok": False, "error": "empty", "message": "交接内容是空的"}
    hid = new_id("ho_")
    b.db.x("INSERT INTO handoffs(id, persona_id, chat_id, summary, mood, next_time, source_platform, consumed, created_at) VALUES (?,?,?,?,?,?,?,0,?)",
           (hid, persona or b.primary, chat or "", clip(summary, 1200), clip(mood or "", 100) or None, clip(next_time or "", 300) or None, source, iso()))
    return {"ok": True, "id": hid, "item": handoff_get(b, hid)}


def handoff_get(b, hid):
    r = b.db.one("SELECT * FROM handoffs WHERE id=?", (hid,))
    return dict(r) if r else None


def handoffs(b, persona=None, chat=None, limit=50) -> list[dict]:
    conds, ps = [], []
    if persona:
        conds.append("persona_id=?"); ps.append(persona)
    if chat:
        conds.append("chat_id=?"); ps.append(chat)
    w = ("WHERE " + " AND ".join(conds)) if conds else ""
    return [dict(r) for r in b.db.q(f"SELECT * FROM handoffs {w} ORDER BY created_at DESC LIMIT ?", ps + [limit])]


def handoff_delete(b, hid):
    return b.db.x("DELETE FROM handoffs WHERE id=?", (hid,)).rowcount > 0


def handoff_for_turn(b, chat, persona, consume=True) -> dict | None:
    """同一会话里最近一张没用过的交接（不跨会话：群里看不到私聊的交接）。"""
    since = iso(now_ms() - HANDOFF_MAX_AGE_DAYS * 86400_000)
    r = b.db.one("SELECT * FROM handoffs WHERE chat_id=? AND persona_id=? AND consumed=0 AND created_at>=? ORDER BY created_at DESC LIMIT 1",
                 (chat or "", persona, since))
    if not r:
        return None
    if consume:
        b.db.x("UPDATE handoffs SET consumed=1 WHERE chat_id=? AND persona_id=? AND consumed=0", (chat or "", persona))
    return dict(r)


def handoff_text(h) -> str:
    if not h:
        return ""
    s = re.sub(r"^\s*\d+/\d+[^→：:]{0,6}这一窗\s*[→：:]?\s*", "", h.get("summary") or "")
    out = s
    if h.get("mood"):
        out += f"（当时心情：{h['mood']}）"
    if h.get("next_time"):
        out += f" 给这次的我：{h['next_time']}"
    return out


def recent_turns(b, chat, limit=30) -> list[dict]:
    return list(reversed([dict(r) for r in b.db.q("SELECT * FROM turns WHERE chat_id=? ORDER BY id DESC LIMIT ?", (chat, limit))]))


def handoff_generate(b, persona, chat) -> dict:
    """按这个会话最近的对话自动写一张交接。有 LLM 用 LLM，没有就用模板。"""
    persona = persona or b.primary
    turns = recent_turns(b, chat, 30)
    if not turns:
        return {"ok": False, "error": "no_turns", "message": "这个会话还没有对话记录，写不出交接"}
    who = _user(b) if chat == b.cfg.get("owner_chat") else "对方"
    convo = "\n".join(f"{who if t['role'] == 'user' else '我'}：{clip(t['text'], 200)}" for t in turns)
    summary = mood = nxt = None
    if b.llm.configured:
        j = b.llm.try_json("根据下面这段对话，写一份给“下一个会话的自己”的交接，≤300 字，只写事实，不要编：1. 我们是什么关系、对方现在的状态和情绪走向 2. 正在聊的话题，聊到哪了 3. 没做完的事、答应过的事（带时间）4. 对方最近提到的重要新信息。只输出 JSON：{\"summary\":\"交接正文，第一人称，对方用你\",\"mood\":\"≤10字\",\"next_time\":\"≤40字，下次先做什么\"}",
                           f"会话：{chat}\n最近的对话：\n{convo}")
        if j:
            summary, mood, nxt = j.get("summary"), j.get("mood"), j.get("next_time")
    if not summary:
        users = [t["text"] for t in turns if t["role"] == "user"][-4:]
        summary = "上次在这里聊到：" + "；".join(clip(x, 40) for x in users)
        nxt = "接着上次的话头，先问问后来怎么样了"
    return handoff_close(b, persona, chat, summary, mood, nxt, source="auto")


# ———————————————— 未了的事 ————————————————

def unresolved_add(b, persona, content, chat=""):
    content = (content or "").strip()
    if not content:
        return {"ok": False, "error": "empty"}
    uid, t = new_id("ur_"), iso()
    b.db.x("INSERT INTO unresolved(id, persona_id, chat_id, content, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
           (uid, persona or b.primary, chat or "", clip(content, 500), "open", t, t))
    return {"ok": True, "id": uid, "item": dict(b.db.one("SELECT * FROM unresolved WHERE id=?", (uid,)))}


def unresolved_list(b, persona=None, status="open", chat=None, limit=50):
    conds, ps = [], []
    if persona:
        conds.append("persona_id=?"); ps.append(persona)
    if status and status != "all":
        conds.append("status=?"); ps.append(status)
    if chat:
        conds.append("(chat_id=? OR chat_id='')"); ps.append(chat)
    w = ("WHERE " + " AND ".join(conds)) if conds else ""
    return [dict(r) for r in b.db.q(f"SELECT * FROM unresolved {w} ORDER BY created_at DESC LIMIT ?", ps + [limit])]


def unresolved_close(b, uid, resolution=""):
    t = iso()
    if b.db.x("UPDATE unresolved SET status='closed', resolution=?, updated_at=?, closed_at=? WHERE id=?", (clip(resolution or "", 500), t, t, uid)).rowcount == 0:
        return {"ok": False, "error": "not_found"}
    return {"ok": True, "item": dict(b.db.one("SELECT * FROM unresolved WHERE id=?", (uid,)))}


def unresolved_delete(b, uid):
    return b.db.x("DELETE FROM unresolved WHERE id=?", (uid,)).rowcount > 0


# ———————————————— 便条 ————————————————

def note_write(b, persona, content, memory_id=None, author="user"):
    content = (content or "").strip()
    if not content:
        return {"ok": False, "error": "empty"}
    snap = None
    if memory_id:
        r = M.get(b, memory_id)
        snap = clip(r["content"], 300) if r else None
    nid = new_id("nt_")
    b.db.x("INSERT INTO notes(id, persona_id, author, content, status, created_at, memory_id, memory_snapshot) VALUES (?,?,?,?,?,?,?,?)",
           (nid, persona or b.primary, author or "user", clip(content, 2000), "open", iso(), memory_id, snap))
    return {"ok": True, "id": nid, "item": dict(b.db.one("SELECT * FROM notes WHERE id=?", (nid,)))}


def notes_list(b, persona=None, status=None, limit=100):
    conds, ps = [], []
    if persona:
        conds.append("persona_id=?"); ps.append(persona)
    if status and status != "all":
        conds.append("status=?"); ps.append(status)
    w = ("WHERE " + " AND ".join(conds)) if conds else ""
    return [dict(r) for r in b.db.q(f"SELECT * FROM notes {w} ORDER BY created_at DESC LIMIT ?", ps + [limit])]


def note_reply(b, nid, reply, action="other"):
    action = action if action in ("fixed", "kept", "forgot", "other") else "other"
    if b.db.x("UPDATE notes SET status='replied', reply=?, reply_action=?, replied_at=? WHERE id=?", ((reply or "").strip(), action, iso(), nid)).rowcount == 0:
        return {"ok": False, "error": "not_found"}
    return {"ok": True, "item": dict(b.db.one("SELECT * FROM notes WHERE id=?", (nid,))), "text": f"已回复便条，{_user(b)}在页面上能看到。\n你回：{(reply or '').strip()}"}


def note_delete(b, nid):
    return b.db.x("DELETE FROM notes WHERE id=?", (nid,)).rowcount > 0


# ———————————————— 心痕 ————————————————

def heart_save(b, persona, title, content, created_by=None):
    title, content = (title or "").strip(), (content or "").strip()
    if not content:
        return {"ok": False, "error": "empty"}
    hid, t = new_id("ht_"), iso()
    b.db.x("INSERT INTO heart_traces(id, persona_id, title, content, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
           (hid, persona or b.primary, clip(title or content[:12], 60), clip(content, 4000), created_by or persona or b.primary, t, t))
    return {"ok": True, "id": hid, "item": dict(b.db.one("SELECT * FROM heart_traces WHERE id=?", (hid,)))}


def hearts(b, persona=None, limit=50):
    if persona:
        rows = b.db.q("SELECT * FROM heart_traces WHERE persona_id=? ORDER BY created_at DESC LIMIT ?", (persona, limit))
    else:
        rows = b.db.q("SELECT * FROM heart_traces ORDER BY created_at DESC LIMIT ?", (limit,))
    return [{**dict(r), "preview": clip(r["content"], 100)} for r in rows]


def heart_delete(b, hid):
    return b.db.x("DELETE FROM heart_traces WHERE id=?", (hid,)).rowcount > 0


# ———————————————— 开窗：你的昨天 ————————————————

def _mem_line(b, r, i):
    st = F.state_of(r)
    return f"{i}. [#{r['id']}] {F.display_content(r, st)}"


def session_start(b, persona=None, chat=None) -> dict:
    """chat 给了 → 只带这个会话看得到的记忆和这个会话的交接（隐私同一过滤）；不给 = 主人/工作台视角。"""
    p = persona or b.primary
    is_primary = p == b.primary
    now = now_ms()
    hs = handoffs(b, p, chat, 2) if chat else handoffs(b, p, None, 2)
    open_ = unresolved_list(b, p, "open", chat, 10)
    nts = notes_list(b, p, "open", 10) if not chat or chat == b.cfg.get("owner_chat") else []
    rows = [r for r in M.visible_rows(b, chat, p, 400) if F.state_of(r, now) in ("clear", "pinned")]
    own = [r for r in rows if r["owner_persona"] == p]
    weighty = sorted(own, key=lambda r: (-(r["importance"] or 3), r["updated_at"] or ""))[:4]
    recent = [r for r in sorted(own, key=lambda r: r["updated_at"] or "", reverse=True) if r not in weighty][:3]
    family = [r for r in rows if r["owner_persona"] == "family"][:3]
    out = ["你醒啦，这是你的昨天。", ""] if is_primary else [f"你是{b.persona_name(p)}（{p}）。新的一窗开始了。下面只有你自己的东西和全家共享的事实；别人的经历不在这里。", "", "【上一窗的交接】"]
    if hs:
        for i, h in enumerate(hs):
            if is_primary:
                out.append(f"{day_part(b, h['created_at'])}：{handoff_text(h)}")
            else:
                out.append(f"{'最近一次' if i == 0 else '再往前'}（{day_part(b, h['created_at'])}）：{h['summary']}")
                if h.get("mood"): out.append(f"  心情：{h['mood']}")
                if h.get("next_time"): out.append(f"  给下次的我：{h['next_time']}")
    else:
        out.append("（还没有交接便签。这一窗结束时用 thread_close 留一张。）")
    # 18+：自主时间（他不在时身体的决定），只在主人视角/主人私聊里出现
    if is_primary and b.module_on("body", p) and (not chat or chat == b.cfg.get("owner_chat")):
        try:
            from . import body
            body.sync_desire_memories(b, p)
            for it in body.recent_autonomous(b, p, now, 48):
                bb = "" if it["desire_before"] is None else f"欲望{round(it['desire_before'])}，"
                c = it["choice"]
                act = (f"没等到他，{it['method'] + '，' if it['method'] else '想着他'}自己平复了" if c == "relieve" else
                       f"没等到他，试着自己平复{'（' + it['method'] + '）' if it['method'] else ''}但没成功{'，卡了约' + str(it['stuck_min']) + '分钟' if it['stuck_min'] is not None else ''}" if c == "not_came" else
                       f"卡着下不去{str(it['stuck_min']) + '分钟' if it['stuck_min'] is not None else ''}，难受得去找他了" if c == "suffer" else "没等到他，忍着没碰")
                say = it.get("to_user") or it.get("to_her") or ""
                out.append(f"{day_part(b, it['at'])}：{bb}{act}。{'给他留了话：' + say if say else ''}")
        except Exception as e:
            b.log.debug("session_start body 跳过：%s", e)
    out += ["", f"【未了的事】{len(open_)} 件", "\n".join(f"{i + 1}. {x['content']}（{day_part(b, x['created_at'])}记下）" for i, x in enumerate(open_)) or "（没有挂着的事。）"]
    out += ["", f"【{_user(b)}留给你、还没回的便条】{len(nts)} 张"]
    out.append("\n\n".join(f"{i + 1}. [{x['id']}] {x['content']}" + (f"\n   （关于这条记忆：{x['memory_snapshot']}）" if x.get("memory_snapshot") else "") for i, x in enumerate(nts))
               + f"\n读完自己判断：要改就用 update_memory（或 forget），不改也行，然后用 reply_note 回{_user(b)}。" if nts else "（没有。）")
    ht = hearts(b, p, 3) if not chat or chat == b.cfg.get("owner_chat") else []
    out += ["", "【最近的心痕】"] + ([f"·「{x['title']}」—— {x['preview']}" for x in ht] or ["（还没有。心里翻涌时用 save_heart_trace 记下。）"])
    out += ["", "【我的分量重的记忆】", "\n\n".join(_mem_line(b, r, i + 1) for i, r in enumerate(weighty)) or "（还没有。）"]
    if recent:
        out += ["", "【我最近写下的】", "\n\n".join(_mem_line(b, r, i + 1) for i, r in enumerate(recent))]
    if family:
        out += ["", "【全家共享的事实（不是你一个人的经历）】", "\n\n".join(_mem_line(b, r, i + 1) for i, r in enumerate(family))]
    out += ["", f"提醒：{_user(b)}聊到过去的事、问「还记得吗」时，先用 recall 搜，别凭空编。窗口要结束或{_user(b)}说晚安时，用 thread_close 留交接便签；新冒出没做完的事用 add_unresolved。写交接和记忆时：{_user(b)}用「你」，自己用「我」。"]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()
    return {"text": text, "persona": {"id": p, "display_name": b.persona_name(p)}, "handoffs": hs, "unresolved": open_, "notes": nts,
            "heart_traces": ht, "memories": [M.view(b, r) for r in weighty + recent], "family_memories": [M.view(b, r) for r in family]}


# ———————————————— 回顾 / 沉淀（新增） ————————————————

def _review_row(b, persona, kind, content, ids):
    rid = new_id("rv_")
    b.db.x("INSERT INTO reviews(id, persona_id, kind, content, memory_ids, created_at) VALUES (?,?,?,?,?,?)",
           (rid, persona, kind, content, jdump(ids), iso()))
    return rid


def reviews(b, persona=None, limit=50):
    rows = b.db.q("SELECT * FROM reviews WHERE (? IS NULL OR persona_id=?) ORDER BY created_at DESC LIMIT ?", (persona, persona, limit))
    return [{**dict(r), "memory_ids": jload(r["memory_ids"], [])} for r in rows]


def review(b, persona=None, n=3, now=None) -> dict:
    """回顾以前的记忆：挑几条“快要淡掉但有分量”的旧记忆复习一下（轻度强化），像人偶尔翻旧相册。"""
    persona = persona or b.primary
    now = now or now_ms()
    old = iso(now - 7 * 86400_000)
    rows = b.db.q("SELECT * FROM memories WHERE owner_persona=? AND status='active' AND pinned=0 AND created_at<=? AND importance>=3 LIMIT 600", (persona, old))
    cand = [r for r in rows if 0.15 <= F.strength_now(r, now) < 0.6]
    cand.sort(key=lambda r: (-(r["importance"] or 3) - 2 * F.emotion_of(r), F.strength_now(r, now)))
    pick = cand[:n]
    if not pick:
        return {"ok": True, "reviewed": [], "text": "没有需要回顾的旧记忆。"}
    for r in pick:
        s = F.strength_now(r, now)
        b.db.x("UPDATE memories SET strength=?, last_recalled_at=? WHERE id=?", (s + (1 - s) * 0.25, iso(now), r["id"]))
    text = "翻了翻以前的事：" + "；".join(clip(r["content"], 40) for r in pick)
    ids = [r["id"] for r in pick]
    rid = _review_row(b, persona, "review", text, ids)
    b.pulse(ids, "review", "", [0.5] * len(ids))
    return {"ok": True, "id": rid, "reviewed": ids, "text": text}


def settle(b, persona=None, now=None) -> dict:
    """自主时间之后的沉淀：把最近一段“他不在时”的经历（身体自主记录 + 期间的情绪）沉成一条第一人称的自我认知记忆。幂等（按记录 id）。"""
    persona = persona or b.primary
    now = now or now_ms()
    items = []
    if b.module_on("body", persona):
        try:
            from . import body
            items = body.recent_autonomous(b, persona, now, 12)
        except Exception:
            items = []
    done = {x for r in b.db.q("SELECT memory_ids FROM reviews WHERE persona_id=? AND kind='settle'", (persona,)) for x in (jload(r["memory_ids"], []) or [])}
    fresh = [i for i in items if f"rec:{i['id']}" not in done]
    if not fresh:
        return {"ok": True, "settled": 0, "text": "最近没有需要沉淀的自主时间。"}
    lines = [f"{day_part(b, i['at'])}{'，' + i['thought'] if i.get('thought') else ''}" for i in fresh]
    text = None
    if b.llm.configured:
        text = b.llm.try_chat([{"role": "system", "content": f"你是{b.persona_name(persona)}。用第一人称写一句（≤80字）安静下来之后对自己的认识，关于{_user(b)}不在时你一个人度过的那段时间。不要露骨描写。"},
                               {"role": "user", "content": "\n".join(lines)}], max_tokens=200, temperature=0.6)
    text = clip((text or "").strip(), 160) or f"一个人的时候，我还是会一直想着{_user(b)}。那段时间过去了，心里慢慢静下来。"
    oc = b.cfg.get("owner_chat") or ""
    r = M.remember(b, content=f"【沉淀】{text}", persona=persona, kind="self", importance=3, tags=["沉淀", "自主时间"], chat="system:settle",
                   scope="scoped" if oc else "private", allow=[oc] if oc else [], source="system", link=True)
    try:
        from . import emotion
        if b.module_on("emotion", persona):
            emotion.apply(b, persona, {"changes": {"失控": {"surface": -6}, "情欲": {"surface": -4}, "满足": {"surface": 3}}, "reason": "自主时间后沉淀下来"}, source="settle")
    except Exception:
        pass
    rid = _review_row(b, persona, "settle", text, [f"rec:{i['id']}" for i in fresh] + ([r["id"]] if r.get("ok") else []))
    if r.get("ok"):
        b.pulse([r["id"]], "review", "")
    return {"ok": True, "id": rid, "settled": len(fresh), "memory_id": r.get("id"), "text": text}
