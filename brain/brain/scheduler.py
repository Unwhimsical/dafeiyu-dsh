"""后台定时任务：一个线程，每 20 秒看一眼哪些任务到点了。所有任务也能在工作台 /api/run/<job> 手动触发。"""
from __future__ import annotations
import threading, time, traceback
from .util import now_ms, iso

# name: (每隔多少分钟, 说明)
JOBS = {
    "consolidate": (30, "巩固：常用记忆加分量（上限0.85）/重算状态/补联想/归档老痕迹/溢出索引/向量/认知"),
    "backup": (30, "备份数据库（保留最近 12 份）"),
    "emotion": (10, "情绪自然回落 + 激素衰减"),
    "body": (5, "【18+】身体状态推进 + 自主唤醒 + 欲望记忆同步"),
    "dream": (10, "【18+可关】梦境整理（每天 04:30-06:00 窗口内一次）"),
    "settle": (30, "自主时间之后的沉淀"),
    "review": (1440, "回顾以前的记忆（每天一次）"),
    "cognition": (60, "认知候选聚类"),
    "reminisce": (45, "自发回忆：线索勾出旧记忆，静默入库，不主动发消息"),
    "spill_index": (5, "溢出 jsonl 增量索引"),
    "verify": (1440, "数据库自检（integrity / FTS 同步）"),
    "reflect": (0, "反思（每 8 条回复自动；手动可指定 chat）"),
    "links": (0, "重建联想链接（手动）"),
    "growth": (1440, "星海生长：性格轻微漂移 + 兴趣更新（每天一次，自动快照可回滚）"),
    "ledger": (1440, "话簿：重算冷热 + 生成每日回顾（纯本地，不调模型、不发消息）"),
}


def run_job(b, name: str, body: dict | None = None) -> dict:
    body = body or {}
    t0 = time.time()
    persona = body.get("persona") or None
    from . import maintenance, emotion, dream, continuity, cognition, spill, memory as M
    if name == "consolidate":
        res = maintenance.consolidate(b)
    elif name == "ledger":
        from . import ledger as L
        res = {"heat": L.refresh_heat(b), "echo": L.echo(b, write_file=False)}
    elif name == "backup":
        res = {"ok": True, "file": str(b.db.backup(b.cfg.backup_path, int(b.cfg.get("backup_keep") or 12), body.get("tag") or "manual"))}
    elif name == "verify":
        res = b.db.verify()
    elif name == "emotion":
        res = emotion.cron(b)
    elif name == "body":
        from . import body as BODY
        res = {}
        for p in (b.cfg.get("body_personas") or [b.primary]):
            if not b.module_on("body", p):
                res[p] = "disabled"; continue
            res[p] = BODY.cron(b, p, force=bool(body.get("force")))
            try:
                BODY.sync_desire_memories(b, p)
            except Exception as e:
                b.log.warning("sync_desire_memories: %s", e)
        res = {"ok": True, "personas": res}
    elif name == "dream":
        p = persona or b.cfg.get("dream_persona") or b.primary
        if not body.get("force") and not body.get("manual") and not dream.in_dream_window(b, now_ms()):
            res = {"ok": True, "skipped": "not_in_window"}
        else:
            res = dream.run(b, p, force=bool(body.get("force")), dry_run=bool(body.get("dry_run")))
    elif name == "settle":
        res = continuity.settle(b, persona)
    elif name == "review":
        res = continuity.review(b, persona, int(body.get("n") or 3))
    elif name == "cognition":
        res = cognition.cron(b)
    elif name == "spill_index":
        res = spill.index(b, full=bool(body.get("full")))
    elif name == "reflect":
        chat = body.get("chat") or body.get("chat_id") or (b.cfg.get("owner_chat") or "")
        if not chat:
            r = b.db.one("SELECT chat_id FROM turns ORDER BY created_at DESC LIMIT 1")
            chat = r["chat_id"] if r else ""
        res = maintenance.reflect(b, chat, persona or b.primary) if chat else {"ok": False, "error": "no chat"}
    elif name == "growth":
        from . import growth
        res = growth.grow(b, persona, force=bool(body.get("force")))
    elif name == "reminisce":
        from . import reminisce
        res = reminisce.run(b, persona, force=bool(body.get("force")), dry_run=bool(body.get("dry_run")))
    elif name == "links":
        n = 0
        for r in b.db.q("SELECT id FROM memories WHERE status='active' ORDER BY created_at DESC LIMIT ?", (int(body.get("limit") or 300),)):
            M.link_one(b, r["id"]); n += 1
        res = {"ok": True, "relinked": n, "links": b.db.one("SELECT COUNT(*) c FROM memory_links")["c"]}
    else:
        return {"ok": False, "job": name, "error": "unknown job", "jobs": list(JOBS)}
    took = int((time.time() - t0) * 1000)
    b.job_done(name, res, took)
    return {"ok": True, "job": name, "result": res, "took_ms": took}


