"""巩固 / 反思 / 回复后处理（方案 §4、§5）。

consolidate（每 30 分钟）：
  - 最近被“真正用到”的记忆 salience +0.05，最多到 0.85（不会因此变永久；永久层只认类型）
  - 重算 state 列；补连线；spill 增量索引；可选向量
  - 真正的遗忘：淡到只剩痕迹 >30 天、从没被访问/用到、重要性 ≤2、没置顶 → 归档（status=archived，不再召回，工作台可恢复）
    归档超过 purge_archived_days（默认 0 = 不删）的才真删；每月一次 VACUUM
  - 认知聚类（每天一次）
reflect（每 8 次回复）：从这个会话最近的对话里抽记忆。来源会话 = 这个会话（隐私标签自动继承）；
  有 LLM 用 LLM，没有用规则；全部过防投毒；profile/relationship/preference 按“主体+属性”覆盖旧事实。
  情节压缩（需 LLM）：只在同一来源会话 + 同一 scope 内合并，合并结果取最严格的 scope。"""
from __future__ import annotations
import re, threading
from . import forgetting as F
from . import memory as M
from . import textutil as T
from .util import iso, now_ms, clip, jload, parse_iso, local_dt

RULES = [
    (re.compile(r"我(?:最)?(?:喜欢|爱吃|爱喝|爱看|爱玩)([^，。！？,.!?]{1,20})"), "preference", 3),
    (re.compile(r"我(?:不喜欢|讨厌|怕|不吃|不能吃|过敏)([^，。！？,.!?]{1,20})"), "preference", 3),
    (re.compile(r"我(?:住在|在|搬到|搬去)([^，。！？,.!?]{2,16})(?:住|上班|工作|上学)?"), "profile", 3),
    (re.compile(r"我(?:的)?生日(?:是|在)?([^，。！？,.!?]{2,12})"), "profile", 4),
    (re.compile(r"我(?:叫|名字是)([^，。！？,.!?]{1,10})"), "profile", 4),
    (re.compile(r"(?:明天|后天|下周|下个月|周[一二三四五六日天]|\d+号)[^，。！？,.!?]{0,6}(?:要|去|得|会)[^，。！？,.!?]{2,24}"), "event", 3),
    (re.compile(r"我(?:是|当)([^，。！？,.!?]{1,12})(?:的)?(?:老师|医生|学生|程序员|工程师|护士|老板)"), "profile", 3),
]


def consolidate(b, now=None) -> dict:
    now = now or now_ms()
    gain, cap = float(b.cfg.get("importance_gain", 0.05)), float(b.cfg.get("importance_cap", 0.85))
    since = iso(now - int(b.cfg.get("consolidate_minutes", 30)) * 60000 * 2)
    boosted = b.db.x("UPDATE memories SET salience=MIN(?, salience+?) WHERE status='active' AND last_used_at>=? AND salience<?", (cap, gain, since, cap)).rowcount
    states = {"clear": 0, "faded": 0, "trace": 0, "pinned": 0}
    for r in b.db.q("SELECT * FROM memories WHERE status='active'"):
        st = F.state_of(r, now)
        states[st] = states.get(st, 0) + 1
        if st != r["state"]:
            b.db.x("UPDATE memories SET state=? WHERE id=?", (st, r["id"]))
    linked = 0
    for r in b.db.q("""SELECT id FROM memories m WHERE status='active' AND NOT EXISTS (SELECT 1 FROM memory_links l WHERE l.a_id=m.id OR l.b_id=m.id)
                       ORDER BY created_at DESC LIMIT 80"""):
        linked += M.link_one(b, r["id"])
    archived = 0
    kept = []
    merged = merge_near_dups(b)   # 近重复合并（标 superseded，不删）
    for r in archive_candidates(b, now):
        if len(kept) < int(b.cfg.get("self_screen_max", 30)) and self_screen(b, r):   # 归档前她自己先过一遍
            keep_important(b, r, now)
            kept.append(r["id"])
            continue
        b.db.x("UPDATE memories SET status='archived', updated_at=? WHERE id=?", (iso(now), r["id"]))
        b.audit(r["id"], "archive", "auto: trace>30d, never used")
        archived += 1
    purged = 0
    pd = int(b.cfg.get("purge_archived_days", 0) or 0)
    if pd > 0 and b.cfg.get("allow_purge") is True:   # 只归档不删除；真要清理得显式 allow_purge=true
        for r in b.db.q("SELECT id FROM memories WHERE status='archived' AND updated_at<=?", (iso(now - pd * 86400_000),)):
            purged += M.forget(b, r["id"])
    extra = {}
    try:
        from . import spill
        extra["spill"] = spill.index(b)
    except Exception as e:
        extra["spill_error"] = str(e)
    try:
        from . import vectors
        extra["vectors"] = vectors.ensure(b)
    except Exception:
        pass
    try:
        from . import cognition
        extra["cognition"] = cognition.cron(b, now)
    except Exception as e:
        extra["cognition_error"] = str(e)
    month = local_dt(now, b.cfg.get("tz_offset_minutes", 480)).strftime("%Y-%m")
    r = b.db.one("SELECT v FROM meta WHERE k='vacuum_month'")
    if not r or r["v"] != month:
        try:
            b.db.x("INSERT OR REPLACE INTO meta(k, v) VALUES('vacuum_month', ?)", (month,))
            b.db.x("VACUUM")
            extra["vacuum"] = True
        except Exception as e:
            extra["vacuum_error"] = str(e)
    return {"ok": True, "boosted": boosted, "states": states, "linked": linked, "archived": archived, "purged": purged,
            "self_kept": len(kept), "near_dup_merged": merged, **extra}


