"""记忆读写 + 召回候选（BM25 / FTS trigram / 实体扩散 / 连线扩散 / 可选向量）。
所有读路径都过 privacy.visible_sql(chat) 这一个硬过滤。"""
from __future__ import annotations
import math, random, re
from . import textutil as T
from . import forgetting as F
from .util import iso, now_ms, new_id, jdump, jload, clip, parse_iso

KINDS = {"self", "about_user", "relationship", "event", "preference", "diary", "profile", "cognition", "episode"}
GENERIC_TAGS = {"对话", "日志", "系统", "chat", "log", "交接", "handoff", "记忆屋"}
ASSOC_MAX, ASSOC_MIN_SCORE, ASSOC_CLIP = 2, 0.3, 120
ASSOC_NEIGHBOR_BOOST, ASSOC_NEIGHBOR_MAX = 0.05, 3
CO_RECALL_INIT, CO_RECALL_STEP = 0.15, 0.05
STRICT = {"public": 0, "inherit": 1, "scoped": 2, "private": 3}


def _tags(t) -> list[str]:
    if isinstance(t, list):
        return [str(x).strip() for x in t if str(x).strip()]
    v = jload(t, None)
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [x for x in re.split(r"[,，\s]+", str(t or "")) if x]


def view(b, r, now=None) -> dict:
    """统一的记忆输出结构（星图/工作台/API 共用）。"""
    now = now or now_ms()
    d = dict(r)
    st = F.state_of(d, now)
    s = F.strength_now(d, now)
    d["tags"] = _tags(d.get("tags"))
    d["allow"] = jload(d.get("allow"), []) or []
    d["state"] = st
    d["strength"] = round(s, 4)
    d["clarity"] = round(s, 4)
    d["pinned"] = st == "pinned"
    d["effective_scope"] = b.privacy.effective(d)
    d["persona"] = d.get("owner_persona")
    d["persona_name"] = b.persona_name(d.get("owner_persona") or "")
    d.pop("seg", None)
    return d


# ———————————————————— 写 ————————————————————

def _index(b, mid: str, content: str, tags: list[str]):
    b.db.x("DELETE FROM memories_fts WHERE id=?", (mid,))
    b.db.x("INSERT INTO memories_fts(id, content) VALUES (?,?)", (mid, content + " " + " ".join(tags)))
    b.db.x("DELETE FROM entity_mentions WHERE memory_id=?", (mid,))
    ents = set(T.entities(content)) | {t for t in tags if len(t) >= 2 and t.lower() not in GENERIC_TAGS}
    if ents:
        b.db.many("INSERT OR IGNORE INTO entity_mentions(memory_id, entity) VALUES (?,?)", [(mid, e.lower()) for e in ents])
    T.add_user_words(tags)


