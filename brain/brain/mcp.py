"""MCP（Model Context Protocol）streamable HTTP：POST /mcp，JSON-RPC 2.0。
工具名沿用 companion-memory（recall / remember / session_start / thread_close / add_unresolved / reply_note / save_heart_trace …），
另加情绪 / 身体 / 欲望 / 梦（18+ 模块，按配置开关），以及 leave_note_for_user（别名 leave_note_for_him / 旧名 leave_note_for_her）。"""
from __future__ import annotations
import json
from . import memory as M, continuity as C, emotion as EMO, desire as DES, dream as DRM, cognition as COG
from .privacy import norm_chat

PROTO = "2025-03-26"


def _t(name, desc, props, req=()):
    return {"name": name, "description": desc, "inputSchema": {"type": "object", "properties": props, "required": list(req)}}


S, I, A, O, B = {"type": "string"}, {"type": "integer"}, {"type": "array", "items": {"type": "string"}}, {"type": "object"}, {"type": "boolean"}

TOOLS = [
    _t("session_start", "新窗口开始时调用：拿到交接、未了的事、便条、心痕、分量重的记忆。", {"chat": S}),
    _t("recall", "搜索记忆（jieba+BM25+FTS+实体扩散）。聊到过去的事先搜，别凭空编。", {"query": S, "limit": I, "chat": S}, ["query"]),
    _t("remember", "写一条记忆。kind: self/about_user/relationship/event/preference/diary/profile。", {"content": S, "kind": S, "importance": I, "tags": A, "chat": S, "scope": S}, ["content"]),
    _t("update_memory", "修改一条记忆（内容/重要度/标签/scope/置顶）。", {"id": S, "content": S, "importance": I, "tags": A, "scope": S, "pinned": B}, ["id"]),
    _t("forget", "真遗忘一条记忆（不可恢复）。", {"id": S}, ["id"]),
    _t("thread_close", "窗口结束/说晚安时留交接便签（只给同一个会话的下一窗看）。", {"summary": S, "mood": S, "next_time": S, "chat": S}, ["summary"]),
    _t("add_unresolved", "记下一件没做完/挂心的事。", {"content": S, "chat": S}, ["content"]),
    _t("close_unresolved", "把一件未了的事标记为已了结。", {"id": S, "resolution": S}, ["id"]),
    _t("reply_note", "回复他（主人）留的便条。action: fixed/kept/forgot/other", {"id": S, "reply": S, "action": S}, ["id", "reply"]),
    _t("leave_note_for_user", "给他（主人）留一句话：放进发件箱，由机器人转发到主人私聊。旧名 leave_note_for_her 仍可调用。", {"text": S, "chat": S}, ["text"]),
    _t("leave_note_for_him", "同 leave_note_for_user（给他留一句话）。", {"text": S, "chat": S}, ["text"]),
    _t("save_heart_trace", "心里翻涌时记一道心痕。", {"title": S, "content": S}, ["content"]),
    _t("write_cognition", "把一组相关记忆沉成一条自我认知（候选 id 来自注入里的邀请）。", {"candidate_id": S, "text": S}, ["candidate_id", "text"]),
    _t("emotion_get", "看自己现在的情绪（表面/心里）。", {}),
    _t("emotion_apply", "改情绪：changes={维度:{surface:±n, inner:±n}}，写清 reason。confidence=你对「对方真是这个意思」有多确定(0~1)，可能是反话/玩笑就给低分，<0.6 不改情绪。", {"changes": O, "reason": S, "coax": B, "admit": A, "confidence": {"type": "number"}}, ["changes", "reason"]),
    _t("body_status", "【18+】看身体状态和痕迹。", {}),
    _t("body_event", "【18+】身体事件：events=[{type,part,level}] 或 message 走分类。", {"events": {"type": "array", "items": O}, "message": S}),
    _t("desire_save", "【18+】记一条欲望（level/trigger/mood/status）。", {"level": S, "trigger": S, "mood": S, "status": S}),
    _t("desire_list", "【18+】看最近的欲望记录。", {"limit": I}),
    _t("dream_list", "看最近的梦。", {"limit": I}),
]
ADULT = {"body_status": "body", "body_event": "body", "desire_save": "desire", "desire_list": "desire", "dream_list": "dream"}


def _ok(rid, result):
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _err(rid, code, msg):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}}


def _text(o):
    if isinstance(o, str):
        return {"content": [{"type": "text", "text": o}]}
    return {"content": [{"type": "text", "text": json.dumps(o, ensure_ascii=False, default=str)}]}


