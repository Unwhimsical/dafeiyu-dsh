"""HTTP 层：REST（工作台/星图/花园）+ 旧大脑兼容接口（memcore/bio）+ MCP + 静态 web/。"""
from __future__ import annotations
import asyncio
import io
import os
import re
import shutil
import time
import json, os, random, time
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .core import Brain
from .config import ROOT
from .privacy import norm_chat, chat_from_payload
from .util import iso, now_ms, parse_iso, clip, jload, first
from . import fish as FISH
from . import proxywatch as PW
from . import identity_sync as IDS
from . import memory as M, context as CTX, continuity as C, views as V, maintenance as MT, scheduler as SCH
from . import emotion as EMO, desire as DES, dream as DRM, outbox as OB, cognition as COG, spill as SP, thinking as TH
from . import sensitivity as SENS

LOCAL = {"127.0.0.1", "::1", "localhost", "testclient"}
STYLE_HIDDEN_DIMS = {"情欲"}  # /style 不外露 18+ 维度
COMPAT = ("/activate", "/prefetch", "/remember", "/bio/", "/after_reply", "/guard", "/consolidate", "/reflect", "/pulses", "/outbox", "/mcp", "/recall", "/style", "/wechat_map")


class ApiError(Exception):
    def __init__(self, status, error, message=""):
        self.status, self.error, self.message = status, error, message or error


def err(status, error, message=""):
    raise ApiError(status, error, message)