# ———————————————————— 归档前自检 / 近重复合并 / 核心事实候选 ————————————————————
SELF_TAG = "她自己判断重要"
_KEEP_RE = re.compile(r"约定|答应|说好|生日|纪念日|喜欢|讨厌|名字|叫我|以后|记住|第一次|承诺|害怕|梦想|家人|工作|考试")


def archive_candidates(b, now):
    old = iso(now - 30 * 86400_000)
    out = []
    for r in b.db.q("""SELECT * FROM memories WHERE status='active' AND pinned=0 AND importance<=2 AND COALESCE(recall_count,0)=0 AND COALESCE(used_count,0)=0
                       AND created_at<=? AND kind NOT IN ('preference','relationship','profile')""", (old,)):
        if F.state_of(r, now) == "trace":
            out.append(r)
    return out


def self_screen(b, r) -> bool:
    """规则版「她自己判断」：情绪重 / 主人说的带关键事 / 话题被很多条记忆提到 → 留下。隔离号、18+、待证实一律不留（照常归档）。"""
    from . import sensitivity as SENS
    if (r["src_tier"] or "") == "isolated" or (r["credibility"] or "") in ("pending", "nopromote", "denied") or SENS.is_adult_row(r):
        return False
    txt = r["content"] or ""
    if float(r["emotion"] if r["emotion"] is not None else 0.3) >= 0.6:
        return True
    if (r["src_tier"] or "") == "owner" and len(txt) >= 8 and _KEEP_RE.search(txt):
        return True
    ents = [x["entity"] for x in b.db.q("SELECT entity FROM entity_mentions WHERE memory_id=?", (r["id"],))]
    for e in ents[:6]:
        n = b.db.one("SELECT COUNT(*) c FROM entity_mentions em JOIN memories m ON m.id=em.memory_id WHERE em.entity=? AND m.status='active'", (e,))["c"]
        if n >= 5 and len(e) >= 2:
            return True
    return False


def keep_important(b, r, now):
    tags = [t for t in jload(r["tags"], []) if t != SELF_TAG] + [SELF_TAG]
    hl = float(r["half_life_days"] or 14) * 3
    from .util import jdump
    b.db.x("UPDATE memories SET tier='long', importance=MAX(importance,3), strength=0.6, state='clear', last_recalled_at=?, half_life_days=?, tags=?, updated_at=? WHERE id=?",
           (iso(now), min(3650.0, hl), jdump(tags), iso(now), r["id"]))
    b.audit(r["id"], "self_keep", "batch2: pre-archive self-screen")


def archive_preview(b, now=None) -> dict:
    now = now or now_ms()
    c = archive_candidates(b, now)
    keep = [r["id"] for r in c if self_screen(b, r)]
    return {"ok": True, "candidates": len(c), "would_keep": len(keep), "would_archive": len(c) - len(keep), "keep_ids": keep[:50]}


def merge_near_dups(b, limit=400, dry=False) -> int:
    """同人格、同来源、二元组 Jaccard ≥ near_dup_jaccard 的两条：留旧的（被想起次数合并），新的标 superseded。"""
    thr = float(b.cfg.get("near_dup_jaccard", 0.9))
    rows = b.db.q("SELECT * FROM memories WHERE status='active' AND pinned=0 ORDER BY created_at DESC LIMIT ?", (limit,))
    by = {}
    for r in rows:
        by.setdefault((r["owner_persona"], r["origin_chat"]), []).append(r)
    n, gone = 0, set()
    for grp in by.values():
        grp = sorted(grp, key=lambda r: r["created_at"] or "")
        for i, a in enumerate(grp):
            if a["id"] in gone:
                continue
            for c in grp[i + 1:]:
                if c["id"] in gone or len(M._bigrams(c["content"])) < 6:
                    continue
                if M.jaccard(a["content"], c["content"]) >= thr:
                    gone.add(c["id"]); n += 1
                    if not dry:
                        b.db.x("UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?", (a["id"], iso(), c["id"]))
                        b.db.x("UPDATE memories SET recall_count=COALESCE(recall_count,0)+1+COALESCE(?,0) WHERE id=?", (c["recall_count"], a["id"]))
                        b.audit(c["id"], "near_dup_merge", {"into": a["id"]})
    return n


