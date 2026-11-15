"""配置：config.json（可选）+ 环境变量覆盖。所有路径都可以改。"""
from __future__ import annotations
import copy, json, os, threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULTS: dict = {
    "host": "127.0.0.1",
    "port": 8780,
    "data_dir": "data",
    "db_path": "",                    # 空 = data_dir/brain.db
    "backup_dir": "",                 # 空 = data_dir/backups
    "backup_keep": 12,
    "privacy_path": "",               # 空 = data_dir/privacy.json
    "spill_dir": "",                  # 空 = data_dir/spill；可写 context 目录（相对 data_dir）
    "spill_rotate_chars": 40000,
    "log_path": "",
    "admin_key": "change-me",
    "atlas_key": "",                  # 空 = 用 admin_key
    "local_no_auth": True,            # 127.0.0.1 调兼容接口（/activate 等）不要求密钥
    "user_name": "他",           # 主人（用户）的称呼，男性；提示词里的 {{USER_NAME}} 也用它
    "adult_reveal": False,           # 18+ 记忆/日志在工作台、星图、统计、导出里默认隐藏；主人手动改 true 且请求带 include_adult=1 才显示
    "adult_chats": [],                # 18+（身体/欲望）注入允许的会话；空 = 只在 owner_chat（没配 owner_chat 则只在私聊）
    "owner_chat": "",                 # 主人（他）的私聊 id，如 p:10001；自主唤醒/主动消息默认发这里
    "body": {"wake_chat": ""},        # 空 = owner_chat
    "tz_offset_minutes": 480,
    "primary_persona": "dafeiyu",
    "personas": {"dafeiyu": "大肥鱼"},
    "emotion_enabled": True, "emotion_personas": ["dafeiyu"],
    "body_enabled": False, "body_personas": ["dafeiyu"],  # 18+ 身体模块：开源默认关闭
    "desire_enabled": False, "desire_personas": ["dafeiyu"],  # 18+ 欲望日志：开源默认关闭
    "dream_enabled": True, "dream_persona": "dafeiyu",
    "cognition_personas": ["dafeiyu"],
    "peer_friends": [],
    "pin_by_importance5": False,
    "llm": {"base_url": "", "api_key": "", "model": "", "timeout": 30, "classifier_model": ""},
    "vectors": {"enabled": False, "model": "BAAI/bge-small-zh-v1.5"},
    # 上下文预算（字）：只控「塞进上下文的记忆块」多大，不限制她回复。原 900/150/300/460/4 太紧：召回常被截成半句
    "budget": {"total": 2400, "about": 400, "handoff": 800, "recall": 1200, "recall_k": 6, "spontaneous": 160},
    "recall": {"min_hits": 2, "min_bm25": 4.0, "max": 6, "spread_decay": 0.42, "spontaneous_chance": 0.25,
               "importance_weight": 0.2, "recency_weight": 0.2},
    "prefetch": {"cache_seconds": 120, "wait_ms": 200},
    "consolidate_minutes": 30,
    "reflect_every": 8,
    "scheduler_enabled": True,
    "importance_gain": 0.05, "importance_cap": 0.85,
    # 话簿账本：数据默认落在仓库根目录下的 ledger-data/；
    # 可用环境变量 DAFEIYU_LEDGER_DIR 指到任意本地目录，绝不写死绝对路径。
    "ledger": {
        "enabled": True,
        "dir": "ledger-data",
        "trigger": True,               # 只在回忆词/点名/显式指令时按需召回，平时零查询
        "max_entries": 6,              # 单次最多递几条给模型
        "max_chars": 600,              # 单次最多多少字（在既有 budget 内再收一道）
        "clip_chars": 110,             # 单条掐到多少字
        "cache_seconds": 120,
        "echo_per_day": 3,
        "default_books": ["惦记", "当日琐碎"],
        "auto_assign": "local",        # local=纯本地规则（零出网、零 token） / off=不自动建议，全由她分
        "know_self": True,             # 让她知道自己有这本账
    },
}

_lock = threading.RLock()


def plugin_data_dir() -> Path:
    """大肥鱼插件的数据目录（和插件 src/core/store.js 的 dataDir() 一致）。

    优先级：环境变量 DAFEIYU_DIR / AURABOT_DIR / AURABOT_DATA_DIR → <DSH_HOME 或 ~/.dsh>/plugins-data/dafeiyu
    """
    for k in ("DAFEIYU_DIR", "AURABOT_DIR", "AURABOT_DATA_DIR"):
        v = os.environ.get(k)
        if v:
            return Path(v)
    home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
    return Path(home) / "plugins-data" / "dafeiyu"


