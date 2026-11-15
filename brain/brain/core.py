"""Brain：把 db / 配置 / 隐私 / LLM / 日志 / 脉冲 串在一起的中心对象。"""
from __future__ import annotations
import collections, logging, threading, time
from pathlib import Path
from .config import Config
from .db import DB
from .privacy import Privacy
from .thinking import ThinkFeed
from .llm import LLM
from .util import iso, now_ms, jdump


class RingHandler(logging.Handler):
    def __init__(self, n=2000):
        super().__init__()
        self.buf = collections.deque(maxlen=n)

    def emit(self, record):
        try:
            self.buf.append({"at": iso(record.created * 1000), "level": record.levelname, "name": record.name, "msg": record.getMessage()})
        except Exception:
            pass


class RedactFilter(logging.Filter):
    """写日志前脱敏：密钥值 / Bearer / 6 位以上数字串里的口令类 / 18+ 文本一律不落盘（18+ 加固）。"""
    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg

    def filter(self, record):
        try:
            import re as _re
            msg = record.getMessage()
            for k in ("admin_key", "atlas_key"):
                v = str(self.cfg.get(k) or "")
                if len(v) >= 4:
                    msg = msg.replace(v, "<" + k + ">")
            v = str((self.cfg.get("llm") or {}).get("api_key") or "")
            if len(v) >= 4:
                msg = msg.replace(v, "<llm.api_key>")
            msg = _re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{6,}", r"\1<redacted>", msg)
            msg = _re.sub(r"(?i)((?:暗号|口令|密码|token|key)\s*[:：=是为]\s*)\S+", r"\1<redacted>", msg)
            from .sensitivity import is_adult_text, HIDDEN
            if is_adult_text(msg):
                msg = _re.sub(r"[「“\"].*?[」”\"]", "「" + HIDDEN + "」", msg)
                if is_adult_text(msg):
                    msg = msg[:40].split("：")[0] + "：" + HIDDEN
            record.msg, record.args = msg, ()
        except Exception:
            pass
        return True


class Brain:
    def __init__(self, cfg: Config | None = None):
        self.cfg = cfg or Config()
        self.db = DB(self.cfg.db_file)
        self.privacy = Privacy(self.cfg.privacy_file)
        self.think = ThinkFeed(self.cfg.get("think_feed_size", 200) or 200)  # 星图「思考动画」用的召回事件（只在内存）
        self.llm = LLM(self.cfg)
        self.log = logging.getLogger("brain")
        self.ring = RingHandler()
        root = logging.getLogger("brain")
        if not any(isinstance(f, RedactFilter) for f in root.filters):
            root.addFilter(RedactFilter(self.cfg))
        else:
            for f in root.filters:
                if isinstance(f, RedactFilter):
                    f.cfg = self.cfg
        if not any(isinstance(h, RingHandler) for h in root.handlers):
            root.addHandler(self.ring)
            try:
                fh = logging.FileHandler(self.cfg.log_file, encoding="utf-8")
                fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
                root.addHandler(fh)
            except Exception:
                pass
            root.setLevel(logging.INFO)
        self.cache: dict[str, tuple[float, dict]] = {}
        self.cache_lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.ensure_personas()

    # —— 人格 ——
    @property
    def primary(self) -> str:
        return self.cfg.primary_persona

    def ensure_personas(self):
        now = iso()
        for pid, name in (self.cfg.get("personas") or {}).items():
            self.db.x("INSERT OR IGNORE INTO personas(id, display_name, relationship_to_user, self_card, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                      (pid, name, "", "", now, now))
        if not self.db.one("SELECT 1 FROM personas WHERE id=?", (self.primary,)):
            self.db.x("INSERT INTO personas(id, display_name, created_at, updated_at) VALUES (?,?,?,?)", (self.primary, self.primary, now, now))

    def persona(self, pid: str | None) -> dict:
        pid = pid or self.primary
        r = self.db.one("SELECT * FROM personas WHERE id=?", (pid,))
        return dict(r) if r else {"id": pid, "display_name": self.cfg.persona_name(pid), "self_card": "", "relationship_to_user": ""}

    def persona_name(self, pid: str) -> str:
        if pid == "family":
            return "全家共享"
        r = self.db.one("SELECT display_name FROM personas WHERE id=?", (pid,))
        return r[0] if r else self.cfg.persona_name(pid)

    def module_on(self, mod: str, pid: str | None) -> bool:
        pid = pid or self.primary
        if not self.cfg.get(f"{mod}_enabled", False):
            return False
        lst = self.cfg.get(f"{mod}_personas")
        if mod == "dream":
            return pid == (self.cfg.get("dream_persona") or self.primary)
        return not lst or pid in lst

    # —— 脉冲 ——
    def pulse(self, ids, kind: str, chat: str = "", scores=None):
        if not ids:
            return
        t = now_ms()
        rows = []
        for i, mid in enumerate(ids):
            sc = (scores[i] if scores and i < len(scores) else 1.0)
            rows.append((mid, chat, kind, float(sc or 0), iso(t), t))
        self.db.many("INSERT INTO pulses(memory_id, chat_id, kind, score, created_at, at_ms) VALUES (?,?,?,?,?,?)", rows)
        # 只留最近 5000 条
        if t % 50 == 0:
            self.db.x("DELETE FROM pulses WHERE id < (SELECT MAX(id) - 5000 FROM pulses)")

    def audit(self, mid: str, action: str, detail=""):
        self.db.x("INSERT INTO memory_audit(memory_id, action, detail, created_at) VALUES (?,?,?,?)",
                  (mid, action, detail if isinstance(detail, str) else jdump(detail), iso()))

    def job_done(self, name: str, result, took_ms: int):
        self.jobs[name] = {"name": name, "last_run": iso(), "last_result": result, "took_ms": took_ms}

    def close(self):
        self.db.close()
