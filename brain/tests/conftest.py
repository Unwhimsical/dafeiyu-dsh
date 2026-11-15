import json, os, sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 测试绝不读写本机真实的插件数据目录（~/.dsh/plugins-data/dafeiyu）
import tempfile as _tempfile
os.environ["DAFEIYU_DIR"] = _tempfile.mkdtemp(prefix="dafeiyu-test-plugin-")

PRIV = {"default_private": "private", "default_group": "public",
        "private_chats": {"10000": "scoped", "10001": "private", "10002": "private"},
        "groups": {"20001": {"can_see": ["10000"], "policy": "public"}},
        "guard": {"enabled": True, "allow_phrases": []}}


_ENV_KEYS = ("BRAIN_CONFIG", "BRAIN_DATA_DIR", "BRAIN_DB_PATH", "BRAIN_SPILL_DIR", "BRAIN_PRIVACY_PATH",
             "BRAIN_ADMIN_KEY", "DAFEIYU_LEDGER_DIR")


@pytest.fixture(autouse=True)
def _isolate_env():
    """有的测试（test_ledger）直接改 os.environ；每个测试后还原，免得数据目录串到别的测试里。"""
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


@pytest.fixture(autouse=True)
def _reset_adult_window():
    """18+ 窗口标记只在进程内存里；每个测试前后清空，免得上一个测试的 adult=true 串到下一个。"""
    from brain import ledger as _L
    _L._ADULT_CHATS.clear()
    yield
    _L._ADULT_CHATS.clear()


@pytest.fixture
def brain(tmp_path, monkeypatch):
    cfg = {"data_dir": str(tmp_path), "admin_key": "k", "scheduler_enabled": False, "owner_chat": "p:10000",
           "spill_dir": str(tmp_path / "spill"), "ledger": {"dir": str(tmp_path / "ledger")}, "llm": {"enabled": False}, "vectors": {"enabled": False},
           "body_enabled": True}   # 18+ 身体模块默认关闭；测试里显式打开来覆盖它的逻辑
    (tmp_path / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
    (tmp_path / "privacy.json").write_text(json.dumps(PRIV, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv("BRAIN_CONFIG", str(tmp_path / "config.json"))
    from brain.core import Brain
    b = Brain()
    yield b
    b.close()


@pytest.fixture
def client(brain):
    from fastapi.testclient import TestClient
    from brain.api import create_app
    with TestClient(create_app(brain, start_scheduler=False)) as c:
        yield c