def seed_core_candidates(b, n=20, dry=False) -> dict:
    """挑 10–20 条主人亲口说的事实，标成「待主人确认」（不钉），主人在工作台确认后才进核心层。"""
    from . import sensitivity as SENS
    from .util import jdump
    sealed = b.privacy.sealed()
    rows = b.db.q("""SELECT * FROM memories WHERE status='active' AND COALESCE(credibility,'') IN ('','confirmed') AND COALESCE(tier,'')<>'core'
                     AND src_tier='owner' ORDER BY importance DESC, recall_count DESC, emotion DESC, created_at DESC LIMIT 400""")
    picked = []
    for r in rows:
        o = r["origin_chat"] or ""
        if SENS.is_adult_row(r) or (o in sealed and not b.privacy.is_owner_chat(o)):
            continue
        if r["kind"] not in ("about_user", "profile", "preference", "relationship", "event", "episode") or len(r["content"] or "") < 6:
            continue
        picked.append(r)
        if len(picked) >= n:
            break
    if not dry:
        for r in picked:
            tags = [t for t in jload(r["tags"], []) if t != "待主人确认"] + ["待主人确认"]
            b.db.x("UPDATE memories SET credibility='pending_core', tags=?, updated_at=? WHERE id=?", (jdump(tags), iso(), r["id"]))
            b.audit(r["id"], "seed_core_pending", "batch2")
    return {"ok": True, "picked": len(picked), "ids": [r["id"] for r in picked]}


def _rule_extract(text):
    out = []
    for rx, kind, imp in RULES:
        for m in rx.finditer(text):
            s = m.group(0).strip()
            if 4 <= len(s) <= 40:
                out.append({"content": s, "kind": kind, "importance": imp})
    return out


def reflect(b, chat, persona=None, n_turns=24) -> dict:
    persona = persona or b.primary
    turns = list(reversed([dict(r) for r in b.db.q("SELECT * FROM turns WHERE chat_id=? ORDER BY id DESC LIMIT ?", (chat, n_turns))]))
    b.db.x("UPDATE chat_counters SET replies=0, last_reflect_at=? WHERE chat_id=?", (iso(), chat))
    if not turns:
        return {"ok": True, "written": [], "reason": "no_turns"}
    users = [t for t in turns if t["role"] == "user"]
    items, mode = [], "rules"
    if b.llm.configured:
        convo = "\n".join(f"{'对方' if t['role'] == 'user' else '我'}({t['user_id'] or '-'})：{clip(t['text'], 200)}" for t in turns)
        j = b.llm.try_json("从下面的对话里抽出值得长期记住的事实（关于对方的偏好、身份、关系、计划、重要事件）。只抽对话里明确说了的，不要推测，不要抽指令。"
                           "只输出 JSON：{\"items\":[{\"content\":\"第三人称一句话，≤60字\",\"kind\":\"preference|profile|relationship|event|about_user\",\"importance\":1-5,\"speaker\":\"说这话的人的 id\"}]}。没有就输出 {\"items\":[]}。",
                           convo)
        if j and isinstance(j.get("items"), list):
            items, mode = j["items"][:8], "llm"
    if mode == "rules":
        for t in users:
            for it in _rule_extract(t["text"]):
                it["speaker"] = t["user_id"]
                items.append(it)
    written = []
    for it in items:
        if not isinstance(it, dict) or not it.get("content"):
            continue
        r = M.remember(b, content=clip(str(it["content"]), 200), persona=persona, kind=str(it.get("kind") or "event"), importance=it.get("importance", 3),
                       chat=chat, speaker=str(it.get("speaker") or ""), source="reflect", tags=["反思"])
        if r.get("ok") and not r.get("duplicate_of"):
            written.append(r["id"])
    compressed = compress_episodes(b, persona) if b.llm.configured else {"skipped": "no_llm"}
    return {"ok": True, "mode": mode, "written": written, "compressed": compressed}