def create_app(brain: Brain | None = None, start_scheduler: bool = True) -> FastAPI:
    b = brain or Brain()
    app = FastAPI(title="大肥鱼记忆大脑 v2", version="2.0.0")
    @app.middleware("http")
    async def _no_store_static(request: Request, call_next):
        """前端页面和脚本一律不缓存。"""
        resp = await call_next(request)
        path = request.url.path
        if path.endswith(".html") or path.endswith(".js") or path == "/" or path.endswith("/"):
            resp.headers["Cache-Control"] = "no-store, must-revalidate"
            resp.headers["Pragma"] = "no-cache"
        return resp

    # 18+：所有展示接口默认剔除 18+ 条目（记忆列表/星图/think/统计/日志/导出…）
    ADULT_TABLES = ("body_state", "body_series", "body_traces", "body_events", "body_wake_queue", "body_private_records", "body_log_seen",
                    "desire_logs", "desire_replies", "bio_events", "dreams", "emotion_events", "emotion_series")
    NO_SCRUB = ("/api/settings", "/api/personas", "/api/privacy", "/api/identity", "/api/auth", "/api/fish/config", "/api/modules", "/api/backups")

    @app.middleware("http")
    async def _hide_adult(request: Request, call_next):
        resp = await call_next(request)
        path = request.url.path
        if not (path.startswith("/api/") or path == "/pulses") or path.startswith(NO_SCRUB):
            return resp
        if SENS.reveal_allowed(b.cfg, request.query_params.get("include_adult")):
            return resp
        if "application/json" not in (resp.headers.get("content-type") or ""):
            return resp
        raw = b"".join([c async for c in resp.body_iterator])
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            return Response(content=raw, status_code=resp.status_code, media_type="application/json")
        hdr = {k: v for k, v in resp.headers.items() if k.lower() not in ("content-length", "content-type")}
        return JSONResponse(SENS.scrub(data), status_code=resp.status_code, headers=hdr)

    app.state.brain = b
    pf = CTX.Prefetch(b)
    sched = SCH.Scheduler(b)
    app.state.scheduler = sched

    def _privacy_changed():
        # 身份同步写完 privacy.json 立刻生效（原来要重启）
        try:
            b.privacy.reload(force=True)
        except Exception:
            pass
        with b.cache_lock:
            b.cache.clear()
        try:
            pf.cache.clear()
        except Exception:
            pass

    @app.on_event("startup")
    def _start():
        # 话簿：幂等建默认册子 + 把「我有一本话簿」写进人格卡。
        # self_card 本来就在每轮系统提示里，所以这是零额外预算、她随时都知道的做法。
        try:
            from . import ledger as L
            if L.enabled(b):
                L.ensure(b)
                L.awareness(b)
                b.log.info("话簿已就绪：%s", L.stats(b).get("dir"))
        except Exception as e:
            b.log.warning("话簿初始化失败：%s", e)
        if start_scheduler:
            sched.start()
            # 身份对照（QQ↔抖音 + people 表）原来只有手动按钮，现在每分钟自己同步一次
            if b.cfg.get("identity_sync_enabled", True):
                try:
                    IDS.start_loop(60.0, b.log, target=b.cfg.privacy_file, on_change=_privacy_changed)
                except Exception as e:
                    b.log.warning("身份同步没起来：%s", e)
            try:
                PW.start_loop(lambda m: b.log.info(m))
            except Exception as _e:
                b.log.warning("tts-watch 启动失败：%s", _e)
        b.log.info("记忆大脑 v2 启动：db=%s port=%s", b.cfg.db_file, b.cfg.get("port"))

    @app.on_event("shutdown")
    def _stop():
        if start_scheduler:
            sched.stop()

    # —— 错误统一 ——
    @app.exception_handler(ApiError)
    async def _api_err(request, e: ApiError):
        return JSONResponse({"ok": False, "error": e.error, "message": e.message}, status_code=e.status)

    @app.exception_handler(StarletteHTTPException)
    async def _http_err(request, e):
        return JSONResponse({"ok": False, "error": "http_%s" % e.status_code, "message": str(e.detail)}, status_code=e.status_code)

    @app.exception_handler(Exception)
    async def _any_err(request, e):
        b.log.exception("接口出错 %s %s", request.method, request.url.path)
        return JSONResponse({"ok": False, "error": "internal", "message": f"{type(e).__name__}: {e}"}, status_code=500)

    # —— 鉴权 ——
    def _key_of(req: Request):
        h = req.headers.get("authorization") or ""
        if h.lower().startswith("bearer "):
            return h[7:].strip()
        return req.headers.get("x-admin-key") or req.query_params.get("key") or ""

    def _origin_local(req: Request) -> bool:
        # 免密只给本机程序（插件 / 脚本不带 Origin）。浏览器里别的网站跨站 POST 会带上自己的 Origin：
        # 不认，免得随便一个网页就能往 127.0.0.1:8780 写记忆（CSRF / DNS rebinding）。
        o = req.headers.get("origin")
        if not o or o == "null":
            return not o
        try:
            from urllib.parse import urlparse
            return (urlparse(o).hostname or "") in ("127.0.0.1", "localhost", "::1")
        except Exception:
            return False

    @app.middleware("http")
    async def _auth(request: Request, call_next):
        p = request.url.path
        need = p.startswith("/api/") or p.startswith(COMPAT)
        if need:
            k = _key_of(request)
            admin = b.cfg.get("admin_key") or ""
            ok = bool(admin) and k == admin
            if not ok and p.startswith(COMPAT) and b.cfg.get("local_no_auth", True) and (request.client and request.client.host in LOCAL) \
                    and _origin_local(request):
                ok = True
            atlas_key = b.cfg.get("atlas_key") or ""
            # atlas_key 是给别人看星图用的只读钥匙：只放星图/脉冲/思考这几项，
            # 不放记忆原文、聊天记录、隐私表、设置（文档：只能 GET 星图和脉冲）
            RO_VIEW = ("/api/atlas", "/api/pulses", "/pulses", "/api/think", "/api/auth/check",
                       "/api/stats", "/api/personas", "/api/health")
            if not ok and atlas_key and k == atlas_key and request.method == "GET" and (
                    p in RO_VIEW or any(p.startswith(x) for x in RO_VIEW if x.endswith('/'))):
                ok = True
            if not ok:
                return JSONResponse({"ok": False, "error": "unauthorized", "message": "密钥不对：请在请求头带 Authorization: Bearer <admin_key>"}, status_code=401)
        return await call_next(request)

    async def body(req: Request) -> dict:
        try:
            raw = await req.body()
            if not raw:
                return {}
            d = json.loads(raw.decode("utf-8-sig"))
            return d if isinstance(d, dict) else {"_": d}
        except Exception:
            try:
                f = await req.form()
                return dict(f)
            except Exception:
                return {}

    def qp(req, k, default=None):
        v = req.query_params.get(k)
        return v if v not in (None, "") else default

    def qint(req, k, default):
        try:
            return int(req.query_params.get(k) or default)
        except ValueError:
            return default

    def chat_of(v):
        return norm_chat(v) if v else None

    def persona_of(req, d=None):
        return (d or {}).get("persona") or (d or {}).get("persona_id") or qp(req, "persona") or b.primary

    def mem_or_404(mid):
        r = M.get(b, mid)
        if not r:
            err(404, "not_found", "没有这条记忆")
        return r

    # ======================= 兼容接口（memcore / bio） =======================
    @app.get("/health")
    def health():
        n = b.db.one("SELECT COUNT(*) c FROM memories WHERE status='active'")["c"]
        return {"ok": True, "service": "dafeiyu-memory-brain", "version": "2.0.0", "memories": n, "db": str(b.cfg.db_file),
                "llm": b.llm.configured, "modules": {m: b.cfg.get(f"{m}_enabled", False) for m in ("emotion", "body", "desire", "dream")}, "time": iso()}

    @app.post("/prefetch")
    async def prefetch(req: Request):
        d = await body(req)
        return {"ok": True, "key": pf.prefetch(d)}

    @app.post("/activate")
    async def activate(req: Request):
        d = await body(req)
        r = pf.activate(d)
        blk = r.get("block") or ""
        # 旧接口字段别名：context / memory_block / injection / text
        return {**r, "context": blk, "memory_block": blk, "injection": blk, "text": blk,
                "memories": [{"id": x["id"], "content": x["content"], "score": x.get("score")} for x in r.get("recalled") or []]}

    @app.post("/recall")
    async def recall_compat(req: Request):
        d = await body(req)
        p = CTX.parse_payload(d)
        res = M.search(b, p["message"], chat=p["chat"], persona=p["persona"] or b.primary, limit=int(d.get("limit") or 8), adult=d.get("adult") is True)
        if b.cfg.get("think_feed_enabled", True):
            try:
                b.think.record([x.get("id") for x in res.get("results") or [] if isinstance(x, dict)], source="recall", persona=p["persona"] or b.primary)
            except Exception as e:
                b.log.debug("think feed: %s", e)
        return {"ok": True, **res}

    @app.post("/remember")
    async def remember_compat(req: Request):
        d = await body(req)
        items = d.get("memories") or d.get("items")
        if isinstance(items, list):
            return {"ok": True, "results": [_remember(it if isinstance(it, dict) else {"content": str(it)}, d) for it in items]}
        return _remember(d, {})

    def _remember(d, parent):
        merged = {**parent, **d}
        content = first(merged, "content", "text", "memory", "fact", "message", default="")
        uid = first(merged, "user_id", "userId", "speaker", "qq", default="")
        has_src = any(merged.get(k) not in (None, "", 0) for k in ("chat_id", "chatId", "chat", "session_id", "conversation_id", "group_id", "groupId", "user_id", "userId", "sender_id", "qq", "open_id", "chat_type", "message_type"))
        # 没带任何来源 → 来源不明 = 私密（legacy:unknown，谁都看不到，工作台里手动分配）；要全局可见请显式 scope=public 或 chat_id=system
        chat = chat_from_payload(merged) if has_src else "legacy:unknown"
        imp = merged.get("importance", 3)
        try:
            imp = float(imp)
            if imp <= 1 and isinstance(merged.get("importance"), float):  # 旧口径 0..1 → 1..5
                imp = 1 + imp * 4
        except (TypeError, ValueError):
            imp = 3
        tags = merged.get("tags") or merged.get("keywords") or []
        r = M.remember(b, content=str(content), persona=first(merged, "persona", "persona_id", default=None), kind=first(merged, "kind", "type", "category", default="event"),
                       importance=imp, tags=tags, chat=chat, speaker=str(merged.get("speaker") or uid or ""), scope=merged.get("scope") or "inherit",
                       allow=merged.get("allow") or [], emotion=merged.get("emotion"), pin=merged.get("pin"), event_date=merged.get("event_date"),
                       source=merged.get("source") or "remember", salience=merged.get("salience"))
        return r

    @app.post("/bio/event")
    async def bio_event(req: Request):
        d = await body(req)
        pid = persona_of(req, d)
        r = EMO.bio_event(b, pid, d)
        evs = d.get("body_events") or ((d.get("events")) if isinstance(d.get("events"), list) else None)
        if b.module_on("body", pid) and (evs or d.get("body_message")):
            from . import body as BODY
            try:
                bt = BODY.turn(b, pid, message=str(d.get("body_message") or ""), events=evs)
                r["body"] = {"injection": bt.get("injection"), "values": BODY.vals(bt["after"]) if isinstance(bt.get("after"), dict) and "values" not in bt else bt.get("after")}
            except Exception as e:
                r["body_error"] = str(e)
        return r

    @app.get("/bio/state")
    def bio_state(req: Request):
        return EMO.bio_state(b, persona_of(req))

    @app.post("/after_reply")
    async def after_reply(req: Request):
        return MT.after_reply(b, await body(req))

    @app.get("/wechat_map")
    async def wechat_map():
        """微信模块用：控制台「身份」里填的 微信id → QQ（本机免密，和 /activate 同级；只回对照，不回别的）。"""
        out = {}
        for qq, v in ((b.privacy.data or {}).get("person_map") or {}).items():
            wx = str((v or {}).get("wechat") or "").strip() if isinstance(v, dict) else ""
            if wx and str(qq).isdigit():
                out[wx] = str(qq)
        return {"ok": True, "map": out}

    @app.post("/guard")
    async def guard(req: Request):
        d = await body(req)
        p = CTX.parse_payload(d)
        reply = first(d, "reply", "response", "text", "answer", default="")
        return b.privacy.guard(b.db, p["chat"], str(reply), str(d.get("context") or ""), p["persona"] or b.primary)

    @app.post("/consolidate")
    async def consolidate_compat():
        return SCH.run_job(b, "consolidate")

    @app.post("/reflect")
    async def reflect_compat(req: Request):
        d = await body(req)
        p = CTX.parse_payload(d)
        return MT.reflect(b, p["chat"], p["persona"] or b.primary)

    def _pulses(req):
        since = qint(req, "since", 0)
        lim = max(1, min(500, qint(req, "limit", 50)))
        if since <= 0:
            mx = b.db.one("SELECT MAX(id) m FROM pulses")["m"] or 0
            if req.query_params.get("since") is None:
                rows = b.db.q("SELECT * FROM pulses ORDER BY id DESC LIMIT ?", (lim,))[::-1]
            else:
                rows = []
                return {"ok": True, "last_id": mx, "pulses": []}
        else:
            rows = b.db.q("SELECT * FROM pulses WHERE id>? ORDER BY id LIMIT ?", (since, lim))
        last = rows[-1]["id"] if rows else since
        return {"ok": True, "last_id": last, "pulses": [{"id": r["id"], "memory_id": r["memory_id"], "kind": r["kind"], "score": r["score"], "chat_id": r["chat_id"], "at": r["created_at"]} for r in rows]}

    @app.get("/pulses")
    def pulses(req: Request):
        return _pulses(req)

    @app.get("/api/pulses")
    def api_pulses(req: Request):
        return _pulses(req)

    # —— 思考事件（星图「思考动画」）：只返回记忆 id，按 chat/persona 做和 /api/atlas 一样的可见性过滤 ——
    @app.get("/api/think")
    def think_feed(req: Request):
        return TH.feed(b, qint(req, "since", 0), qint(req, "limit", 20), chat_of(qp(req, "chat")), qp(req, "persona"))

    @app.post("/api/think/demo")
    async def think_demo(req: Request):
        d = await body(req)
        n = max(2, min(8, int(d.get("count") or 4)))
        rows = b.db.q("SELECT id FROM memories WHERE status='active' ORDER BY RANDOM() LIMIT ?", (n,))
        seq = b.think.record([r["id"] for r in rows], source="demo")
        return {"ok": True, "seq": seq, "ids": [r["id"] for r in rows]}

    @app.post("/api/pulses/demo")
    async def pulses_demo(req: Request):
        d = await body(req)
        n = max(1, min(20, int(d.get("count") or 3)))
        rows = b.db.q("SELECT id FROM memories WHERE status='active' ORDER BY RANDOM() LIMIT ?", (n,))
        kinds = ["recall", "assoc", "spontaneous", "used"]
        for r in rows:
            b.pulse([r["id"]], random.choice(kinds), "demo", [round(random.uniform(0.3, 1), 2)])
        return {"ok": True, "sent": [r["id"] for r in rows]}

    # —— 发件箱（大脑想主动说的话，由机器人轮询发出） ——
    @app.get("/outbox")
    def outbox_get(req: Request):
        kinds = [k for k in (qp(req, "kinds") or "").split(",") if k] or None
        return {"ok": True, "items": OB.pending(b, chat_of(qp(req, "chat_id") or qp(req, "chat")), qp(req, "persona"), qint(req, "limit", 20), kinds)}

    @app.post("/outbox/{oid}/sent")
    def outbox_sent(oid: str):
        return {"ok": OB.mark(b, oid, "sent")}

    @app.post("/outbox/{oid}/result")
    async def outbox_result(oid: str, req: Request):
        d = await body(req)
        return OB.result(b, oid, str(d.get("text") or d.get("result") or ""))

    @app.post("/outbox/{oid}/cancel")
    def outbox_cancel(oid: str):
        return {"ok": OB.mark(b, oid, "cancelled")}

    @app.get("/api/outbox")
    def api_outbox(req: Request):
        return {"ok": True, "items": OB.listing(b, qp(req, "status"), qint(req, "limit", 50))}

    # —— MCP ——
    @app.post("/mcp")
    async def mcp_post(req: Request):
        from . import mcp
        d = await body(req)
        res = mcp.handle(b, d.get("_") if "_" in d else d, persona=qp(req, "persona"), chat=chat_of(qp(req, "chat")))
        if res is None:
            return Response(status_code=202)
        return JSONResponse(res, headers={"Mcp-Session-Id": req.headers.get("mcp-session-id") or "brain"})

    @app.get("/mcp")
    def mcp_get():
        return Response(status_code=405)

        # ---------------- 人设：读/写 personas/*.md 与 host-config/role-card.md ----------------
    def _p_root():
        return FISH._aura_dir(b.cfg)

    def _p_files():
        out = []
        d = os.path.join(_p_root(), "personas")
        if os.path.isdir(d):
            for fn in sorted(os.listdir(d)):
                if fn.lower().endswith(".md"):
                    p = os.path.join(d, fn)
                    st = os.stat(p)
                    out.append({"id": fn[:-3], "file": fn, "bytes": st.st_size, "mtime": int(st.st_mtime * 1000)})
        rc = os.path.abspath(os.path.join(_p_root(), "..", "host-config", "role-card.md"))
        if os.path.isfile(rc):
            st = os.stat(rc)
            out.append({"id": "role-card", "file": "role-card.md", "bytes": st.st_size, "mtime": int(st.st_mtime * 1000)})
        return out

    def _p_path(pid: str) -> str:
        if pid == "role-card":
            return os.path.abspath(os.path.join(_p_root(), "..", "host-config", "role-card.md"))
        if not re.fullmatch(r"[A-Za-z0-9_\-]{1,40}", pid or ""):
            raise ValueError("非法的人设 id")
        return os.path.join(_p_root(), "personas", pid + ".md")

    @app.get("/api/persona")
    async def persona_list():
        cur = (b.cfg.get("persona") or {}).get("current") or b.primary
        files = _p_files()
        text = ""
        p = _p_path(cur)
        if os.path.isfile(p):
            text = io.open(p, encoding="utf-8").read()
        return {"ok": True, "current": cur, "files": files, "text": text}

    @app.get("/api/persona/get")
    async def persona_get(id: str = "dafeiyu"):
        p = _p_path(id)
        if not os.path.isfile(p):
            return JSONResponse({"ok": False, "message": "没有这个人设文件"}, status_code=404)
        st = os.stat(p)
        return {"ok": True, "id": id, "path": p, "bytes": st.st_size,
                "mtime": int(st.st_mtime * 1000), "text": io.open(p, encoding="utf-8").read()}

    @app.put("/api/persona")
    async def persona_save(req: Request):
        d = await body(req)
        pid = str(d.get("id") or (b.cfg.get("persona") or {}).get("current") or b.primary)
        text = d.get("text")
        if not isinstance(text, str):
            return JSONResponse({"ok": False, "message": "text 必须是字符串"}, status_code=400)
        if len(text.encode("utf-8")) > 200_000:
            return JSONResponse({"ok": False, "message": "太长（>200KB）"}, status_code=400)
        p = _p_path(pid)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        bak = ""
        if os.path.isfile(p):
            bak = p + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
            shutil.copy2(p, bak)
        tmp = p + ".tmp"
        with io.open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, p)
        return {"ok": True, "id": pid, "path": p, "backup": bak,
                "bytes": len(text.encode("utf-8")),
                "message": "已保存（她的下一轮对话就会用新人设）"}

    # ---------------- TTS 代理守护（8790） ----------------
    @app.get("/api/tts/status")
    def tts_status():
        return {"ok": True, **PW.status()}

    @app.post("/api/tts/restart")
    def tts_restart():
        PW._started["at"] = 0  # 清冷却
        started = PW.start_proxy(lambda m: b.log.info(m) if hasattr(b, "log") else None)
        time.sleep(3)
        return {"ok": PW.healthy(), "started": started, **PW.status()}
