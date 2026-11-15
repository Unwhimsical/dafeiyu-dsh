"""认知（移植自 companion-memory cognition.ts，向量聚类改为“连线图 + 词重叠”，有向量时也会用上）。
几段说的是同一件事的记忆 → 聚成候选 → 浮现时偶尔邀请伙伴写一句“自己的理解”（write_cognition）
→ 写成一条 about_user 认知记忆（importance 4），和源记忆连 0.9 的边，源记忆强度 ×0.85（温和淡化，不消失）。
隐私：认知的可见范围取源记忆里最严格的那个。"""
from __future__ import annotations
from . import forgetting as F
from . import memory as M
from . import textutil as T
from .util import iso, now_ms, new_id, jdump, jload, clip, local_dt

SIM, MIN, MAX = 0.35, 3, 8
OFFER_GAP_H, REOFFER_DAYS, MAX_OFFERS, FADE, TAG = 4, 3, 3, 0.85, "认知"


def _sim_graph(b, rows):
    ids = {r["id"] for r in rows}
    sim: dict[tuple, float] = {}
    for e in b.db.q("SELECT a_id, b_id, weight FROM memory_links"):
        if e["a_id"] in ids and e["b_id"] in ids:
            sim[(e["a_id"], e["b_id"])] = max(sim.get((e["a_id"], e["b_id"]), 0), e["weight"])
    toks = {r["id"]: set(T.tokens(r["content"])) for r in rows}
    lst = [r["id"] for r in rows]
    for i, a in enumerate(lst):
        for c in lst[i + 1:]:
            ta, tc = toks[a], toks[c]
            if ta and tc:
                j = len(ta & tc) / len(ta | tc)
                if j >= 0.2:
                    k = (a, c) if a < c else (c, a)
                    sim[k] = max(sim.get(k, 0), round(j + 0.15, 3))
    return sim


def cluster(b, persona=None, dry=False, max_new=10) -> dict:
    persona = persona or b.primary
    covered = set()
    for r in b.db.q("SELECT source_ids FROM cognition_candidates WHERE persona_id=? AND status IN ('pending','offered','done')", (persona,)):
        covered |= set(jload(r["source_ids"], []) or [])
    rows = [r for r in b.db.q("SELECT * FROM memories WHERE owner_persona=? AND status='active' AND kind<>'cognition' ORDER BY updated_at DESC LIMIT 400", (persona,))
            if r["id"] not in covered and TAG not in (r["tags"] or "")]
    sim = _sim_graph(b, rows)
    s = lambda a, c: sim.get((a, c) if a < c else (c, a), 0.0)
    nb = {r["id"]: [] for r in rows}
    for (a, c), w in sim.items():
        if w >= SIM:
            nb[a].append((c, w)); nb[c].append((a, w))
    used, clusters = set(), []
    for seed in sorted(nb, key=lambda k: -len(nb[k])):
        if seed in used or len(nb[seed]) < MIN - 1:
            continue
        mem = [seed]
        for j, _ in sorted(nb[seed], key=lambda x: -x[1]):
            if len(mem) >= MAX:
                break
            if j in used or j in mem:
                continue
            if sum(s(m, j) for m in mem) / len(mem) >= SIM:
                mem.append(j)
        if len(mem) < MIN:
            continue
        pairs = [(x, y) for i, x in enumerate(mem) for y in mem[i + 1:]]
        score = round(sum(s(x, y) for x, y in pairs) / len(pairs), 3)
        used |= set(mem)
        clusters.append({"items": mem, "score": score})
    clusters.sort(key=lambda c: -c["score"])
    keep = clusters[:max_new]
    by = {r["id"]: r for r in rows}
    ids = []
    if not dry:
        for c in keep:
            cid = new_id("cc_")
            theme = " / ".join(clip(by[m]["content"], 16) for m in c["items"][:3])
            b.db.x("INSERT INTO cognition_candidates(id, persona_id, source_ids, theme, status, created_at, score, offers) VALUES (?,?,?,?, 'pending', ?, ?, 0)",
                   (cid, persona, jdump(c["items"]), theme, iso(), c["score"]))
            ids.append(cid)
    return {"persona": persona, "threshold": SIM, "nodes": len(rows), "already_covered": len(covered), "clusters": len(keep), "created": len(ids), "ids": ids,
            "examples": [{"score": c["score"], "items": [{"id": m, "title": clip(by[m]["content"], 30)} for m in c["items"]]} for c in keep[:5]]}


def cron(b, now=None):
    now = now or now_ms()
    day = local_dt(now, b.cfg.get("tz_offset_minutes", 480)).strftime("%Y-%m-%d")
    r = b.db.one("SELECT v FROM meta WHERE k='cognition_cluster_day'")
    if r and r["v"] == day:
        return {"skipped": "today"}
    b.db.x("INSERT OR REPLACE INTO meta(k, v) VALUES('cognition_cluster_day', ?)", (day,))
    return {p: cluster(b, p, max_new=10)["created"] for p in (b.cfg.get("cognition_personas") or [b.primary])}


