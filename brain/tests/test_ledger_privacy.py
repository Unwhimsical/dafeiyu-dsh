"""话簿底账的隐私边界：18+ 轮次、隔离号 / 隔离会话不进底账；不写明文 jsonl；彻底删除真删行。"""
from brain import context as CTX, ledger as L


def _count(brain, chat=None):
    if chat:
        return brain.db.one("SELECT COUNT(*) c FROM ledger_utterances WHERE chat_id=?", (chat,))["c"]
    return brain.db.one("SELECT COUNT(*) c FROM ledger_utterances")["c"]


def _no_jsonl(brain, tmp_path):
    assert not list(tmp_path.rglob("*.jsonl")) or all("spill" in str(p) for p in tmp_path.rglob("*.jsonl"))
    assert not list(brain.cfg.ledger_path.rglob("*.jsonl")) if brain.cfg.ledger_path.exists() else True


def test_normal_turn_recorded_without_jsonl(brain, tmp_path):
    CTX.record_turn(brain, "p:10000", brain.primary, "user", "10000", "今天下雨了")
    assert _count(brain, "p:10000") == 1
    _no_jsonl(brain, tmp_path)


def test_adult_turns_not_recorded(brain, tmp_path):
    CTX.record_turn(brain, "p:10000", brain.primary, "user", "10000", "普通的一句话", adult=True)
    CTX.record_turn(brain, "p:10000", brain.primary, "assistant", "", "回一句", adult=True)
    # 调用方没传 adult，但内容带 18+ 标记词，也不记
    CTX.record_turn(brain, "p:10000", brain.primary, "user", "10000", "这是一段 nsfw 测试样例")
    assert _count(brain) == 0
    # 走 HTTP 链路：activate / after_reply 带 adult=true
    CTX.build(brain, {"chat_id": "p:10000", "user_id": "10000", "message": "你好呀", "adult": True})
    from brain import maintenance
    maintenance.after_reply(brain, {"chat_id": "p:10000", "reply": "你好", "adult": True, "sent": True})
    assert _count(brain) == 0
    _no_jsonl(brain, tmp_path)


def test_isolated_people_and_chats_not_recorded(brain, tmp_path, monkeypatch):
    monkeypatch.setattr(brain.privacy, "isolated_ids", lambda: {"30003"})
    CTX.record_turn(brain, "p:30003", brain.primary, "user", "30003", "隔离号的私聊")
    CTX.record_turn(brain, "p:30003", brain.primary, "assistant", "", "回隔离号")
    CTX.record_turn(brain, "g:20001", brain.primary, "user", "30003", "隔离号在群里说的话")
    # privacy.json 里标成 private（完全隔离）的私聊
    CTX.record_turn(brain, "p:10001", brain.primary, "user", "10001", "完全隔离的私聊")
    # 调用方显式标了 isolated
    CTX.record_turn(brain, "p:10000", brain.primary, "user", "10000", "插件标了隔离", isolated=True)
    from brain import maintenance
    maintenance.after_reply(brain, {"chat_id": "p:10000", "reply": "隔离会话的回复", "isolated": True, "sent": True})
    assert _count(brain) == 0
    # 同一个群里别人说的话照常记
    CTX.record_turn(brain, "g:20001", brain.primary, "user", "40004", "群里普通的一句")
    assert _count(brain, "g:20001") == 1
    _no_jsonl(brain, tmp_path)


def test_erase_deletes_rows(brain, tmp_path):
    lid = L.append_utterance(brain, "p:10000", brain.primary, "user", "10000", "要删掉的一句")
    e = L.add_entry(brain, lid, why_kept="测试")
    L.erase(brain, e["id"])
    assert brain.db.one("SELECT id FROM ledger_utterances WHERE id=?", (lid,)) is None
    assert brain.db.one("SELECT id FROM ledger_entries WHERE id=?", (e["id"],)) is None
    assert not any("要删掉" in (r["detail"] or "") for r in brain.db.q("SELECT detail FROM ledger_audit"))
    _no_jsonl(brain, tmp_path)