# ======================= /api 工作台 =======================
    @app.get("/api/fish/status")
    def fish_status():
        return FISH.status(b.cfg)

    @app.get("/api/stickers")
    def stickers_list():
        root = FISH._aura_dir(b.cfg) / "stickers"
        items = []
        try:
            if root.is_dir():
                for p in sorted(root.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
                    if p.is_file() and not p.name.startswith("."):
                        st = p.stat()
                        items.append({"name": p.name, "size": st.st_size, "at": int(st.st_mtime * 1000)})
        except Exception as e:
            return {"ok": False, "message": str(e), "items": items}
        return {"ok": True, "dir": str(root), "total": len(items), "size": sum(i["size"] for i in items), "items": items}

    @app.post("/api/stickers/delete")
    async def stickers_delete(req: Request):
        body = await req.json()
        name = str((body or {}).get("name") or "")
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return {"ok": False, "message": "文件名不合法"}
        p = FISH._aura_dir(b.cfg) / "stickers" / name
        if not p.is_file():
            return {"ok": False, "message": "没有这个贴纸"}
        try:
            p.unlink()
            return {"ok": True, "message": "已删除 " + name}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    @app.get("/api/fish/log")
    def fish_log(lines: int = 120):
        st = FISH.status(b.cfg)
        return {"ok": True, "file": st.get("log_file"), "lines": (st.get("log_tail") or [])[-max(1, min(400, lines)):]}

    @app.post("/api/fish/config")
    async def fish_config(req: Request):
        # 坏 JSON（比如 PowerShell 单引号拼的）不再 500，回一句清楚的错误
        try:
            d = json.loads((await req.body()).decode("utf-8-sig") or "{}")
        except Exception:
            return JSONResponse({"ok": False, "error": "bad_json", "message": "请求体不是合法 JSON（键名要用双引号）"}, status_code=400)
        changes = d.get("changes") if isinstance(d, dict) else None
        return FISH.write_back(b.cfg, changes if isinstance(changes, list) else [])

    @app.get("/api/fish/applied")
    def fish_applied():
        return FISH.applied(b.cfg)
    @app.get("/api/auth/check")
    def auth_check():
        return {"ok": True}

    @app.get("/api/atlas")
    def atlas(req: Request):
        return V.atlas(b, qp(req, "persona"), chat_of(qp(req, "chat")))

    @app.get("/api/search")
    def search(req: Request):
        q = qp(req, "q", "")
        res = M.search(b, q, chat=chat_of(qp(req, "chat")), persona=qp(req, "persona"), limit=qint(req, "limit", 20))
        # 18+ 记忆不进面板搜索（星图/列表/搜索三处一致），除非显式 include_adult=1 且开关打开
        if not SENS.reveal_allowed(b.cfg, qp(req, "include_adult")):
            res["results"] = [x for x in (res.get("results") or []) if not V._is_adult_memory(x)]
            res["total"] = len(res["results"])
        if res["results"]:
            b.pulse([x["id"] for x in res["results"][:8]], "search", "", [min(1, x["score"] / 8) for x in res["results"][:8]])
        return {"ok": True, "q": q, **res}

    # —— 记忆 CRUD ——
    @app.get("/api/filter-options")
    def filter_options(req: Request):
        """筛选下拉的真实可选项：从现有数据聚合，避免出现永远筛不出结果的假选项。"""
        tags = {}
        for r in b.db.q("SELECT tags FROM memories WHERE status='active'"):
            try:
                for t in (jload(r["tags"], []) or []):
                    s = str(t).strip()
                    if s:
                        tags[s] = tags.get(s, 0) + 1
            except Exception:
                pass
        def pairs(sql):
            return [{"value": r[0], "count": r[1]} for r in b.db.q(sql) if r[0]]
        return {"ok": True,
                "tags": [{"value": k, "count": v} for k, v in sorted(tags.items(), key=lambda x: -x[1])[:80]],
                "kinds": pairs("SELECT kind, COUNT(*) c FROM memories WHERE status='active' GROUP BY kind ORDER BY c DESC"),
                "scopes": pairs("SELECT scope, COUNT(*) c FROM memories WHERE status='active' GROUP BY scope ORDER BY c DESC"),
                "statuses": pairs("SELECT status, COUNT(*) c FROM memories GROUP BY status ORDER BY c DESC"),
                "emotion_dims": [{"value": d, "count": 1} for d in EMO.DIMS]}


    @app.get("/api/memories")
    def memories(req: Request):
        status = qp(req, "status", "active")
        conds, ps = [], []
        if status != "all":
            conds.append("status=?"); ps.append(status)
        if qp(req, "persona"):
            conds.append("owner_persona=?"); ps.append(qp(req, "persona"))
        if qp(req, "kind"):
            conds.append("kind=?"); ps.append(qp(req, "kind"))
        if qp(req, "origin"):
            conds.append("origin_chat=?"); ps.append(norm_chat(qp(req, "origin")) if qp(req, "origin")[:2] not in ("sy", "le") else qp(req, "origin"))
        if qp(req, "tag"):
            conds.append("tags LIKE ?"); ps.append(f'%"{qp(req, "tag")}"%')
        ids = None
        if qp(req, "q"):
            sr = M.search(b, qp(req, "q"), chat=None, persona=qp(req, "persona"), limit=300)["results"]
            ids = [x["id"] for x in sr]
            like = b.db.q("SELECT id FROM memories WHERE content LIKE ? OR id=? LIMIT 300", (f"%{qp(req, 'q')}%", qp(req, "q")))
            ids += [r["id"] for r in like if r["id"] not in ids]
            if not ids:
                return {"ok": True, "total": 0, "items": []}
            conds.append(f"id IN ({','.join('?' * len(ids))})"); ps += ids
        w = ("WHERE " + " AND ".join(conds)) if conds else ""
        rows = b.db.q(f"SELECT * FROM memories {w} LIMIT 20000", ps)
        now = now_ms()
        items = [M.view(b, r, now) for r in rows]
        # 18+ 记忆默认不在控制台列表里显示（星图/列表都藏），除非显式 include_adult=1
        if not SENS.reveal_allowed(b.cfg, qp(req, "include_adult")):  # 还要主人在 config 里打开 adult_reveal
            items = [x for x in items if not V._is_adult_memory(x)]
        if qp(req, "state"):
            items = [x for x in items if x["state"] == qp(req, "state")]
        if qp(req, "scope"):
            sc = qp(req, "scope")
            items = [x for x in items if x["effective_scope"] == sc or x["scope"] == sc]
        if qp(req, "chat"):
            vc = norm_chat(qp(req, "chat"))
            items = [x for x in items if b.privacy.is_visible(x, vc)]
        sort = qp(req, "sort", "updated")
        key = {"created": lambda x: x["created_at"] or "", "importance": lambda x: (x["importance"], x["salience"]), "strength": lambda x: x["strength"],
               "recall": lambda x: x["recall_count"] or 0}.get(sort, lambda x: x["updated_at"] or x["created_at"] or "")
        if ids is not None and sort == "updated" and not qp(req, "sort"):
            order = {i: n for n, i in enumerate(ids)}
            items.sort(key=lambda x: order.get(x["id"], 9999))
        else:
            items.sort(key=key, reverse=True)
        off, lim = qint(req, "offset", 0), max(1, min(1000, qint(req, "limit", 50)))
        return {"ok": True, "total": len(items), "items": items[off:off + lim]}

    @app.get("/api/memories/{mid}")
    def memory_detail(mid: str):
        r = mem_or_404(mid)
        links = []
        for l in b.db.q("SELECT * FROM memory_links WHERE a_id=? OR b_id=? ORDER BY weight DESC LIMIT 40", (mid, mid)):
            o = l["b_id"] if l["a_id"] == mid else l["a_id"]
            orow = M.get(b, o)
            links.append({"id": o, "w": round(l["weight"], 3), "k": l["kind"], "content": orow["content"] if orow else ""})
        audit = [dict(a) for a in b.db.q("SELECT action, detail, created_at FROM memory_audit WHERE memory_id=? ORDER BY id DESC LIMIT 50", (mid,))]
        chain, cur, seen = [], r, {mid}
        for pr in b.db.q("SELECT * FROM memories WHERE superseded_by=?", (mid,)):
            chain.append({"id": pr["id"], "content": pr["content"], "status": pr["status"], "relation": "older"})
        while cur["superseded_by"] and cur["superseded_by"] not in seen:
            seen.add(cur["superseded_by"])
            cur = M.get(b, cur["superseded_by"])
            if not cur:
                break
            chain.append({"id": cur["id"], "content": cur["content"], "status": cur["status"], "relation": "newer"})
        return {"ok": True, "memory": M.view(b, r), "links": links, "audit": audit, "superseded_chain": chain}

    @app.post("/api/memories")
    async def memory_create(req: Request):
        d = await body(req)
        chat = d.get("chat_id") or d.get("chat") or d.get("origin_chat")
        r = M.remember(b, content=str(d.get("content") or ""), persona=d.get("persona") or d.get("persona_id"), kind=d.get("kind") or "event",
                       importance=d.get("importance", 3), tags=d.get("tags") or [], chat=norm_chat(chat) if chat and not str(chat).startswith(("system", "legacy")) else (chat or "system"),
                       speaker=str(d.get("speaker") or ""), scope=d.get("scope") or "inherit", allow=d.get("allow") or [], emotion=d.get("emotion"),
                       pin=d.get("pin"), event_date=d.get("event_date"), source="workbench", check_poison=not d.get("force"))
        if r.get("ok") and r.get("id"):
            m = M.get(b, r["id"])
            if m:
                r["item"] = r["memory"] = M.view(b, m)
        return r

    @app.patch("/api/memories/{mid}")
    async def memory_patch(mid: str, req: Request):
        mem_or_404(mid)
        M.update(b, mid, await body(req))
        return {"ok": True, "memory": M.view(b, M.get(b, mid))}

    def _quick(mid, patch):
        mem_or_404(mid)
        M.update(b, mid, patch)
        return {"ok": True, "memory": M.view(b, M.get(b, mid))}

    @app.post("/api/memories/bulk")
    async def memory_bulk(req: Request):
        d = await body(req)
        act, val, done = d.get("action"), d.get("value"), 0
        for mid in d.get("ids") or []:
            if not M.get(b, mid):
                continue
            if act == "delete":
                M.forget(b, mid)
            elif act in ("pin", "unpin"):
                M.update(b, mid, {"pinned": act == "pin"})
            elif act in ("archive", "restore"):
                M.update(b, mid, {"status": "archived" if act == "archive" else "active"})
            elif act == "scope":
                M.update(b, mid, {"scope": val})
            elif act == "importance":
                M.update(b, mid, {"importance": int(val)})
            elif act == "persona":
                b.db.x("UPDATE memories SET owner_persona=? WHERE id=?", (val, mid))
            else:
                err(400, "bad_action", "action 只能是 pin/unpin/archive/restore/delete/scope/importance/persona")
            done += 1
        return {"ok": True, "done": done}

    @app.post("/api/memories/{mid}/pin")
    def m_pin(mid: str):
        return _quick(mid, {"pinned": True})

    @app.post("/api/memories/{mid}/unpin")
    def m_unpin(mid: str):
        return _quick(mid, {"pinned": False})

    @app.post("/api/memories/{mid}/archive")
    def m_archive(mid: str):
        r = _quick(mid, {"status": "archived"}); b.audit(mid, "archive", "manual"); return r

    @app.post("/api/memories/{mid}/restore")
    def m_restore(mid: str):
        return _quick(mid, {"status": "active"})

    @app.post("/api/memories/{mid}/reinforce")
    def m_reinforce(mid: str):
        mem_or_404(mid)
        M.reinforce(b, mid, "", "review")
        return {"ok": True, "memory": M.view(b, M.get(b, mid))}

    @app.post("/api/memories/{mid}/supersede")
    async def m_supersede(mid: str, req: Request):
        mem_or_404(mid)
        d = await body(req)
        if not str(d.get("content") or "").strip():
            err(400, "empty", "新事实不能为空")
        return M.supersede(b, mid, str(d["content"]), d.get("keep_scope", True) is not False)

    @app.post("/api/memories/{mid}/link")
    async def m_link(mid: str, req: Request):
        mem_or_404(mid)
        d = await body(req)
        o = d.get("other")
        if not o or not M.get(b, o) or o == mid:
            err(400, "bad_other", "other 必须是另一条存在的记忆")
        M.upsert_link(b, mid, o, float(d.get("weight") or 0.6), "manual")
        b.audit(mid, "link", {"other": o})
        return {"ok": True, "memory": M.view(b, M.get(b, mid))}

    @app.delete("/api/memories/{mid}/link/{other}")
    def m_unlink(mid: str, other: str):
        a, c = sorted([mid, other])
        n = b.db.x("DELETE FROM memory_links WHERE a_id=? AND b_id=?", (a, c)).rowcount
        return {"ok": True, "deleted": n}

    @app.delete("/api/memories/{mid}")
    def m_delete(mid: str):
        if not M.forget(b, mid):
            err(404, "not_found", "没有这条记忆")
        return {"ok": True, "deleted": mid}

    # —— 隐私 ——
    def known_chats():
        labels = b.cfg.get("chat_labels") or {}
        rows = {}
        for r in b.db.q("SELECT origin_chat c, COUNT(*) n FROM memories WHERE status='active' GROUP BY origin_chat"):
            rows[r["c"] or ""] = {"memories": r["n"], "last_turn_at": None}
        for r in b.db.q("SELECT chat_id c, last_turn_at FROM chat_counters"):
            rows.setdefault(r["c"], {"memories": 0, "last_turn_at": None})["last_turn_at"] = r["last_turn_at"]
        out = []
        for c, v in rows.items():
            if not c:
                continue
            out.append({"chat": c, "label": labels.get(c) or labels.get(c.split(":", 1)[-1]) or "", "policy": b.privacy.policy_of(c), **v})
        out.sort(key=lambda x: (x["chat"][:1] != "p", x["chat"]))
        return out

    @app.get("/api/privacy")
    def privacy_get():
        b.privacy.reload()
        return {"ok": True, "path": str(b.privacy.path), "privacy": b.privacy.data, "known_chats": known_chats()}

    @app.put("/api/privacy")
    async def privacy_put(req: Request):
        d = await body(req)
        d = d.get("privacy") if isinstance(d.get("privacy"), dict) else d
        if not isinstance(d, dict) or not isinstance(d.get("private_chats"), dict) or not isinstance(d.get("groups", {}), dict):
            err(400, "bad_privacy", "格式不对：需要 private_chats（对象）和 groups（对象）")
        for k, v in d["private_chats"].items():
            if v not in ("private", "scoped", "public"):
                err(400, "bad_privacy", f"私聊 {k} 的策略只能是 private/scoped/public")
        b.privacy.save(d)
        with b.cache_lock:
            b.cache.clear()
        pf.cache.clear()
        b.log.info("privacy.json 已更新（热加载）")
        return {"ok": True, "privacy": b.privacy.data}

    # —— 跨平台身份（QQ ↔ 抖音）——
    @app.get("/api/identity")
    def identity_get():
        return IDS.visible_snapshot(b.cfg.privacy_file)

    @app.post("/api/identity/sync")
    def identity_sync():
        st = IDS.sync(force=True, target=b.cfg.privacy_file)
        _privacy_changed()
        return {"ok": True, **st}

    @app.post("/api/privacy/check")
    async def privacy_check(req: Request):
        d = await body(req)
        chat = norm_chat(d.get("chat") or d.get("chat_id") or "")
        vis, vp = b.privacy.visible_sql(chat, "m")
        nv = b.db.one(f"SELECT COUNT(*) c FROM memories m WHERE status='active' AND {vis}", vp)["c"]
        tot = b.db.one("SELECT COUNT(*) c FROM memories WHERE status='active'")["c"]
        g = b.privacy.guard(b.db, chat, str(d.get("text") or ""), "", d.get("persona"))
        return {"ok": True, "chat": chat, "visible": nv, "hidden": tot - nv, "guard": g}

    # —— 上下文预览 ——
    @app.api_route("/api/context/preview", methods=["GET", "POST"])
    async def ctx_preview(req: Request):
        d = await body(req) if req.method == "POST" else {}
        for k in ("chat", "chat_id", "message", "persona", "user_id"):
            if qp(req, k) and k not in d:
                d[k] = qp(req, k)
        return CTX.preview(b, d)

    # —— 情绪 / 激素 / 身体 / 欲望 / 梦 ——
    @app.get("/style")
    def style_feed(req: Request):
        """说话风格自调：插件 mood 模块每分钟取一次「体感情绪」（表面 0.7 + 心里 0.3）。
        只给数，不给文字；情欲维度不出这个口子（18+ 永不外露）。"""
        pid = persona_of(req)
        try:
            st = EMO.state(b, pid)
        except Exception as e:
            return {"ok": False, "error": str(e)[:120], "felt": {}}
        if not st.get("enabled"):
            return {"ok": True, "enabled": False, "felt": {}}
        felt = {}
        for d, v in (st.get("dims") or {}).items():
            if d in STYLE_HIDDEN_DIMS:
                continue
            try:
                felt[d] = round(float(v.get("surface") or 0) * 0.7 + float(v.get("inner") or 0) * 0.3, 1)
            except Exception:
                continue
        return {"ok": True, "enabled": True, "persona": pid, "felt": felt}

    @app.get("/api/emotion")
    def emotion_get(req: Request):
        return {"ok": True, **EMO.state(b, persona_of(req))}

    @app.post("/api/emotion/apply")
    async def emotion_apply(req: Request):
        d = await body(req)
        return EMO.apply(b, persona_of(req, d), d, source="workbench")

    # —— 每个情绪 / 激素的开关、权重、衰减（控制台「情绪调节」用；Bearer 鉴权同其它 /api）——
    @app.get("/api/emotion/tuning")
    def emotion_tuning_get(req: Request):
        adult = str(qp(req, "include_adult") or "") in ("1", "true") and bool(b.cfg.get("adult_reveal"))
        return {"ok": True, **EMO.tuning_view(b, include_adult=adult)}

    @app.post("/api/emotion/tuning")
    async def emotion_tuning_set(req: Request):
        d = await body(req)
        clean = EMO.tuning_clean(d)
        cur = b.cfg.get("emotion_tuning") or {}
        merged = {"dims": {**(cur.get("dims") or {})}, "hormones": {**(cur.get("hormones") or {})}}
        for sec in ("dims", "hormones"):
            for k, v in clean[sec].items():
                merged[sec][k] = {**(merged[sec].get(k) or {}), **v}
        if d.get("reset"):
            for k in (d.get("reset") or []):
                merged["dims"].pop(k, None); merged["hormones"].pop(k, None)
        b.cfg.data["emotion_tuning"] = {}   # save() 是深合并：先清空，reset 掉的键才真的消失
        b.cfg.save({"emotion_tuning": merged})
        return {"ok": True, **EMO.tuning_view(b, include_adult=str(qp(req, "include_adult") or "") in ("1", "true") and bool(b.cfg.get("adult_reveal")))}

    @app.get("/api/starhalo")
    def starhalo_get():
        from . import starhalo as SH
        return {"ok": True, "config": SH.conf(b), "inertia": float((b.cfg.get("starhalo") or {}).get("inertia", 0) or 0)}

    @app.post("/api/starhalo")
    async def starhalo_set(req: Request):
        from . import starhalo as SH
        d = await body(req)
        cur = dict(b.cfg.get("starhalo") or {})
        if "enabled" in d: cur["enabled"] = bool(d["enabled"])
        if "feedback" in d: cur["feedback"] = bool(d["feedback"])
        if "confidence_min" in d: cur["confidence_min"] = max(0.0, min(1.0, float(d["confidence_min"])))
        if "inertia" in d: cur["inertia"] = max(0.0, min(0.9, float(d["inertia"])))
        for k in ("subjective_filter", "random_walk"):
            if isinstance(d.get(k), dict):
                x = {**(cur.get(k) or {})}
                for kk, vv in d[k].items():
                    if kk == "enabled": x[kk] = bool(vv)
                    elif kk in ("strength", "emo_lo", "emo_hi"): x[kk] = max(0.0, min(1.0, float(vv)))
                    elif kk == "min_interval_min": x[kk] = max(0, min(1440, int(vv)))
                cur[k] = x
        b.cfg.save({"starhalo": cur})
        return {"ok": True, "config": SH.conf(b)}

    # —— 星骸：主人对记忆的确认 / 更正 / 否认（带版本乐观锁）——
    # ---- 归档前自检预览 / 核心事实候选 / 待证实列表（工作台用，管理员接口） ----
    @app.get("/api/batch2/archive_preview")
    def b2_archive_preview():
        from . import maintenance as MT
        return MT.archive_preview(b)

    @app.post("/api/batch2/seed_core")
    async def b2_seed_core(req: Request):
        from . import maintenance as MT
        d = await body(req)
        return MT.seed_core_candidates(b, int(d.get("n") or 20), dry=bool(d.get("dry_run")))

    @app.get("/api/batch2/pending")
    def b2_pending():
        rows = b.db.q("SELECT * FROM memories WHERE status='active' AND credibility IN ('pending','pending_core') ORDER BY credibility DESC, created_at DESC LIMIT 200")
        return {"ok": True, "items": [M.view(b, r) for r in rows]}

    @app.post("/api/memories/{mid}/feedback")
    async def memory_feedback(mid: str, req: Request):
        from . import starhalo as SH
        if not SH.on(b, "feedback"):
            err(403, "disabled", "starhalo.feedback 已关")
        d = await body(req)
        r = SH.feedback(b, mid, str(d.get("action") or ""), str(d.get("content") or ""), d.get("expected_version"))
        if r.get("error") == "version_conflict":
            return JSONResponse(r, status_code=409)
        with b.cache_lock:
            b.cache.clear()
        return r

    # —— 星海生长 / 关系（主人鉴权）——
    @app.get("/api/growth")
    def growth_get(req: Request):
        from . import growth as G
        pid = persona_of(req)
        return {**G.view(b, pid), "snapshots": G.snapshots(b, pid, 30)}

    @app.post("/api/growth")
    async def growth_post(req: Request):
        from . import growth as G
        d = await body(req); pid = persona_of(req, d)
        act = d.get("action") or ""
        if act == "rollback":
            return G.rollback(b, pid, str(d.get("id") or ""))
        if act == "reset":
            return G.reset(b, pid)
        if act == "grow":
            return G.grow(b, pid, force=True)
        if act == "traits":
            return G.set_traits(b, pid, d.get("traits") or {})
        cfg = {k: d[k] for k in ("enabled", "frozen", "relations", "rhythm", "interests") if k in d}
        for k, lo, hi in (("step", 0.0, 0.1), ("max_drift", 0.0, 0.5)):
            if k in d:
                try: cfg[k] = max(lo, min(hi, float(d[k])))
                except (TypeError, ValueError): pass
        if cfg:
            b.cfg.save({"growth": cfg})
        return G.view(b, pid)

    @app.get("/api/relations")
    def relations_get(req: Request):
        from . import growth as G
        return {"ok": True, "people": G.relations_view(b, persona_of(req))}

    @app.post("/api/relations/note")
    async def relations_note(req: Request):
        from . import growth as G
        d = await body(req)
        return G.set_note(b, persona_of(req, d), str(d.get("person") or ""), d.get("note"), d.get("milestone"))

    @app.get("/api/emotion/events")
    def emotion_events(req: Request):
        return {"ok": True, **EMO.events(b, persona_of(req), qint(req, "limit", 30))}

    @app.get("/api/bio")
    def bio_get(req: Request):
        return EMO.bio_state(b, persona_of(req))

    @app.post("/api/bio/event")
    async def bio_post(req: Request):
        d = await body(req)
        return EMO.bio_event(b, persona_of(req, d), d)

    @app.get("/api/state/series")
    def series(req: Request):
        pid = persona_of(req)
        since = iso(now_ms() - qint(req, "hours", 72) * 3600_000)
        from .body import migrate_values   # 旧库里的男性指标键名自动换成 wetness/emptiness
        def ser(table, key):
            return [{"at": r["at"], "values": migrate_values(jload(r["values_json"], {}))} for r in b.db.q(f"SELECT at, values_json FROM {table} WHERE persona_id=? AND at>=? ORDER BY at", (key, since))]
        adult = b.module_on("body", pid)
        return {"ok": True, "emotion": ser("emotion_series", pid), "hormones": ser("emotion_series", "bio:" + pid),
                "body": ser("body_series", pid) if adult else [], "desire": DES.series(b, pid, since)}

    @app.get("/api/body")
    def body_get(req: Request):
        from . import body as BODY
        return {"ok": True, **BODY.status(b, persona_of(req))}

    @app.post("/api/body/events")
    async def body_events(req: Request):
        from . import body as BODY
        d = await body(req)
        pid = persona_of(req, d)
        if not b.module_on("body", pid):
            err(400, "disabled", "这个人格的身体模块没开（config: body_enabled / body_personas）")
        t = BODY.turn(b, pid, message=str(d.get("message") or ""), events=d.get("events") if isinstance(d.get("events"), list) else None)
        return {"ok": True, **BODY.status(b, pid), "notes": t.get("notes") or [], "injection": t.get("injection"), "applied": t.get("events")}

    @app.post("/api/body/cron")
    async def body_cron(req: Request):
        from . import body as BODY
        d = await body(req)
        return BODY.cron(b, persona_of(req, d), force=bool(d.get("force")))

    @app.get("/api/body/log")
    def body_log(req: Request):
        from . import body as BODY
        pid = persona_of(req)
        lg = BODY.log(b, pid, qint(req, "limit", 50))
        ev = [dict(r) for r in b.db.q("SELECT * FROM body_events WHERE persona_id=? ORDER BY created_at DESC LIMIT ?", (pid, qint(req, "limit", 50)))]
        pr = [dict(r) for r in b.db.q("SELECT * FROM body_private_records WHERE persona_id=? ORDER BY created_at DESC LIMIT ?", (pid, qint(req, "limit", 50)))]
        wq = [dict(r) for r in b.db.q("SELECT * FROM body_wake_queue WHERE persona_id=? ORDER BY created_at DESC LIMIT ?", (pid, qint(req, "limit", 50)))]
        return {"ok": True, "events": ev, "private_records": pr, "wake_queue": wq, "log": lg}

    @app.post("/api/body/log/read")
    def body_log_read(req: Request):
        from . import body as BODY
        return {"ok": True, **(BODY.log_mark_read(b, persona_of(req)) or {})}

    @app.get("/api/desires")
    def desires(req: Request):
        return {"ok": True, "items": DES.listing(b, persona_of(req), qint(req, "limit", 50))}

    @app.post("/api/desires")
    async def desire_add(req: Request):
        d = await body(req)
        try:
            r = DES.save(b, persona_of(req, d), d)
        except DES.DesireError as e:
            err(400, "bad_desire", str(e))
        return {"ok": True, **r} if isinstance(r, dict) else {"ok": True, "item": r}

    @app.post("/api/desires/{did}/replies")
    async def desire_reply(did: str, req: Request):
        d = await body(req)
        try:
            r = DES.add_reply(b, did, str(d.get("content") or d.get("body") or ""), d.get("author") or "user")
        except DES.DesireError as e:
            err(400, "bad_reply", str(e))
        return {"ok": True, **r} if isinstance(r, dict) else {"ok": True}

    @app.delete("/api/desires/{did}")
    def desire_del(did: str):
        return {"ok": DES.forget(b, did)}

    def _dream_items(pid, limit):
        out = []
        for dd in DRM.listing(b, pid, limit)["items"]:
            cons = dd.get("consolidated")
            out.append({**dd, "day": dd.get("dream_date"), "content": dd.get("text"), "material": dd.get("cited_ids") or [],
                        "consolidated": cons if isinstance(cons, list) else []})
        return out

    @app.get("/api/dreams")
    def dreams(req: Request):
        return {"ok": True, "items": _dream_items(qp(req, "persona"), qint(req, "limit", 20))}

    @app.post("/api/dreams")
    async def dream_add(req: Request):
        d = await body(req)
        return DRM.save_manual(b, persona_of(req, d), d)

    @app.delete("/api/dreams/{did}")
    def dream_del(did: str):
        return {"ok": DRM.delete(b, did)}

    @app.get("/api/modules")
    def modules():
        return {"ok": True, "emotion": {"enabled": bool(b.cfg.get("emotion_enabled")), "personas": b.cfg.get("emotion_personas") or []},
                "body": {"enabled": bool(b.cfg.get("body_enabled")), "personas": b.cfg.get("body_personas") or []},
                "dream": {"enabled": bool(b.cfg.get("dream_enabled")), "personas": [b.cfg.get("dream_persona") or b.primary]},
                "desire": {"enabled": bool(b.cfg.get("desire_enabled", True)), "personas": b.cfg.get("desire_personas") or []},
                "llm": {"configured": b.llm.configured, "model": (b.cfg.get("llm") or {}).get("model") or ""},
                "vectors": {"enabled": bool((b.cfg.get("vectors") or {}).get("enabled"))}}

    # —— 延续性 ——
    def _coll_list(name, req):
        pid, st = qp(req, "persona"), qp(req, "status")
        if name == "unresolved":
            return C.unresolved_list(b, pid, st or "open", chat_of(qp(req, "chat")), qint(req, "limit", 50))
        if name == "notes":
            return C.notes_list(b, pid, st, qint(req, "limit", 100))
        if name == "heart-traces":
            return C.hearts(b, pid, qint(req, "limit", 50))
        if name == "handoffs":
            return C.handoffs(b, pid, chat_of(qp(req, "chat") or qp(req, "chat_id")), qint(req, "limit", 50))
        return []

    def _row(table, rid):
        r = b.db.one(f"SELECT * FROM {table} WHERE id=?", (rid,))
        return dict(r) if r else None

    @app.get("/api/unresolved")
    def unresolved(req: Request):
        return {"ok": True, "items": _coll_list("unresolved", req)}

    @app.post("/api/unresolved")
    async def unresolved_add(req: Request):
        d = await body(req)
        if not str(d.get("content") or "").strip():
            err(400, "empty", "内容不能为空")
        uid = C.unresolved_add(b, persona_of(req, d), str(d["content"]), chat_of(d.get("chat_id")) or "")
        uid = uid.get("id") if isinstance(uid, dict) else uid
        return {"ok": True, "id": uid, "item": _row("unresolved", uid)}

    @app.post("/api/unresolved/{uid}/close")
    async def unresolved_close(uid: str, req: Request):
        d = await body(req)
        C.unresolved_close(b, uid, str(d.get("resolution") or ""))
        return {"ok": True, "item": _row("unresolved", uid)}

    @app.delete("/api/unresolved/{uid}")
    def unresolved_del(uid: str):
        C.unresolved_delete(b, uid); return {"ok": True}

    @app.get("/api/notes")
    def notes(req: Request):
        return {"ok": True, "items": _coll_list("notes", req)}

    @app.post("/api/notes")
    async def note_add(req: Request):
        d = await body(req)
        if not str(d.get("content") or "").strip():
            err(400, "empty", "便条不能为空")
        nid = C.note_write(b, persona_of(req, d), str(d["content"]), d.get("memory_id"), d.get("author") or "user")
        nid = nid.get("id") if isinstance(nid, dict) else nid
        return {"ok": True, "id": nid, "item": _row("notes", nid)}

    @app.post("/api/notes/{nid}/reply")
    async def note_reply(nid: str, req: Request):
        d = await body(req)
        C.note_reply(b, nid, str(d.get("reply") or ""), d.get("action") or "other")
        return {"ok": True, "item": _row("notes", nid)}

    @app.delete("/api/notes/{nid}")
    def note_del(nid: str):
        C.note_delete(b, nid); return {"ok": True}

    @app.get("/api/heart-traces")
    def hearts(req: Request):
        return {"ok": True, "items": _coll_list("heart-traces", req)}

    @app.post("/api/heart-traces")
    async def heart_add(req: Request):
        d = await body(req)
        if not str(d.get("content") or "").strip():
            err(400, "empty", "内容不能为空")
        hid = C.heart_save(b, persona_of(req, d), str(d.get("title") or clip(d["content"], 12)), str(d["content"]), d.get("created_by") or "user")
        hid = hid.get("id") if isinstance(hid, dict) else hid
        return {"ok": True, "id": hid, "item": _row("heart_traces", hid)}

    @app.delete("/api/heart-traces/{hid}")
    def heart_del(hid: str):
        C.heart_delete(b, hid); return {"ok": True}

    @app.get("/api/handoffs")
    def handoffs(req: Request):
        return {"ok": True, "items": _coll_list("handoffs", req)}

    @app.post("/api/handoffs")
    async def handoff_add(req: Request):
        d = await body(req)
        if not str(d.get("summary") or "").strip():
            err(400, "empty", "交接正文不能为空")
        r = C.handoff_close(b, persona_of(req, d), chat_of(d.get("chat_id")) or "", str(d["summary"]), d.get("mood"), d.get("next_time"), "workbench")
        hid = r.get("id") if isinstance(r, dict) else r
        return {"ok": True, "id": hid, "item": C.handoff_get(b, hid)}

    @app.post("/api/handoffs/generate")
    async def handoff_gen(req: Request):
        d = await body(req)
        chat = chat_of(d.get("chat_id") or d.get("chat"))
        if not chat:
            err(400, "need_chat", "需要 chat_id")
        r = C.handoff_generate(b, persona_of(req, d), chat)
        if r.get("ok") and r.get("id") and "item" not in r:
            r["item"] = C.handoff_get(b, r["id"])
        return r

    @app.delete("/api/handoffs/{hid}")
    def handoff_del(hid: str):
        C.handoff_delete(b, hid); return {"ok": True}

    @app.get("/api/session-start")
    def session_start(req: Request):
        return {"ok": True, **C.session_start(b, persona_of(req), chat_of(qp(req, "chat")))}

    @app.get("/api/reviews")
    def reviews(req: Request):
        return {"ok": True, "items": C.reviews(b, qp(req, "persona"), qint(req, "limit", 50))}

    @app.get("/api/cognitions")
    def cognitions(req: Request):
        r = COG.listing(b, qp(req, "persona"), qp(req, "status"))
        return r if isinstance(r, dict) else {"ok": True, "items": r}

    @app.post("/api/cognitions/{cid}/write")
    async def cognition_write(cid: str, req: Request):
        d = await body(req)
        return COG.write(b, cid, str(d.get("text") or ""), d.get("persona"))

    @app.post("/api/cognitions/{cid}/undo")
    async def cognition_undo(cid: str, req: Request):
        d = await body(req)
        return COG.undo(b, cid, bool(d.get("drop")))

    @app.get("/api/spill")
    def spill_files():
        return {"ok": True, "dir": str(b.cfg.spill_path), "items": SP.files(b)}

    @app.get("/api/spill/search")
    def spill_search(req: Request):
        return {"ok": True, "items": SP.search(b, qp(req, "q", ""), chat_of(qp(req, "chat")), qint(req, "limit", 10), force=True, min_hits=1)}

    # —— 维护 ——
    @app.post("/api/run/{job}")
    async def run(job: str, req: Request):
        d = await body(req)
        if d.get("chat_id"):
            d["chat_id"] = norm_chat(d["chat_id"])
        if job == "dream":
            d.setdefault("manual", True)
        # 原来在 async 端点里同步跑重活（全表扫描 / 整库备份 / LLM），
        # 会占住 uvicorn 事件循环，连 /health 和星图的 /api/think 都跟着排队。
        # 挪到线程池 + 超时，任何单个任务卡住都不再拖垮整个服务。
        try:
            r = await asyncio.wait_for(asyncio.to_thread(SCH.run_job, b, job, d), timeout=90)
        except asyncio.TimeoutError:
            r = {"ok": False, "error": "timeout", "message": "任务超过 90 秒，已放弃（其它请求不受影响）"}
        if not r.get("ok") and r.get("error") == "unknown job":
            err(404, "unknown_job", "没有这个任务：" + job)
        return r

    @app.get("/api/jobs")
    def jobs():
        return {"ok": True, "jobs": SCH.jobs_view(b), "scheduler": bool(b.cfg.get("scheduler_enabled", True))}

    @app.get("/api/logs")
    def logs(req: Request):
        lim, lv, q = qint(req, "limit", 200), (qp(req, "level") or "").upper(), qp(req, "q")
        order = {"DEBUG": 0, "INFO": 1, "WARNING": 2, "ERROR": 3, "CRITICAL": 4}
        lines = [x for x in list(b.ring.buf) if (not lv or order.get(x["level"], 1) >= order.get(lv, 0)) and (not q or q in x["msg"])]
        return {"ok": True, "lines": lines[-lim:]}

    def _bdir():
        return Path(b.cfg.backup_path)

    @app.get("/api/backups")
    def backups():
        items = [{"name": p.name, "size": p.stat().st_size, "mtime": iso(p.stat().st_mtime * 1000)}
                 for p in sorted(_bdir().glob("brain-*.db"), key=lambda p: p.stat().st_mtime, reverse=True)]
        return {"ok": True, "dir": str(_bdir()), "items": items}

    @app.post("/api/backups")
    def backup_now():
        p = b.db.backup(_bdir(), int(b.cfg.get("backup_keep") or 12), "manual")
        return {"ok": True, "name": p.name}

    def _safe_backup(name):
        if not name or "/" in name or "\\" in name or ".." in name or not name.startswith("brain-"):
            err(400, "bad_name", "备份文件名不对")
        p = _bdir() / name
        if not p.exists():
            err(404, "not_found", "没有这个备份")
        return p

    @app.post("/api/backups/restore")
    async def backup_restore(req: Request):
        d = await body(req)
        p = _safe_backup(d.get("name"))
        pre = b.db.backup(_bdir(), int(b.cfg.get("backup_keep") or 12) + 1, "pre-restore")
        b.db.restore_from(p)
        b.log.warning("已从备份恢复：%s（恢复前的库存为 %s）", p.name, pre.name)
        return {"ok": True, "restored": p.name, "pre_restore": pre.name}

    @app.get("/api/backups/{name}/download")
    def backup_dl(name: str, req: Request):
        # 默认下载「去 18+」副本：身体/欲望/私密记录表清空、成人记忆删掉。要完整库：config adult_reveal=true 且带 ?full=1
        src = _safe_backup(name)
        if str(req.query_params.get("full") or "") == "1" and b.cfg.get("adult_reveal"):
            return FileResponse(src, filename=name, media_type="application/octet-stream")
        import shutil, sqlite3, tempfile
        from .sensitivity import is_adult_row
        tmpd = Path(tempfile.mkdtemp(prefix="bk-"))
        dst = tmpd / name.replace(".db", "-safe.db")
        shutil.copyfile(src, dst)
        con = sqlite3.connect(str(dst)); con.row_factory = sqlite3.Row
        scrub_err = []
        try:
            for t in ADULT_TABLES:
                try: con.execute(f"DELETE FROM {t}")
                except sqlite3.Error as e: scrub_err.append(f"{t}: {e}")
            ids = [r["id"] for r in con.execute("SELECT * FROM memories") if is_adult_row(r)]
            for i in ids:
                con.execute("DELETE FROM memories WHERE id=?", (i,))
                for t, c in (("memory_links", "a_id"), ("memory_links", "b_id"), ("entity_mentions", "memory_id"), ("memory_embeddings", "memory_id")):
                    try: con.execute(f"DELETE FROM {t} WHERE {c}=?", (i,))
                    except sqlite3.Error as e: scrub_err.append(f"{t}: {e}")
            try: con.execute("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
            except sqlite3.Error as e: scrub_err.append(f"fts: {e}")
            con.commit(); con.execute("VACUUM")
        finally:
            con.close()
        if scrub_err:
            shutil.rmtree(tmpd, ignore_errors=True)
            err(500, "scrub_failed", "去 18+ 清理不完整，已拒绝导出：" + "; ".join(scrub_err[:3]))
        # 发完就删临时副本：不然每下载一次就在系统临时目录里留一份记忆库
        from starlette.background import BackgroundTask
        return FileResponse(dst, filename=dst.name, media_type="application/octet-stream",
                            background=BackgroundTask(shutil.rmtree, tmpd, ignore_errors=True))

    @app.get("/api/verify")
    def verify():
        return b.db.verify()

    def _mask(d):
        out = json.loads(json.dumps(d, ensure_ascii=False))
        if (out.get("llm") or {}).get("api_key"):
            out["llm"]["api_key"] = "****" + out["llm"]["api_key"][-4:]
        if out.get("admin_key"):
            out["admin_key"] = "****"
        return out

    @app.get("/api/settings")
    def settings_get():
        return {"ok": True, "path": str(b.cfg.path), "settings": _mask(b.cfg.data)}

    @app.put("/api/settings")
    async def settings_put(req: Request):
        d = await body(req)
        new = d.get("settings") if isinstance(d.get("settings"), dict) else d
        if not isinstance(new, dict):
            err(400, "bad_settings", "settings 必须是对象")
        if (new.get("llm") or {}).get("api_key", "").startswith("****"):
            new["llm"].pop("api_key")
        if str(new.get("admin_key") or "").startswith("****"):
            new.pop("admin_key")
        restart = any(k in new and new[k] != b.cfg.get(k) for k in ("port", "host", "db_path", "data_dir"))
        b.cfg.save(new)
        try:
            b.llm.__init__(b.cfg)
        except Exception:
            pass
        b.ensure_personas()
        return {"ok": True, "restart_required": restart, "settings": _mask(b.cfg.data)}

    @app.get("/api/stats")
    def stats():
        return V.stats(b)

    @app.get("/api/personas")
    def personas():
        return {"ok": True, "items": V.personas(b)}

    @app.put("/api/personas/{pid}")
    async def persona_put(pid: str, req: Request):
        d = await body(req)
        if not b.db.one("SELECT 1 FROM personas WHERE id=?", (pid,)):
            b.db.x("INSERT INTO personas(id, display_name, created_at, updated_at) VALUES (?,?,?,?)", (pid, d.get("display_name") or d.get("name") or pid, iso(), iso()))
        for k_api, col in (("display_name", "display_name"), ("name", "display_name"), ("self_card", "self_card"), ("core", "self_card"), ("relationship_to_user", "relationship_to_user")):
            if k_api in d and d[k_api] is not None:
                b.db.x(f"UPDATE personas SET {col}=?, updated_at=? WHERE id=?", (str(d[k_api]), iso(), pid))
        return {"ok": True, "item": next((p for p in V.personas(b) if p["id"] == pid), None)}

    @app.get("/api/peers/{pid}")
    def peers(pid: str):
        return V.peer_inbox(b, pid, mark_read=False)

    @app.post("/api/peers")
    async def peer_send(req: Request):
        d = await body(req)
        return V.peer_send(b, d.get("from") or b.primary, d.get("to") or "", str(d.get("content") or ""))

    # —— 花园 / deck（companion-memory 原版接口） ——
    @app.get("/api/view/garden")
    def garden(req: Request):
        return V.garden(b, chat_of(qp(req, "chat")))

    @app.get("/api/view/cards/{source}/{ref_id}")
    def card(source: str, ref_id: str, req: Request):
        c = V.card(b, source, ref_id, chat_of(qp(req, "chat")))
        if not c:
            err(404, "not_found", "找不到这张卡")
        return c

    @app.get("/api/view/status")
    def status_get():
        return V.status_get(b)

    @app.post("/api/view/status")
    async def status_set(req: Request):
        return V.status_set(b, await body(req))

    @app.get("/api/view/status/history")
    def status_hist(req: Request):
        return V.status_history(b, qint(req, "limit", 30))

    @app.delete("/api/view/status/{sid}")
    def status_del(sid: str):
        b.db.x("DELETE FROM her_status WHERE id=?", (sid,)); return {"ok": True}

    @app.get("/api/view/companion-notes")
    def cnotes(req: Request):
        return V.companion_notes(b, qp(req, "persona"))

    @app.post("/api/view/companion-notes")
    async def cnote_add(req: Request):
        d = await body(req)
        return V.companion_note_add(b, d.get("persona_id") or d.get("persona"), str(d.get("content") or ""))

    @app.post("/api/view/companion-notes/seen")
    def cnotes_seen():
        return V.companion_notes_seen(b)

    @app.delete("/api/view/companion-notes/{cid}")
    def cnote_del(cid: str):
        b.db.x("DELETE FROM companion_notes WHERE id=?", (cid,)); return {"ok": True}

    @app.post("/api/view/favorites")
    async def fav(req: Request):
        d = await body(req)
        kind, rid, on = d.get("kind") or "memory", str(d.get("ref_id") or ""), d.get("favorite", True) is not False
        if kind == "memory" and M.get(b, rid):
            M.update(b, rid, {"pinned": on})
        return V.favorite(b, kind, rid, on)

    @app.put("/api/view/persona-meta/{pid}")
    async def persona_meta(pid: str, req: Request):
        d = await body(req)
        b.db.x("INSERT INTO garden_persona_meta(persona_id, note, emblem) VALUES (?,?,?) ON CONFLICT(persona_id) DO UPDATE SET note=excluded.note, emblem=excluded.emblem",
               (pid, clip(str(d.get("note") or ""), 200), str(d.get("emblem") or "")))
        return {"ok": True}

    @app.post("/api/view/garden-entries")
    async def gentry_add(req: Request):
        from .util import new_id
        d = await body(req)
        gid = new_id("ge_")
        b.db.x("INSERT INTO garden_entries(id, persona_id, kind, title, body, entry_date, favorite, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?)",
               (gid, d.get("persona_id") or b.primary, d.get("kind") or "diary", clip(str(d.get("title") or ""), 60), str(d.get("body") or ""), d.get("entry_date") or iso()[:10], iso(), iso()))
        return {"ok": True, "id": gid, "item": _row("garden_entries", gid)}

    @app.post("/api/view/conversations")
    async def conv_add(req: Request):
        from .util import new_id
        d = await body(req)
        cid = new_id("cv_")
        full = str(d.get("full_text") or "")
        b.db.x("INSERT INTO conversations(id, persona_id, title, summary, full_text, entry_date, favorite, source_platform, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?,?)",
               (cid, d.get("persona_id") or b.primary, clip(str(d.get("title") or full[:20] or "对话"), 60), clip(str(d.get("summary") or full), 300), full,
                d.get("entry_date") or iso()[:10], d.get("source_platform") or "garden", iso(), iso()))
        return {"ok": True, "id": cid, "item": _row("conversations", cid)}

    # ==================== 话簿账本 ====================
    @app.get("/api/ledger/status")
    def ledger_status(req: Request):
        from . import ledger as L
        return {"ok": True, **L.stats(b)}

    @app.get("/api/ledger/books")
    def ledger_books(req: Request):
        from . import ledger as L
        return {"ok": True, "items": L.books(b)}

    @app.post("/api/ledger/books")
    async def ledger_book_add(req: Request):
        from . import ledger as L
        d = await body(req)
        try:
            return L.add_book(b, d.get("name"), d.get("color"), d.get("note"), d.get("actor") or "her")
        except ValueError as e:
            err(400, "bad_book", str(e))

    @app.post("/api/ledger/books/rename")
    async def ledger_book_rename(req: Request):
        from . import ledger as L
        d = await body(req)
        return L.rename_book(b, d.get("old"), d.get("new"), d.get("actor") or "her")

    @app.delete("/api/ledger/books/{name}")
    def ledger_book_del(name: str, req: Request):
        from . import ledger as L
        return L.delete_book(b, name)

    @app.get("/api/ledger/utterances")
    def ledger_utterances(req: Request):
        from . import ledger as L
        return {"ok": True, "items": L.recent_utterances(b, chat=qp(req, "chat"), limit=qint(req, "limit", 30))}

    @app.get("/api/ledger/entries")
    def ledger_entries(req: Request):
        from . import ledger as L
        return {"ok": True, "items": L.list_entries(
            b, chat=qp(req, "chat"), book=qp(req, "book"), subject=qp(req, "subject"),
            state=qp(req, "state"), q=qp(req, "q", ""), limit=qint(req, "limit", 100),
            offset=qint(req, "offset", 0))}

    @app.post("/api/ledger/entries")
    async def ledger_entry_add(req: Request):
        from . import ledger as L
        d = await body(req)
        try:
            return L.add_entry(b, d.get("utterance_id"), subject=d.get("subject"),
                               books=d.get("books"), tags=d.get("tags"), why_kept=d.get("why_kept") or "",
                               note=d.get("note") or "", importance=d.get("importance") or 3,
                               emotion=d.get("emotion") if d.get("emotion") is not None else 0.3,
                               assigned_by=d.get("assigned_by") or "user", auto=d.get("auto") is not False,
                               chat=d.get("chat"))
        except ValueError as e:
            err(400, "bad_entry", str(e))

    @app.put("/api/ledger/entries/{eid}")
    async def ledger_entry_set(eid: str, req: Request):
        from . import ledger as L
        d = await body(req)
        try:
            return L.set_entry(b, eid, d, d.get("actor") or "user")
        except ValueError as e:
            err(404, "not_found", str(e))

    @app.post("/api/ledger/entries/{eid}/correct")
    async def ledger_entry_correct(eid: str, req: Request):
        from . import ledger as L
        d = await body(req)
        try:
            return L.correct(b, eid, d.get("note") or "", d.get("actor") or "user")
        except ValueError as e:
            err(404, "not_found", str(e))

    @app.delete("/api/ledger/entries/{eid}")
    def ledger_entry_del(eid: str, req: Request):
        from . import ledger as L
        try:
            return L.erase(b, eid)
        except ValueError as e:
            err(404, "not_found", str(e))

    @app.get("/api/ledger/search")
    def ledger_search(req: Request):
        from . import ledger as L
        return {"ok": True, "items": L.search(b, qp(req, "q", ""), chat=qp(req, "chat"),
                                              limit=qint(req, "limit", 6), book=qp(req, "book"),
                                              subject=qp(req, "subject"))}

    @app.get("/api/ledger/echo")
    def ledger_echo(req: Request):
        from . import ledger as L
        return L.echo(b, write_file=False)

    @app.post("/api/ledger/echo")
    async def ledger_echo_write(req: Request):
        from . import ledger as L
        return L.echo(b, write_file=True)

    @app.post("/api/ledger/export")
    async def ledger_export(req: Request):
        from . import ledger as L
        d = await body(req)
        return L.export(b, book=d.get("book"), subject=d.get("subject"))

    @app.post("/api/ledger/refresh")
    def ledger_refresh(req: Request):
        from . import ledger as L
        return L.refresh_heat(b)

    @app.post("/api/ledger/awareness")
    async def ledger_awareness(req: Request):
        from . import ledger as L
        d = await body(req)
        return L.awareness(b, d.get("persona") or b.primary)

    @app.post("/api/view/{coll}")
    async def view_post(coll: str, req: Request):
        d = await body(req)
        if coll == "desires":
            try:
                return {"ok": True, **DES.save(b, d.get("persona_id") or b.primary, d)}
            except DES.DesireError as e:
                err(400, "bad_desire", str(e))
        if coll == "handoffs":
            return await handoff_add(req)
        if coll in ("voice", "images"):
            err(400, "unsupported", "v2 暂不支持上传语音/图片")
        err(404, "not_found", "不支持的接口")

    @app.post("/api/view/desires/{did}/replies")
    async def view_desire_reply(did: str, req: Request):
        return await desire_reply(did, req)

    VIEW_TABLE = {"handoffs": "handoffs", "notes": "notes", "unresolved": "unresolved", "conversations": "conversations",
                  "garden-entries": "garden_entries", "heart-traces": "heart_traces", "desires": "desire_logs", "deck": "deck_items",
                  "voice": "voice_clips", "images": "garden_images", "dreams": "dreams"}
    PATCHABLE = {"handoffs": ("summary", "mood", "next_time"), "notes": ("content", "reply"), "unresolved": ("content", "status", "resolution"),
                 "conversations": ("title", "summary", "full_text", "entry_date"), "garden-entries": ("title", "body", "kind", "entry_date"),
                 "heart-traces": ("title", "content")}

    @app.patch("/api/view/{coll}/{rid}")
    async def view_patch(coll: str, rid: str, req: Request):
        d = await body(req)
        if coll == "memories":
            return _quick(rid, d)
        if coll not in PATCHABLE:
            err(400, "unsupported", "这类条目不能编辑")
        sets = [(k, d[k]) for k in PATCHABLE[coll] if k in d]
        if sets:
            cols = ", ".join(f"{k}=?" for k, _ in sets)
            has_upd = coll not in ("handoffs",)
            b.db.x(f"UPDATE {VIEW_TABLE[coll]} SET {cols}{', updated_at=?' if has_upd and coll != 'notes' else ''} WHERE id=?",
                   [v for _, v in sets] + ([iso()] if has_upd and coll != "notes" else []) + [rid])
        return {"ok": True, "item": _row(VIEW_TABLE[coll], rid)}

    @app.delete("/api/view/{coll}/{rid}")
    def view_delete(coll: str, rid: str):
        if coll == "memories":
            return m_delete(rid)
        if coll == "desires":
            return {"ok": DES.forget(b, rid)}
        if coll not in VIEW_TABLE:
            err(404, "not_found", "不支持的接口")
        n = b.db.x(f"DELETE FROM {VIEW_TABLE[coll]} WHERE id=?", (rid,)).rowcount
        return {"ok": True, "deleted": n}

    @app.get("/api/view/{name}")
    def view_list(name: str, req: Request):
        return V.view_list(b, name, chat_of(qp(req, "chat")), qp(req, "persona"))

    @app.get("/api/view/deck/topics")
    @app.get("/api/deck/topics")
    def deck_topics():
        return V.deck_topics(b)

    @app.post("/api/deck/items")
    async def deck_add(req: Request):
        return V.deck_add(b, await body(req))

    @app.api_route("/api/deck/draw", methods=["GET", "POST"])
    async def deck_draw(req: Request):
        d = await body(req) if req.method == "POST" else {}
        return V.deck_draw(b, d.get("topic") or d.get("topic_id") or qp(req, "topic"), d.get("persona") or qp(req, "persona"), chat_of(d.get("chat") or qp(req, "chat")))

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def api_404(rest: str):
        err(404, "not_found", "没有这个接口：/api/" + rest)

    # —— 静态 web/ ——
    web = Path(b.cfg.get("web_dir") or (ROOT / "web"))
    if not web.is_absolute():
        web = ROOT / web
    if web.exists():
        app.mount("/", StaticFiles(directory=str(web), html=True), name="web")
    else:
        @app.get("/")
        def no_web():
            return {"ok": True, "message": "web/ 目录不存在：只提供 API。"}
    return app