def maybe_note(b, persona, chat=None, now=None, dry=False) -> dict:
    """浮现时偶尔附一句邀请。只挑这个会话看得见全部源记忆的候选（隐私）。"""
    if not b.cfg.get("cognition_prompt", True) or persona not in (b.cfg.get("cognition_personas") or [b.primary]):
        return {"note": ""}
    now = now or now_ms()
    if b.db.one("SELECT 1 FROM cognition_candidates WHERE persona_id=? AND offered_at>? LIMIT 1", (persona, iso(now - OFFER_GAP_H * 3600_000))):
        return {"note": ""}
    re_ = iso(now - REOFFER_DAYS * 86400_000)
    for c in b.db.q("""SELECT * FROM cognition_candidates WHERE persona_id=? AND ((status='pending') OR (status='offered' AND offered_at<? AND offers<?))
                       ORDER BY (status='pending') DESC, score DESC LIMIT 5""", (persona, re_, MAX_OFFERS)):
        src = jload(c["source_ids"], []) or []
        rows = [M.get(b, m) for m in src]
        rows = [r for r in rows if r]
        if len(rows) < MIN or not all(b.privacy.is_visible(r, chat) for r in rows):
            continue
        if not dry:
            b.db.x("UPDATE cognition_candidates SET status='offered', offers=COALESCE(offers,0)+1, offered_at=? WHERE id=?", (iso(now), c["id"]))
        lines = "\n".join(f"· {clip(r['content'], 30)}" for r in rows[:MAX])
        user = b.cfg.get("user_name", "他")
        return {"id": c["id"], "note": f"[心里冒出的念头] 这几件关于{user}的事，好像说的是同一件事：\n{lines}\n要是你对{user}在这上面有了自己的一句理解，想留下来，可以用 write_cognition（candidate_id: {c['id']}）写一句话。没感觉就随它去，不用回应这一段。"}
    return {"note": ""}


def strictest(b, rows) -> dict:
    """合并多条记忆时取最严格的可见范围。"""
    eff = [b.privacy.effective(r) for r in rows]
    origins = {r["origin_chat"] for r in rows}
    if all(e == "public" for e in eff):
        return {"scope": "inherit", "chat": rows[0]["origin_chat"] if len(origins) == 1 else "system:merge", "allow": []}
    if len(origins) == 1:
        o = rows[0]
        return {"scope": "private" if "private" in eff else o["scope"], "chat": o["origin_chat"], "allow": jload(o["allow"], []) or []}
    return {"scope": "private", "chat": "system:merge", "allow": []}


def write(b, candidate_id, text, persona=None) -> dict:
    text = (text or "").strip()
    if not 2 <= len(text) <= 300:
        return {"ok": False, "error": "invalid", "message": "写一句话就好（2–300 字）。"}
    c = b.db.one("SELECT * FROM cognition_candidates WHERE id=?", (candidate_id,))
    if not c:
        return {"ok": False, "error": "not_found", "message": "没有这组念头。"}
    if c["status"] == "done":
        return {"ok": False, "error": "done", "message": "这组已经写过认知了。"}
    src = [r for r in (M.get(b, m) for m in jload(c["source_ids"], []) or []) if r]
    sc = strictest(b, src) if src else {"scope": "private", "chat": "system:cognition", "allow": []}
    r = M.remember(b, content=text, persona=c["persona_id"], kind="cognition", importance=4, tags=[TAG], emotion=0.5,
                   chat=sc["chat"], scope=sc["scope"], allow=sc["allow"], source="persona", link=False, tier="long")
    if not r.get("ok"):
        return r
    mid, now, faded = r["id"], iso(), {}
    for m in src:
        M.upsert_link(b, mid, m["id"], 0.9, "cognition")
        if F.is_pinned(m):
            continue
        faded[m["id"]] = [m["strength"], m["last_recalled_at"]]
        b.db.x("UPDATE memories SET strength=?, last_recalled_at=? WHERE id=?", (max(0.0, F.strength_now(m) * FADE), now, m["id"]))
    b.db.x("UPDATE cognition_candidates SET status='done', done_at=?, cognition_id=?, faded=? WHERE id=?", (now, mid, jdump(faded), candidate_id))
    b.pulse([mid] + [m["id"] for m in src], "assoc", "", [1.0] + [0.5] * len(src))
    return {"ok": True, "id": mid, "text": f"记下了这份认知 #{mid}，和 {len(src)} 段记忆连在一起；那几段会稍微淡一点，但不会消失。"}


def undo(b, cognition_id, drop=False) -> dict:
    c = b.db.one("SELECT * FROM cognition_candidates WHERE cognition_id=?", (cognition_id,))
    if not c:
        return {"ok": False, "error": "not_found"}
    for mid, v in (jload(c["faded"], {}) or {}).items():
        parts = v if isinstance(v, list) else [v, None]
        st, last = (list(parts) + [None, None])[:2]
        b.db.x("UPDATE memories SET strength=?, last_recalled_at=COALESCE(?, last_recalled_at) WHERE id=?", (st, last, mid))
    M.forget(b, cognition_id)
    if drop:
        b.db.x("DELETE FROM cognition_candidates WHERE id=?", (c["id"],))
    else:
        b.db.x("UPDATE cognition_candidates SET status='pending', cognition_id=NULL, done_at=NULL WHERE id=?", (c["id"],))
    return {"ok": True, "restored": len(jload(c["faded"], {}) or {})}


def listing(b, persona=None, status=None):
    conds, ps = [], []
    if persona:
        conds.append("persona_id=?"); ps.append(persona)
    if status and status != "all":
        conds.append("status=?"); ps.append(status)
    w = ("WHERE " + " AND ".join(conds)) if conds else ""
    return [{**dict(r), "source_ids": jload(r["source_ids"], [])} for r in b.db.q(f"SELECT * FROM cognition_candidates {w} ORDER BY created_at DESC LIMIT 100", ps)]