def remember(b, *, content: str, persona: str | None = None, kind: str = "event", importance=3, tags=None,
             chat: str = "system", speaker: str = "", scope: str = "inherit", allow=None, emotion=None, pin=None,
             event_date=None, source: str = "api", created_by=None, salience=None, fact_key: str | None = None,
             check_poison: bool = True, created_at: str | None = None, mid: str | None = None, link=True, tier="short",
             src_tier: str | None = None) -> dict:
    content = (content or "").strip()
    if not content:
        return {"ok": False, "error": "empty", "message": "内容是空的"}
    persona = persona or b.primary
    kind = kind if kind in KINDS else "event"
    tags = _tags(tags)
    if str(source or "").startswith("web:"):   # t163：上网学的 = 外来知识。只当常识，不当人的事实，不压主人事实
        if kind not in ("cognition", "event"):
            kind = "cognition"
        if "上网学的" not in tags:
            tags = tags + ["上网学的"]
        src_tier = "other"
    from . import sensitivity as SENS  # 18+：写入时打 nsfw 标签
    tags = SENS.mark_tags(content, tags, kind, source)
    try:
        importance = max(1, min(5, int(round(float(importance)))))
    except (TypeError, ValueError):
        importance = 3
    if check_poison and source not in ("persona", "mcp", "migrate", "seed", "system", "dream", "body"):
        p = T.is_poison(content)
        if p:
            b.log.info("防投毒拦截：%s", clip(content, 60))
            return {"ok": False, "error": "poison", "message": f"像是指令/命令，不进长期记忆（命中「{p}」）"}
    scope = scope if scope in ("inherit", "private", "scoped", "public") else "inherit"
    allow = [str(x) for x in (allow or [])]
    now = created_at or iso()
    # 来源分层（主人 / 别人 / 隔离号·18+ / 系统）
    st = src_tier if src_tier in SRC_TIERS else b.privacy.src_tier(speaker, chat, source, tags)
    if st == "other":
        content = clean_other(content)
        if not content:
            return {"ok": False, "error": "empty", "message": "清洗后是空的"}
    cred, fact_like = "", kind in FACT_KINDS
    if fact_like and st == "other":
        pin, cred = False, "pending"          # 别人说的事实：先待证实，不钉、不覆盖旧事实
        if "待证实" not in tags:
            tags = tags + ["待证实"]
    elif st == "isolated":
        pin, cred, tier = False, "nopromote", "short"   # 隔离号 / 18+：永不升格
    if emotion is None:
        emotion = emotion_rule(content, kind)   # 写入时按规则打情绪分
    # 去重：同一人格、同一来源、正文一样 → 当作想起一次
    dup = b.db.one("SELECT * FROM memories WHERE owner_persona=? AND status='active' AND content=? AND origin_chat=?", (persona, content, chat))
    near = None if dup else near_duplicate(b, persona, chat, content)   # 近重复也合并
    dup = dup or near
    if dup:
        reinforce(b, dup["id"], chat=chat, kind="dup")
        promoted = maybe_promote(b, dup["id"])
        return {"ok": True, "id": dup["id"], "duplicate_of": dup["id"], "near": bool(near), "promoted": promoted, "superseded": [], "scope": dup["scope"], "effective_scope": b.privacy.effective(dup)}
    fk = fact_key if fact_key is not None else (T.fact_key(speaker or chat, content) if kind in ("about_user", "profile", "relationship", "preference") else "")
    init = F.initial_fields(importance, kind, tags, content, now, emotion, pin, b.cfg.get("pin_by_importance5", False))
    if salience is None:
        salience = round(0.3 + importance * 0.08, 3)
    mid = mid or new_id("m_")
    with b.db.tx():
        b.db.x("""INSERT INTO memories (id, owner_persona, created_by, kind, visibility, content, importance, salience, tags, event_date,
                   source_platform, created_at, updated_at, strength, emotion, half_life_days, last_recalled_at, recall_count, state, pinned,
                   scope, origin_chat, allow, speaker, fact_key, status, tier, seg, src_tier, credibility)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
               (mid, persona, created_by or persona, kind, "family" if persona == "family" else "private", content, importance, float(salience),
                jdump(tags), event_date, source, now, now, init["strength"], init["emotion"], init["half_life_days"], init["last_recalled_at"], 0,
                init["state"], init["pinned"], scope, chat, jdump(allow), str(speaker or ""), fk, "active", tier, T.seg_text(content), st, cred))
    _index(b, mid, content, tags)
    superseded = []
    if fk and st in FACT_TIERS:   # 只有主人/系统说的事实能取代旧事实
        for old in b.db.q("SELECT id, scope FROM memories WHERE fact_key=? AND owner_persona=? AND status='active' AND id<>?", (fk, persona, mid)):
            b.db.x("UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?", (mid, now, old["id"]))
            b.audit(old["id"], "superseded", {"by": mid})
            superseded.append(old["id"])
    if link:
        try:
            link_one(b, mid)
        except Exception as e:
            b.log.warning("连线失败 %s: %s", mid, e)
    b.audit(mid, "create", {"source": source, "chat": chat, "src_tier": st})
    promoted = maybe_promote(b, mid) if cred == "pending" else False
    r = b.db.one("SELECT * FROM memories WHERE id=?", (mid,))
    return {"ok": True, "id": mid, "superseded": superseded, "duplicate_of": None, "src_tier": st, "pending": cred == "pending" and not promoted, "promoted": promoted, "scope": scope, "effective_scope": b.privacy.effective(r)}


def get(b, mid: str):
    return b.db.one("SELECT * FROM memories WHERE id=?", (mid,))


def update(b, mid: str, patch: dict) -> dict | None:
    from . import sensitivity as SENS
    if isinstance(patch, dict) and patch.get("content") == SENS.HIDDEN:  # 展示层的占位符不能被存回去
        patch = {k: v for k, v in patch.items() if k != "content"}
    r = get(b, mid)
    if not r:
        return None
    sets, vals = [], []
    if "content" in patch and str(patch["content"]).strip():
        sets += ["content=?", "seg=?"]; vals += [patch["content"].strip(), T.seg_text(patch["content"])]
    if "importance" in patch:
        imp = max(1, min(5, int(patch["importance"])))
        sets += ["importance=?"]; vals += [imp]
        if not F.is_pinned(r):
            sets += ["half_life_days=?"]; vals += [F.base_half_life(imp, F.emotion_of(r), False)]
    if "salience" in patch:
        sets += ["salience=?"]; vals += [max(0.0, min(1.0, float(patch["salience"])))]
    if "tags" in patch:
        new_tags = _tags(patch["tags"])
        sets += ["tags=?"]; vals += [jdump(new_tags)]
        # 主人在记忆列表里改标签就等于审核——加「核心」= 确认成核心事实（钉住、进 core 层）；
        # 去掉「待主人确认/待证实」又没加核心 = 不升格，回到普通记忆（不删、不降级）
        old_tags = _tags(r["tags"])
        cred = r["credibility"] or ""
        if "核心" in new_tags and "核心" not in old_tags:
            sets += ["tier='core'", "credibility='confirmed'"]
            if "pinned" not in patch:
                sets += ["pinned=1", "state='pinned'"]
        elif cred == "pending_core" and "待主人确认" in old_tags and "待主人确认" not in new_tags:
            sets += ["credibility=''"]
        elif cred == "pending" and "待证实" in old_tags and "待证实" not in new_tags:
            sets += ["credibility=''"]
    if "kind" in patch and patch["kind"] in KINDS:
        sets += ["kind=?"]; vals += [patch["kind"]]
    if "scope" in patch and patch["scope"] in ("inherit", "private", "scoped", "public"):
        sets += ["scope=?"]; vals += [patch["scope"]]
    if "allow" in patch:
        sets += ["allow=?"]; vals += [jdump([str(x) for x in patch["allow"] or []])]
    if "emotion" in patch:
        sets += ["emotion=?"]; vals += [F.clamp01(patch["emotion"])]
    if "event_date" in patch:
        sets += ["event_date=?"]; vals += [patch["event_date"]]
    if "status" in patch and patch["status"] in ("active", "archived", "superseded"):
        sets += ["status=?"]; vals += [patch["status"]]
    if "faded_text" in patch:
        sets += ["faded_text=?"]; vals += [patch["faded_text"]]
    if "pinned" in patch:
        if patch["pinned"]:
            sets += ["pinned=1", "state='pinned'"]
        else:
            s = F.strength_now({**dict(r), "pinned": 0, "state": "clear"})
            sets += ["pinned=0", "state=?", "strength=?", "last_recalled_at=?"]
            vals += ["clear", max(s, 0.6), iso()]
    if not sets:
        return dict(r)
    sets.append("updated_at=?"); vals.append(iso())
    b.db.x(f"UPDATE memories SET {', '.join(sets)} WHERE id=?", vals + [mid])
    r2 = get(b, mid)
    _index(b, mid, r2["content"], _tags(r2["tags"]))
    b.audit(mid, "update", {k: patch[k] for k in patch if k != "content"} | ({"content": "…"} if "content" in patch else {}))
    return dict(r2)


def forget(b, mid: str) -> bool:
    """真遗忘：行、索引、实体、连线、向量全删（审计里只留 id）。"""
    if not get(b, mid):
        return False
    with b.db.tx():
        b.db.x("DELETE FROM memories WHERE id=?", (mid,))
        b.db.x("DELETE FROM memories_fts WHERE id=?", (mid,))
        b.db.x("DELETE FROM entity_mentions WHERE memory_id=?", (mid,))
        b.db.x("DELETE FROM memory_links WHERE a_id=? OR b_id=?", (mid, mid))
        b.db.x("DELETE FROM memory_embeddings WHERE memory_id=?", (mid,))
        b.db.x("DELETE FROM pulses WHERE memory_id=?", (mid,))
    b.audit(mid, "forget", "")
    return True


def supersede(b, mid: str, content: str, keep_scope=True) -> dict:
    r = get(b, mid)
    if not r:
        return {"ok": False, "error": "not_found"}
    res = remember(b, content=content, persona=r["owner_persona"], kind=r["kind"], importance=r["importance"], tags=_tags(r["tags"]),
                   chat=r["origin_chat"], speaker=r["speaker"], scope=r["scope"] if keep_scope else "inherit", allow=jload(r["allow"], []),
                   emotion=r["emotion"], source="supersede", fact_key="", check_poison=False)
    if res.get("ok"):
        b.db.x("UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?", (res["id"], iso(), mid))
        b.audit(mid, "superseded", {"by": res["id"]})
        upsert_link(b, mid, res["id"], 0.8, "manual")
        return {"ok": True, "new_id": res["id"], "old_id": mid}
    return res


def reinforce(b, mid: str, chat="", kind="used", nudge=True) -> dict | None:
    r = get(b, mid)
    if not r:
        return None
    p = F.reinforce_patch(r)
    if kind == "used":   # 只有回复里真用到才算 used；重复/复习/确认只算想起
        b.db.x("UPDATE memories SET strength=?, half_life_days=?, recall_count=?, last_recalled_at=?, state=?, used_count=COALESCE(used_count,0)+1, last_used_at=? WHERE id=?",
               (p["strength"], p["half_life_days"], p["recall_count"], p["last_recalled_at"], p["state"], iso(), mid))
    else:
        b.db.x("UPDATE memories SET strength=?, half_life_days=?, recall_count=?, last_recalled_at=?, state=? WHERE id=?",
               (p["strength"], p["half_life_days"], p["recall_count"], p["last_recalled_at"], p["state"], mid))
    if nudge:
        nudge_neighbors(b, mid)
    b.pulse([mid], kind, chat)
    return p


# ———————————————————— 连线（心流） ————————————————————

def upsert_link(b, x: str, y: str, weight: float, kind: str):
    if x == y:
        return
    a, c = (x, y) if x < y else (y, x)
    w = max(0.0, min(1.0, weight))
    now = iso()
    b.db.x("""INSERT INTO memory_links (a_id,b_id,weight,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)
              ON CONFLICT(a_id,b_id) DO UPDATE SET
                kind = CASE WHEN memory_links.kind='manual' THEN 'manual' WHEN excluded.weight > memory_links.weight THEN excluded.kind ELSE memory_links.kind END,
                weight = MAX(memory_links.weight, excluded.weight), updated_at = excluded.updated_at""", (a, c, w, kind, now, now))


def co_recall(b, ids):
    u = list(dict.fromkeys(ids))[:6]
    now = iso()
    for i in range(len(u)):
        for j in range(i + 1, len(u)):
            a, c = sorted((u[i], u[j]))
            b.db.x("""INSERT INTO memory_links (a_id,b_id,weight,kind,created_at,updated_at) VALUES (?,?,?,'co_recall',?,?)
                      ON CONFLICT(a_id,b_id) DO UPDATE SET weight = MIN(1.0, memory_links.weight + ?), updated_at = excluded.updated_at""",
                   (a, c, CO_RECALL_INIT, now, now, CO_RECALL_STEP))


def _jacc(a: set, c: set) -> float:
    return len(a & c) / max(1, len(a | c))


def link_one(b, mid: str) -> int:
    me = get(b, mid)
    if not me:
        return 0
    rows = b.db.q("SELECT id, owner_persona, tags, seg, created_at, origin_chat FROM memories WHERE status='active' AND id<>? AND (owner_persona=? OR owner_persona='family' OR ?='family') ORDER BY updated_at DESC LIMIT 1500",
                  (mid, me["owner_persona"], me["owner_persona"]))
    n = 0
    mine = set((me["seg"] or "").split())
    sims = []
    if mine:
        for o in rows:
            s = _jacc(mine, set((o["seg"] or "").split()))
            if s >= 0.22:
                sims.append((s, o))
    # 向量（可选）
    from . import vectors
    for o, s in vectors.similar(b, mid, top=4):
        sims.append((max(s, 0.3), o))
    sims.sort(key=lambda x: -x[0])
    for s, o in sims[:4]:
        upsert_link(b, mid, o["id"], min(1.0, 0.3 + s * 0.7), "semantic"); n += 1
    tags = {t for t in _tags(me["tags"]) if t.lower() not in GENERIC_TAGS}
    if tags:
        cand = [(len(tags & set(_tags(o["tags"]))), o) for o in rows]
        cand = sorted([c for c in cand if c[0] > 0], key=lambda x: -x[0])[:6]
        for k, o in cand:
            upsert_link(b, mid, o["id"], min(0.6, 0.25 + 0.1 * k), "tag"); n += 1
    # 同一天同一会话：时间边（很淡）
    day = (me["created_at"] or "")[:10]
    same = [o for o in rows if (o["created_at"] or "")[:10] == day and o["origin_chat"] == me["origin_chat"]][:3]
    for o in same:
        upsert_link(b, mid, o["id"], 0.2, "time"); n += 1
    return n


def neighbors(b, ids, limit=40):
    if not ids:
        return []
    q = ",".join("?" * len(ids))
    return b.db.q(f"""SELECT a_id src, b_id nb, weight w, kind k FROM memory_links WHERE a_id IN ({q})
                      UNION ALL SELECT b_id src, a_id nb, weight w, kind k FROM memory_links WHERE b_id IN ({q}) ORDER BY w DESC LIMIT ?""",
                  list(ids) + list(ids) + [limit])


def nudge_neighbors(b, mid: str):
    nb = [e["nb"] for e in neighbors(b, [mid], ASSOC_NEIGHBOR_MAX)]
    if not nb:
        return []
    out = []
    for r in b.db.q(f"SELECT * FROM memories WHERE id IN ({','.join('?' * len(nb))})", nb):
        if F.is_pinned(r):
            continue
        s = F.strength_now(r)
        b.db.x("UPDATE memories SET strength=?, last_recalled_at=? WHERE id=?", (s + (1 - s) * ASSOC_NEIGHBOR_BOOST, iso(), r["id"]))
        out.append(r["id"])
    return out


# ———————————————————— 读 ————————————————————

def visible_rows(b, chat: str | None, persona: str | None, limit=2500, extra="", params=()):
    vis, vp = b.privacy.visible_sql(chat, "m")
    pf, pp = ("AND m.owner_persona IN (?, 'family')", [persona]) if persona else ("", [])
    return b.db.q(f"SELECT m.* FROM memories m WHERE m.status='active' {pf} AND {vis} {extra} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ?",
                  pp + vp + list(params) + [limit])


def hormone_gain(b, persona: str) -> float:
    try:
        from .emotion import arousal_level
        return arousal_level(b, persona)
    except Exception:
        return 0.0


def candidates(b, *, chat: str | None, persona: str | None, query: str, prev: str = "", strict=True, limit=10, now=None,
               rand=None, cooldown_ms: int | None = None, exclude=(), adult: bool | None = None) -> dict:
    """候选召回。strict=True 走 companion-memory 自动浮现门槛（≥2 命中词 且 BM25≥4）。"""
    now = now or now_ms()
    rc = b.cfg.get("recall") or {}
    min_hits, min_bm25 = int(rc.get("min_hits", 2)), float(rc.get("min_bm25", 4.0))
    rows = [r for r in visible_rows(b, chat, persona) if not T.RECALL_NOISE.search((r["content"] or "")[:80] + (r["tags"] or ""))]
    # 18+：只有成人会话（默认=主人 QQ 私聊）才召回 nsfw 记忆
    if chat is not None:
        from . import sensitivity as SENS
        from .context import adult_chat_ok
        if not (adult is True and adult_chat_ok(b, chat)):   # 没明确传 adult=true（对上暗号）就不放 18+
            rows = [r for r in rows if not SENS.is_adult_row(r)]
    T.add_user_words(t for r in rows for t in _tags(r["tags"]))
    q = "\n".join(x for x in (prev.strip(), query.strip()) if x)
    toks = T.tokens(q)
    debug = {"query": clip(q, 200), "keywords": toks[:30], "scanned": len(rows), "candidates": 0, "above_threshold": 0, "min_hits": min_hits, "min_bm25": min_bm25,
             "zero_weight": [], "via": {}}
    if not rows:
        return {"items": [], "debug": debug, "toks": toks}
    by_id = {r["id"]: r for r in rows}
    scored: dict[str, dict] = {}
    df, rare_max = {}, 0
    if toks:
        docs = [(r["seg"] or T.seg_text(r["content"])).split() + [t.lower() for t in _tags(r["tags"])] for r in rows]
        res = T.bm25(docs, toks)
        df = {t: sum(1 for d in docs if t in d) for t in toks}
        rare_max = max(3, int(len(rows) * float(rc.get("rare_ratio", 0.08))))
        for r, (s, hits) in zip(rows, res):
            if hits:
                scored[r["id"]] = {"id": r["id"], "bm25": s, "hits": hits, "via": "bm25"}
    debug["candidates"] = len(scored)
    # FTS trigram 兜底（≥3 字的连续片段，例如专名）：给已命中的加分，未命中的补进来（hits 记片段）
    frags = [t for t in toks if len(t) >= 3][:5]
    if frags:
        idset = set(by_id)
        for frag in frags:
            try:
                fr = b.db.q("SELECT id FROM memories_fts WHERE memories_fts MATCH ? LIMIT 50", ('"' + frag.replace('"', '') + '"',))
            except Exception:
                fr = []
            for x in fr:
                if x["id"] not in idset:
                    continue
                c = scored.setdefault(x["id"], {"id": x["id"], "bm25": 0.0, "hits": [], "via": "fts"})
                if frag not in c["hits"]:
                    c["hits"] = list(c["hits"]) + [frag]
                    c["bm25"] += 2.5
    rare_ok = bool(rc.get("single_rare_hit", True))   # 中文短句：只命中 1 个但很少见的词（如“软考”“煤球”）也放行
    def _ok(v):
        if not strict or (len(v["hits"]) >= min_hits and v["bm25"] >= min_bm25):
            return True
        h = str(v["hits"][0]) if len(v["hits"]) == 1 else ""
        return rare_ok and len(h) >= 2 and 0 < df.get(h, 99) <= rare_max and v["bm25"] >= min_bm25 * 0.5
    passed = {k: v for k, v in scored.items() if _ok(v)}
    # 口语扩写兜底：自然问句分词后常常一个词都不剩（「还记得我最喜欢吃什么吗」），
    # 这时才用同义词/别名 + 3 字片段去补，正常关键词命中不动，避免污染精度。
    if (not passed) or len(toks) <= 1:
        from . import synonyms as SYN
        extra = SYN.expand(q)
        frags2 = SYN.ngrams(q, 3, 6)
        debug["expanded"] = {"terms": extra, "ngrams": frags2}
        for term in extra:
            lt = term.lower()
            for r in rows:
                seg = (r["seg"] or "").lower()
                content = (r["content"] or "").lower()
                if lt in seg or lt in content:
                    c = passed.setdefault(r["id"], {"id": r["id"], "bm25": 0.0, "hits": [], "via": "synonym"})
                    if term not in c["hits"]:
                        c["hits"] = list(c["hits"]) + [term]
                        c["bm25"] += 2.0
        for frag in frags2:
            try:
                fr = b.db.q("SELECT id FROM memories_fts WHERE memories_fts MATCH ? LIMIT 30",
                            ('"' + frag.replace('"', '') + '"',))
            except Exception:
                fr = []
            for x in fr:
                if x["id"] not in by_id:
                    continue
                c = passed.setdefault(x["id"], {"id": x["id"], "bm25": 0.0, "hits": [], "via": "ngram"})
                if frag not in c["hits"]:
                    c["hits"] = list(c["hits"]) + [frag]
                    c["bm25"] += 1.6
        # 3 字片段很容易撞到「多少/什么/怎么样」这类虚词，只有同一行命中 >=2 个片段、
        # 或命中了 4 字以上的片段，才算数
        for k in list(passed):
            v = passed[k]
            if v.get("via") != "ngram":
                continue
            hits = v.get("hits") or []
            if len(q) <= 10 or len(hits) >= 2 or any(len(str(h)) >= 4 for h in hits):
                continue
            passed.pop(k, None)
        for k in list(passed):
            if passed[k]["bm25"] > 0:
                passed[k]["bm25"] = round(passed[k]["bm25"] + min_bm25, 2)
        # 还是空、但问的是「最近/昨天/上次」这类时间问题：按时间倒序兜底，
        # 相当于人想不起来时先翻最近的账本
        if not passed and re.search(r"(最近|昨天|今天|刚才|刚刚|上次|这几天|这阵子|刷到|看到|看了)", q):
            # 时间兜底只翻「本聊天」自己的账本，不把别的群 / 别人的最近记忆塞进来
            own = [r for r in rows if chat is not None and (r["origin_chat"] or "") == chat]
            for r in own[: max(1, min(limit, 4))]:
                passed[r["id"]] = {"id": r["id"], "bm25": round(min_bm25 + 0.5, 2), "hits": ["最近"], "via": "recent"}
    # 实体扩散：句子里提到的实体 → 提到同一实体的记忆（衰减 0.42）
    decay = float(rc.get("spread_decay", 0.42))
    ents = [e.lower() for e in T.entities(q)]
    if ents:
        ph = ",".join("?" * len(ents))
        for e in b.db.q(f"SELECT memory_id, entity FROM entity_mentions WHERE entity IN ({ph})", ents):
            mid = e["memory_id"]
            if mid in by_id and mid not in passed:
                base = scored.get(mid, {"bm25": 0, "hits": []})
                passed[mid] = {"id": mid, "bm25": round(max(base["bm25"], min_bm25) * decay + 2.0, 2), "hits": list(set(base["hits"] + [e["entity"]])), "via": "entity"}
    # 连线扩散一跳
    if passed:
        top = sorted(passed.values(), key=lambda v: -v["bm25"])[:4]
        for e in neighbors(b, [v["id"] for v in top], 20):
            if e["nb"] in by_id and e["nb"] not in passed and e["w"] >= 0.35:
                src = passed[e["src"]]
                passed[e["nb"]] = {"id": e["nb"], "bm25": round(src["bm25"] * decay * e["w"], 2), "hits": [], "via": "link", "from": e["src"]}
    # 向量（可选）
    from . import vectors
    for mid, sim in vectors.search(b, q, [r["id"] for r in rows], top=6):
        if mid not in passed and sim >= 0.6:
            passed[mid] = {"id": mid, "bm25": round(min_bm25 * sim, 2), "hits": [], "via": "vector"}
    debug["above_threshold"] = len(passed)
    prev_toks = set(T.tokens(prev)) if prev else set()
    gain = hormone_gain(b, persona or b.primary)
    out = []
    for c in passed.values():
        r = by_id[c["id"]]
        if c["id"] in exclude:
            continue
        # 48h「面世冷却」只该管「她自己突然想起来」，不该管主人点名问的东西：
        # 稀有词精确命中 / 时间兜底 一律绕过冷却，否则问第二遍就装失忆。
        rare_hit = any(0 < df.get(str(h), 99) <= rare_max for h in (c["hits"] or [])) if df else False
        cd = 0 if (rare_hit or c["via"] in ("recent", "entity", "link")) else (F.SURFACE_COOLDOWN_MS if cooldown_ms is None else cooldown_ms)
        w = F.surface_weight(r, now, recent_overlap=any(h in prev_toks for h in c["hits"]), rand=rand,
                             cooldown_ms=cd)
        if w <= 0:
            debug["zero_weight"].append(c["id"]); continue
        sal = float(r["salience"] or 0.5)
        emo = F.emotion_of(r)
        score = c["bm25"] * w * (0.75 + 0.5 * sal) * (1 + gain * emo)   # 激素增益只在这里乘一次
        # Generative Agents 式三因子：相关度（上面的 bm25）× 重要度 × 新近度。乘子温和（默认各 ±20% 以内），可在 config.recall 里调 / 设 0 关
        wi, wr = float(rc.get("importance_weight", 0.2)), float(rc.get("recency_weight", 0.2))
        if wi:
            score *= 1 + wi * ((float(r["importance"] or 3) - 3) / 2)
        if wr:
            score *= 1 + wr * ((F.recency_factor(r, now) - 0.35) / 0.65 - 0.5)
        out.append({**c, "w": round(w, 3), "score": round(score, 3), "importance": r["importance"], "recency": F.recency_factor(r, now), "row": r})
        debug["via"][c["via"]] = debug["via"].get(c["via"], 0) + 1
    out.sort(key=lambda x: (-x["score"], -x["importance"], -x["recency"]))
    return {"items": out[:limit], "debug": debug, "toks": toks, "by_id": by_id}


def associate(b, picked: list[str], pool: dict, exclude: set, now=None, max_n=ASSOC_MAX):
    now = now or now_ms()
    seen = set(picked) | set(exclude)
    out = []
    for e in neighbors(b, picked):
        if e["nb"] in seen:
            continue
        r = pool.get(e["nb"])
        if not r or F.state_of(r, now) == "trace":
            continue
        sc = e["w"] * F.strength_now(r, now)
        if sc < ASSOC_MIN_SCORE:
            continue
        seen.add(e["nb"])
        out.append({"row": r, "from": e["src"], "score": sc})
    return sorted(out, key=lambda x: -x["score"])[:max_n]


def search(b, q: str, *, chat=None, persona=None, limit=20, adult: bool | None = None) -> dict:
    """工作台/MCP 搜索：BM25（宽松）+ FTS trigram + 子串。"""
    rows_res = candidates(b, chat=chat, persona=persona, query=q, strict=False, limit=limit * 2, cooldown_ms=0, rand=lambda: 0, adult=adult)
    from . import sensitivity as SENS
    from .context import adult_chat_ok
    _adult_ok = chat is None or (adult_chat_ok(b, chat) and adult is not False)
    items = {c["id"]: {"id": c["id"], "score": c["bm25"], "hits": c["hits"], "via": c["via"], "row": c["row"]} for c in rows_res["items"]}
    qq = q.strip()
    if len(qq) >= 3:
        vis, vp = b.privacy.visible_sql(chat, "m")
        pf, pp = ("AND m.owner_persona IN (?, 'family')", [persona]) if persona else ("", [])
        try:
            fts = b.db.q(f"SELECT m.* FROM memories_fts f JOIN memories m ON m.id=f.id WHERE memories_fts MATCH ? AND m.status='active' {pf} AND {vis} LIMIT ?",
                         ['"' + qq.replace('"', ' ') + '"'] + pp + vp + [limit])
        except Exception:
            fts = []
        for r in fts:
            items.setdefault(r["id"], {"id": r["id"], "score": 3.0, "hits": [qq], "via": "fts", "row": r})
    if qq and len(items) < limit:
        vis, vp = b.privacy.visible_sql(chat, "m")
        pf, pp = ("AND m.owner_persona IN (?, 'family')", [persona]) if persona else ("", [])
        for r in b.db.q(f"SELECT m.* FROM memories m WHERE m.status='active' {pf} AND {vis} AND (m.content LIKE ? OR m.tags LIKE ?) LIMIT ?",
                        pp + vp + [f"%{qq}%", f"%{qq}%", limit]):
            items.setdefault(r["id"], {"id": r["id"], "score": 1.0, "hits": [qq], "via": "like", "row": r})
    if not _adult_ok:
        items = {k: v for k, v in items.items() if not SENS.is_adult_row(v["row"])}
    res = sorted(items.values(), key=lambda x: -x["score"])[:limit]
    return {"keywords": rows_res["toks"], "results": [{**view(b, x["row"]), "score": x["score"], "hits": x["hits"], "via": x["via"]} for x in res]}


def touch_used(b, chat: str, reply: str, ids: list[str]) -> list[str]:
    """只有回复里真的用到（关键词重叠 ≥2，或命中 ≥4 字的词）才强化。"""
    if not reply or not ids:
        return []
    rt = set(T.segment(reply))
    used = []
    for mid in list(dict.fromkeys(ids))[:12]:
        r = get(b, mid)
        if not r:
            continue
        ov = set(T.segment(r["content"])) & rt
        # 分词对不上（换了说法）时，再看汉字二元组重合率
        if len(ov) >= 2 or any(len(t) >= 4 for t in ov) or bigram_overlap(r["content"], reply) >= 0.35:
            reinforce(b, mid, chat=chat, kind="used")
            used.append(mid)
    if len(used) >= 2:
        co_recall(b, used)
    return used


# ———————————————————— 来源分层 / 升格 / 情绪 / 近重复 ————————————————————
SRC_TIERS = {"owner", "other", "isolated", "system"}
FACT_TIERS = {"owner", "system"}
FACT_KINDS = {"about_user", "profile", "relationship", "preference"}
_CQ = re.compile(r"\[CQ:[^\]]*\]")
_AT = re.compile(r"@\S{1,24}\s?")
_URL = re.compile(r"https?://\S+")


def clean_other(text: str) -> str:
    """别人说的话先清洗：去 CQ 码 / @ / 链接 / 多余空白。"""
    t = _URL.sub("", _AT.sub("", _CQ.sub("", text or "")))
    return re.sub(r"\s+", " ", t).strip()


_EMO_STRONG = re.compile(r"爱你|喜欢你|想你|讨厌|恨|生气|气死|难过|伤心|哭|崩溃|害怕|委屈|吵架|分手|离婚|去世|生病|住院|感动|激动|开心死|好开心|太好了|对不起|谢谢你|生日|纪念日|第一次|永远|发誓|答应|约定|承诺|想死")
_EMO_MILD = re.compile(r"开心|高兴|喜欢|烦|累|郁闷|无聊|担心|紧张|害羞|期待|惊喜|好想|孤单|寂寞")


def emotion_rule(content: str, kind: str = "") -> float:
    t = content or ""
    e = 0.3
    e += 0.2 * min(2, len(_EMO_STRONG.findall(t)))
    e += 0.08 * min(2, len(_EMO_MILD.findall(t)))
    if len(re.findall(r"[!！]", t)) >= 2:
        e += 0.08
    if re.search(r"(哈){3,}|呜{2,}|[😭😢😡❤💔]", t):
        e += 0.05
    if kind in ("relationship",):
        e += 0.1
    if len(t) < 6 and e <= 0.3:
        e = 0.2
    return round(max(0.1, min(0.9, e)), 2)


def _bigrams(t: str) -> set:
    h = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", t or "")
    return {h[i:i + 2] for i in range(len(h) - 1)}


def bigram_overlap(mem: str, reply: str) -> float:
    a = _bigrams(mem)
    if len(a) < 4:
        return 0.0
    return len(a & _bigrams(reply)) / len(a)


def jaccard(a: str, b_: str) -> float:
    x, y = _bigrams(a), _bigrams(b_)
    if not x or not y:
        return 0.0
    return len(x & y) / len(x | y)


def near_duplicate(b, persona, chat, content, thr=None):
    """同人格、同来源、最近 300 条里，二元组 Jaccard ≥ 0.9 → 当作同一条。"""
    thr = float(b.cfg.get("near_dup_jaccard", 0.9) if thr is None else thr)
    if len(_bigrams(content)) < 6:
        return None
    for r in b.db.q("SELECT * FROM memories WHERE owner_persona=? AND status='active' AND origin_chat=? ORDER BY created_at DESC LIMIT 300", (persona, chat)):
        if jaccard(r["content"], content) >= thr:
            return r
    return None


def _cred(r):
    try:
        return r["credibility"] or ""
    except (KeyError, IndexError):
        return ""


def maybe_promote(b, mid: str) -> bool:
    """别人说的待证实事实：≥2 个不同的人说过（相近说法），或同一说法出现 ≥3 次 → 升格为长期事实。"""
    r = get(b, mid)
    if not r or _cred(r) != "pending" or r["status"] != "active":
        return False
    peers = []
    for x in b.db.q("SELECT * FROM memories WHERE owner_persona=? AND status='active' AND credibility='pending' AND kind IN ('about_user','profile','relationship','preference') AND id<>? ORDER BY created_at DESC LIMIT 400",
                    (r["owner_persona"], mid)):
        if (r["fact_key"] and x["fact_key"] == r["fact_key"]) or jaccard(x["content"], r["content"]) >= 0.5:
            peers.append(x)
    speakers = {(x["speaker"] or x["origin_chat"]) for x in peers + [r]}
    mentions = 1 + int(r["recall_count"] or 0) + sum(1 + int(x["recall_count"] or 0) for x in peers)
    if len(speakers) < 2 and mentions < 3:
        return False
    tags = [t for t in jload(r["tags"], []) if t != "待证实"] + ["多方印证"]
    pinned = 1 if r["kind"] in F.PERMANENT_KINDS else 0
    now = iso()
    b.db.x("UPDATE memories SET credibility='corroborated', tier='long', tags=?, pinned=?, state=CASE WHEN ?=1 THEN 'pinned' ELSE state END, updated_at=? WHERE id=?",
           (jdump(tags), pinned, pinned, now, mid))
    for x in peers:
        b.db.x("UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?", (mid, now, x["id"]))
    b.audit(mid, "promote", {"speakers": len(speakers), "mentions": mentions})
    return True