def jobs_view(b) -> list[dict]:
    out = []
    for name, (every, desc) in JOBS.items():
        j = b.jobs.get(name) or {}
        out.append({"name": name, "every_min": every, "desc": desc, "last_run": j.get("last_run") or j.get("at"),
                    "last_result": j.get("last_result") if "last_result" in j else j.get("result"), "took_ms": j.get("took_ms")})
    return out


class Scheduler:
    def __init__(self, b):
        self.b = b
        self.stop_ev = threading.Event()
        self.last: dict[str, float] = {}
        self.t = None

    def start(self):
        b = self.b
        try:
            b.db.backup(b.cfg.backup_path, int(b.cfg.get("backup_keep") or 12), "startup")
            b.log.info("启动备份完成")
        except Exception as e:
            b.log.error("启动备份失败：%s", e)
        now = time.time()
        saved = self._load()
        for n in JOBS:  # 启动后先错开一会儿再跑；上次真实跑过的时间从库里读回来，重启不再重置
            t = saved.get(n)
            self.last[n] = t if isinstance(t, (int, float)) and t <= now else now - 60 * max(JOBS[n][0], 1) + 45
        if b.cfg.get("scheduler_enabled", True):
            self.t = threading.Thread(target=self.loop, name="brain-scheduler", daemon=True)
            self.t.start()

    def loop(self):
        while not self.stop_ev.wait(20):
            for name, (every, _) in JOBS.items():
                if every <= 0:
                    continue
                if name == "consolidate":
                    every = int(self.b.cfg.get("consolidate_minutes") or 30)
                if time.time() - self.last.get(name, 0) < every * 60:
                    continue
                # 任务跑完（或明确失败）才记时间；失败也记，避免 20 秒一轮的重试风暴。
                try:
                    run_job(self.b, name, {"tag": "auto"} if name == "backup" else {})
                except Exception as e:
                    self.b.log.error("定时任务 %s 失败：%s\n%s", name, e, traceback.format_exc()[-800:])
                finally:
                    self.last[name] = time.time()
                    self._save()
                if self.stop_ev.is_set():
                    break

    def _load(self) -> dict:
        try:
            import json
            r = self.b.db.one("SELECT v FROM meta WHERE k='scheduler_last'")
            return json.loads(r["v"]) if r and r["v"] else {}
        except Exception:
            return {}

    def _save(self):
        try:
            import json
            self.b.db.x("INSERT OR REPLACE INTO meta(k, v) VALUES('scheduler_last', ?)", (json.dumps({k: round(v, 1) for k, v in self.last.items()}),))
        except Exception as e:
            self.b.log.debug("scheduler_last 保存失败：%s", e)

    def stop(self):
        self.stop_ev.set()
        b = self.b
        try:
            b.db.backup(b.cfg.backup_path, int(b.cfg.get("backup_keep") or 12), "exit")
            b.log.info("退出备份完成")
        except Exception as e:
            b.log.error("退出备份失败：%s", e)