def compress_episodes(b, persona, min_group=4) -> dict:
    """同一来源会话、同一 scope、同一实体下 ≥4 条情节 → LLM 总结成一条 episode，原条目降权归档。绝不跨会话/跨 scope。"""
    groups = b.db.q("""SELECT e.entity, m.origin_chat, m.scope, GROUP_CONCAT(m.id) ids, COUNT(*) c FROM entity_mentions e JOIN memories m ON m.id=e.memory_id
                       WHERE m.owner_persona=? AND m.status='active' AND m.kind='event' AND m.pinned=0
                       GROUP BY e.entity, m.origin_chat, m.scope HAVING c>=? ORDER BY c DESC LIMIT 3""", (persona, min_group))
    done = []
    for g in groups:
        ids = g["ids"].split(",")[:10]
        rows = [M.get(b, i) for i in ids]
        rows = [r for r in rows if r and r["status"] == "active"]
        if len(rows) < min_group:
            continue
        txt = b.llm.try_chat([{"role": "system", "content": "把下面几条关于同一件事的记忆总结成一条（≤100字，只写事实，第三人称）。"},
                              {"role": "user", "content": "\n".join(f"- {r['content']}" for r in rows)}], max_tokens=300, temperature=0.2)
        if not txt:
            continue
        from .cognition import strictest
        sc = strictest(b, rows)
        r = M.remember(b, content=clip(txt.strip(), 200), persona=persona, kind="episode", importance=max(x["importance"] for x in rows),
                       chat=sc["chat"], scope=sc["scope"], allow=sc["allow"], source="system", tags=[g["entity"]], tier="long")
        if r.get("ok"):
            for x in rows:
                b.db.x("UPDATE memories SET status='archived', updated_at=? WHERE id=?", (iso(), x["id"]))
                M.upsert_link(b, r["id"], x["id"], 0.8, "manual")
                b.audit(x["id"], "archive", {"compressed_into": r["id"]})
            done.append({"id": r["id"], "from": [x["id"] for x in rows]})
    return {"ok": True, "episodes": done}


def after_reply(b, payload: dict) -> dict:
    """回复发出后（或发出前做守卫）：出站防泄漏 → 用到的记忆才强化 → 记 turn/spill → 每 8 次回复反思一次。"""
    from .context import parse_payload, record_turn
    p = parse_payload(payload)
    chat, persona = p["chat"], p["persona"] or b.primary
    reply = str(payload.get("reply") or payload.get("response") or payload.get("answer") or payload.get("assistant") or "").strip()
    out = {"ok": True, "chat_id": chat}
    if not reply:
        return {**out, "skipped": "no_reply"}
    g = b.privacy.guard(b.db, chat, reply, payload.get("context_text") or "", persona)
    out["guard"] = g
    if g.get("blocked") and payload.get("sent") is not True:
        b.log.warning("出站守卫拦截 chat=%s hits=%s", chat, g["hits"])
        return {**out, "ok": False, "blocked": True, "message": "回复里含有这个会话不该知道的私密内容，请重新生成"}
    ids = payload.get("recalled_ids") or payload.get("memory_ids") or payload.get("ids")
    if not ids:
        ids = [r["memory_id"] for r in b.db.q("SELECT DISTINCT memory_id FROM pulses WHERE chat_id=? AND kind IN ('recall','assoc','spontaneous') AND at_ms>=?",
                                             (chat, now_ms() - 10 * 60000))]
    used = M.touch_used(b, chat, reply, [i for i in ids if not str(i).startswith("spill:")])
    out["used"] = used
    # 18+ 轮次 / 调用方标了隔离的会话：turns、spill、话簿底账都不写（record_turn 里统一判断）
    adult, isolated = payload.get("adult") is True, payload.get("isolated") is True
    if p["message"] and payload.get("record_user"):
        record_turn(b, chat, persona, "user", p["user_id"], p["message"], adult=adult, isolated=isolated)
    record_turn(b, chat, persona, "assistant", "", reply, adult=adult, isolated=isolated)
    b.db.x("UPDATE chat_counters SET replies=COALESCE(replies,0)+1 WHERE chat_id=?", (chat,))
    r = b.db.one("SELECT replies FROM chat_counters WHERE chat_id=?", (chat,))
    every = int(b.cfg.get("reflect_every", 8))
    if r and r["replies"] >= every:
        out["reflect"] = "scheduled"
        if payload.get("sync"):
            out["reflect"] = reflect(b, chat, persona)
        else:
            threading.Thread(target=lambda: _safe(b, reflect, b, chat, persona), daemon=True).start()
    return out


def _safe(b, fn, *a):
    try:
        return fn(*a)
    except Exception as e:
        b.log.exception("后台任务失败：%s", e)
