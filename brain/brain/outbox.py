"""发件箱：大脑自己“想说的话”（身体唤醒、梦醒后的一句、沉淀后的留言）放这里，
由 Aurabot/memcore 轮询 GET /outbox 去真正发出。大脑本身从不直接发消息。

kind：
- body_wake / body_suffer：已经生成好的要发给他（主人）的话（text）
- body_wake_prompt：没配 LLM 时的唤醒 prompt；Aurabot 用自己的模型跑完 → POST /outbox/{id}/result {"text": "..."}
  → 大脑解析 BODY_DECISION 落地，并把要说的话变成一条新的 body_wake 放回 outbox
- note：普通留言
"""
from __future__ import annotations
from .util import iso, new_id, jdump, jload

KINDS = {"body_wake", "body_suffer", "body_wake_prompt", "note", "dream", "settle"}


def put(b, persona, chat, kind, text="", prompt="", ref=None) -> str:
    oid = new_id("ob_")
    b.db.x("INSERT INTO outbox(id, persona_id, chat_id, kind, text, prompt, ref, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
           (oid, persona or b.primary, chat or "", kind, text or "", prompt or "", ref, "pending", iso()))
    b.log.info("outbox +%s kind=%s chat=%s", oid, kind, chat or "-")
    return oid


def _view(r) -> dict:
    d = dict(r)
    d["result"] = jload(d.get("result"), d.get("result"))
    return d


def pending(b, chat=None, persona=None, limit=20, kinds=None) -> list[dict]:
    conds, ps = ["status='pending'"], []
    if chat:
        conds.append("chat_id=?"); ps.append(chat)
    if persona:
        conds.append("persona_id=?"); ps.append(persona)
    if kinds:
        conds.append(f"kind IN ({','.join('?' * len(kinds))})"); ps += list(kinds)
    return [_view(r) for r in b.db.q(f"SELECT * FROM outbox WHERE {' AND '.join(conds)} ORDER BY created_at LIMIT ?", ps + [limit])]


def listing(b, status=None, limit=50) -> list[dict]:
    if status and status != "all":
        rows = b.db.q("SELECT * FROM outbox WHERE status=? ORDER BY created_at DESC LIMIT ?", (status, limit))
    else:
        rows = b.db.q("SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?", (limit,))
    return [_view(r) for r in rows]


def mark(b, oid, status="sent") -> bool:
    status = status if status in ("sent", "failed", "dropped", "pending", "cancelled") else "sent"
    cur = b.db.x("UPDATE outbox SET status=?, sent_at=? WHERE id=?", (status, iso(), oid))
    return cur.rowcount > 0


def result(b, oid, text: str) -> dict:
    """Aurabot 跑完 prompt 后回传。body_wake_prompt → body.wake_result。"""
    r = b.db.one("SELECT * FROM outbox WHERE id=?", (oid,))
    if not r:
        return {"ok": False, "error": "not_found"}
    out = {"ok": True, "id": oid}
    if r["kind"] == "body_wake_prompt" and r["ref"]:
        from . import body
        res = body.wake_result(b, r["ref"], text or "")
        out["body"] = res
        say = (res or {}).get("say") or ""
        if say:
            out["outbox_id"] = put(b, r["persona_id"], r["chat_id"], "body_wake", text=say, ref=r["ref"])
            out["say"] = say
    b.db.x("UPDATE outbox SET status='done', result=?, sent_at=? WHERE id=?", (jdump({"text": (text or "")[-2000:]}), iso(), oid))
    return out
