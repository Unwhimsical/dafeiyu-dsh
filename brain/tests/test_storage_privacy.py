"""日常存储的 18+ / 隔离边界：turns 表、spill 明文流水、话簿底账三处用同一个判断（ledger.skip_reason）。
- 18+（调用方传 adult、该私聊在 18+ 窗口里、内容命中成人词）和隔离号的话三处都不写；
- 18+ 窗口里新记的记忆自动打 nsfw 隐藏标签；
- purge_turns_spill / purge_sensitive 能把升级前存进去的清掉，只返回条数。"""
import json

from brain import context as CTX, ledger as L, maintenance, memory as M, spill as S


def _turns(brain, chat=None):
    if chat:
        return brain.db.one("SELECT COUNT(*) c FROM turns WHERE chat_id=?", (chat,))["c"]
    return brain.db.one("SELECT COUNT(*) c FROM turns")["c"]


def _spill_lines(brain):
    n = 0
    for f in brain.cfg.spill_path.glob("spill-*.jsonl") if brain.cfg.spill_path.exists() else []:
        n += sum(1 for ln in f.read_text(encoding="utf-8").splitlines() if ln.strip())
    return n


def test_normal_turn_goes_everywhere(brain):
    CTX.record_turn(brain, "p:10000", brain.primary, "user", "10000", "今天下雨了")
    assert _turns(brain) == 1 and _spill_lines(brain) == 1


def test_adult_turns_skip_turns_and_spill(brain):
    CTX.record_turn(brain, "p:10000", brain.primary, "user", "10000", "普通的一句", adult=True)
    CTX.record_turn(brain, "p:10000", brain.primary, "user", "10000", "这是一段 nsfw 测试样例")
    assert _turns(brain) == 0 and _spill_lines(brain) == 0
    # 计数器（只有时间）照常更新
    assert brain.db.one("SELECT chat_id FROM chat_counters WHERE chat_id='p:10000'") is not None


def test_adult_window_covers_reply_without_flag(brain):
    CTX.build(brain, {"chat_id": "p:10000", "user_id": "10000", "message": "你好呀", "adult": True})
    # 回复那一步调用方没带 adult：靠 /activate 记下的 18+ 窗口判断
    maintenance.after_reply(brain, {"chat_id": "p:10000", "reply": "你好", "sent": True})
    assert _turns(brain, "p:10000") == 0 and _spill_lines(brain) == 0
    # 窗口关了（下一轮 adult=false）就恢复正常
    CTX.build(brain, {"chat_id": "p:10000", "user_id": "10000", "message": "早上好", "adult": False})
    assert _turns(brain, "p:10000") == 1


def test_isolated_skip_turns_and_spill(brain, monkeypatch):
    monkeypatch.setattr(brain.privacy, "isolated_ids", lambda: {"30003"})
    CTX.record_turn(brain, "p:30003", brain.primary, "user", "30003", "隔离号的私聊")
    CTX.record_turn(brain, "g:20001", brain.primary, "user", "30003", "隔离号在群里")
    CTX.record_turn(brain, "p:10000", brain.primary, "user", "10000", "插件标了隔离", isolated=True)
    assert _turns(brain) == 0 and _spill_lines(brain) == 0
    CTX.record_turn(brain, "g:20001", brain.primary, "user", "40004", "群里别人的话")
    assert _turns(brain, "g:20001") == 1


def test_private_policy_chat_still_in_turns(brain):
    # privacy.json 里 private 的私聊（家人）不是隔离号：turns / spill 照常写，只是不进话簿
    CTX.record_turn(brain, "p:10001", brain.primary, "user", "10001", "家人的一句")
    assert _turns(brain, "p:10001") == 1
    assert brain.db.one("SELECT COUNT(*) c FROM ledger_utterances WHERE chat_id='p:10001'")["c"] == 0


def test_skip_reason_fails_closed(brain, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("x")
    monkeypatch.setattr(L, "adult_active", boom)
    assert L.skip_reason(brain, "p:10000", "10000", "普通") == "error"
    CTX.record_turn(brain, "p:10000", brain.primary, "user", "10000", "判断出错就不写")
    assert _turns(brain) == 0 and _spill_lines(brain) == 0


def test_memory_in_adult_window_is_hidden(brain):
    CTX.build(brain, {"chat_id": "p:10000", "user_id": "10000", "message": "你好", "adult": True})
    r = M.remember(brain, content="窗口里随口说的一件小事", chat="p:10000", speaker="10000", source="aurabot")
    row = brain.db.one("SELECT tags FROM memories WHERE id=?", (r["id"],))
    assert "nsfw" in (row["tags"] or "")
    r2 = M.remember(brain, content="别的会话里的一件小事", chat="g:20001", speaker="40004", source="aurabot")
    assert "nsfw" not in (brain.db.one("SELECT tags FROM memories WHERE id=?", (r2["id"],))["tags"] or "")


def test_purge_old_rows_counts_only(brain, monkeypatch):
    # 模拟升级前：直接写进 turns 和 spill
    t = "2026-01-01T00:00:00Z"
    for chat, uid, text in [("p:10000", "10000", "普通的话"), ("p:10000", "10000", "nsfw 样例"),
                            ("p:30003", "30003", "隔离号的话"), ("g:20001", "40004", "群里的话")]:
        brain.db.x("INSERT INTO turns(chat_id, persona, role, user_id, text, created_at) VALUES (?,?,?,?,?,?)",
                   (chat, brain.primary, "user", uid, text, t))
        S.append(brain, chat, "user", text, uid, brain.primary)
    S.index(brain)
    monkeypatch.setattr(brain.privacy, "isolated_ids", lambda: {"30003"})
    dry = L.purge_turns_spill(brain, dry_run=True)
    assert (dry["turns_adult"], dry["turns_isolated"], dry["spill_adult"], dry["spill_isolated"]) == (1, 1, 1, 1)
    assert _turns(brain) == 4
    r = L.purge_turns_spill(brain)
    assert _turns(brain) == 2 and _spill_lines(brain) == 2
    assert brain.db.one("SELECT COUNT(*) c FROM spill_index")["c"] == 2
    # 返回值里只有数字和布尔，没有内容
    assert all(isinstance(v, (int, bool)) for v in r.values())
    assert "样例" not in json.dumps(r, ensure_ascii=False)