def call(b, name, a, persona=None, chat=None):
    p = a.get("persona") or persona or b.primary
    ch = norm_chat(a["chat"]) if a.get("chat") else chat
    if name in ADULT and not b.module_on(ADULT[name], p):
        return {"ok": False, "error": "disabled", "message": f"{ADULT[name]} 模块对 {p} 没开"}
    if name == "session_start":
        return C.session_start(b, p, ch)["text"]
    if name == "recall":
        r = M.search(b, str(a.get("query") or ""), chat=ch, persona=p, limit=int(a.get("limit") or 8))
        b.pulse([x["id"] for x in r["results"]], "recall", ch or "mcp")
        return "\n".join(f"[{x['id']}] ({x['state']}) {x['content']}" for x in r["results"]) or "没有找到相关记忆。"
    if name == "remember":
        return M.remember(b, content=str(a.get("content") or ""), persona=p, kind=a.get("kind") or "event", importance=a.get("importance", 3),
                          tags=a.get("tags") or [], chat=ch or "mcp", scope=a.get("scope") or "inherit", source="mcp")
    if name == "update_memory":
        r = M.update(b, a["id"], {k: v for k, v in a.items() if k != "id"})
        return {"ok": bool(r), "id": a["id"]}
    if name == "forget":
        return {"ok": M.forget(b, a["id"])}
    if name == "thread_close":
        return C.handoff_close(b, p, ch or "", a.get("summary"), a.get("mood"), a.get("next_time"), "mcp")
    if name == "add_unresolved":
        return C.unresolved_add(b, p, str(a.get("content") or ""), ch or "")
    if name == "close_unresolved":
        return C.unresolved_close(b, a["id"], a.get("resolution") or "")
    if name == "reply_note":
        return C.note_reply(b, a["id"], a.get("reply") or "", a.get("action") or "other")
    if name in ("leave_note_for_user", "leave_note_for_him", "leave_note_for_her"):   # _her 为旧名别名
        from . import outbox as OB
        txt = str(a.get("text") or a.get("content") or "").strip()
        if not txt:
            return {"ok": False, "error": "empty", "message": "text 不能为空"}
        target = ch or b.cfg.get("owner_chat") or ""
        return {"ok": True, "id": OB.put(b, p, target, "note", txt), "chat": target}
    if name == "save_heart_trace":
        return C.heart_save(b, p, a.get("title") or str(a.get("content") or "")[:12], str(a.get("content") or ""), p)
    if name == "write_cognition":
        return COG.write(b, a["candidate_id"], a.get("text") or "", p)
    if name == "emotion_get":
        _st = EMO.state(b, p)
        return _st.get("prompt_line") or _st
    if name == "emotion_apply":
        return EMO.apply(b, p, a, source="mcp").get("text")
    if name == "body_status":
        from . import body
        return body.status(b, p)["text"]
    if name == "body_event":
        from . import body
        t = body.turn(b, p, message=str(a.get("message") or ""), events=a.get("events"))
        return t.get("injection") or body.status(b, p)["text"]
    if name == "desire_save":
        return DES.save(b, p, a)
    if name == "desire_list":
        return DES.list_text(b, p, int(a.get("limit") or 10))
    if name == "dream_list":
        return DRM.listing(b, p, int(a.get("limit") or 3))["text"]
    raise KeyError(name)


def handle(b, msg, persona=None, chat=None):
    if isinstance(msg, list):
        out = [r for r in (handle(b, m, persona, chat) for m in msg) if r is not None]
        return out or None
    if not isinstance(msg, dict):
        return _err(None, -32600, "invalid request")
    rid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if rid is None and method and method.startswith("notifications/"):
        return None
    if method == "initialize":
        return _ok(rid, {"protocolVersion": params.get("protocolVersion") or PROTO, "capabilities": {"tools": {"listChanged": False}},
                         "serverInfo": {"name": "dafeiyu-memory-brain", "version": "2.0.0"}})
    if method == "ping":
        return _ok(rid, {})
    if method == "tools/list":
        p = persona or b.primary
        return _ok(rid, {"tools": [t for t in TOOLS if t["name"] not in ADULT or b.module_on(ADULT[t["name"]], p)]})
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        try:
            return _ok(rid, _text(call(b, name, args, persona, chat)))
        except KeyError as e:
            if str(e).strip("'") == name:
                return _err(rid, -32601, f"unknown tool {name}")
            return _ok(rid, {**_text(f"缺少参数：{e}"), "isError": True})
        except Exception as e:
            b.log.exception("mcp tool %s", name)
            return _ok(rid, {**_text(f"出错：{e}"), "isError": True})
    return _err(rid, -32601, f"method not found: {method}")