def _deep_merge(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in (b or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


class Config:
    def __init__(self, path: str | os.PathLike | None = None, overrides: dict | None = None):
        self.path = Path(path or os.environ.get("BRAIN_CONFIG") or (ROOT / "config.json"))
        self.overrides = overrides or {}
        self.reload()

    def reload(self):
        with _lock:
            data = copy.deepcopy(DEFAULTS)
            if self.path.exists():
                try:
                    data = _deep_merge(data, json.loads(self.path.read_text(encoding="utf-8-sig")))
                except Exception as e:  # 配置坏了不让服务起不来
                    print(f"[config] 读取 {self.path} 失败：{e}，使用默认值")
            env = os.environ
            for k in ("admin_key", "user_name", "primary_persona", "host", "db_path", "data_dir", "spill_dir", "privacy_path"):
                ev = env.get("BRAIN_" + k.upper())
                if ev:
                    data[k] = ev
            if env.get("BRAIN_PORT"):
                data["port"] = int(env["BRAIN_PORT"])
            for k in ("EMOTION", "BODY", "DREAM", "DESIRE"):
                ev = env.get(f"{k}_ENABLED")
                if ev is not None:
                    data[f"{k.lower()}_enabled"] = ev.strip().lower() not in ("0", "false", "no", "off", "")
            if env.get("LLM_BASE_URL"):
                data["llm"]["base_url"] = env["LLM_BASE_URL"]
            if env.get("LLM_API_KEY"):
                data["llm"]["api_key"] = env["LLM_API_KEY"]
            if env.get("LLM_MODEL"):
                data["llm"]["model"] = env["LLM_MODEL"]
            if env.get("DAFEIYU_LEDGER_DIR"):
                data["ledger"]["dir"] = env["DAFEIYU_LEDGER_DIR"]
            data = _deep_merge(data, self.overrides)
            self.data = data

    def __getattr__(self, k):
        d = self.__dict__.get("data")
        if d is not None and k in d:
            return d[k]
        raise AttributeError(k)

    def get(self, k, default=None):
        return self.data.get(k, default)

    # ---- 路径 ----
    def _p(self, v: str, default: Path) -> Path:
        p = Path(v) if v else default
        return p if p.is_absolute() else (ROOT / p)

    @property
    def data_path(self) -> Path:
        p = self._p(self.data["data_dir"], ROOT / "data"); p.mkdir(parents=True, exist_ok=True); return p

    @property
    def db_file(self) -> Path:
        return self._p(self.data["db_path"], self.data_path / "brain.db")

    @property
    def backup_path(self) -> Path:
        p = self._p(self.data["backup_dir"], self.data_path / "backups"); p.mkdir(parents=True, exist_ok=True); return p

    @property
    def privacy_file(self) -> Path:
        return self._p(self.data["privacy_path"], self.data_path / "privacy.json")

    @property
    def spill_path(self) -> Path:
        p = self._p(self.data["spill_dir"], self.data_path / "spill"); p.mkdir(parents=True, exist_ok=True); return p

    @property
    def log_file(self) -> Path:
        return self._p(self.data["log_path"], self.data_path / "brain.log")

    @property
    def ledger_path(self) -> Path:
        """话簿的本地家：默认 <仓库>/ledger-data/（相对仓库根，不是 brain/），
        与 .gitignore 的 ledger-data/ 对齐。可用 DAFEIYU_LEDGER_DIR 指到任意本地目录。"""
        v = (self.data.get("ledger") or {}).get("dir") or "ledger-data"
        p = Path(v)
        p = p if p.is_absolute() else (ROOT.parent / p)
        p = p.resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    def persona_name(self, pid: str) -> str:
        return (self.data.get("personas") or {}).get(pid, pid)

    def editable(self) -> dict:
        return json.loads(json.dumps(self.data))

    def save(self, new: dict):
        from .util import atomic_write_text
        merged = _deep_merge(self.data, new)
        merged.pop("_comment", None)
        atomic_write_text(self.path, json.dumps(merged, ensure_ascii=False, indent=2))
        self.reload()
