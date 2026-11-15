import json
from brain import memory as M, context as CTX

SECRET = "我下周去医院复查"


def _act(b, chat, uid, msg="医院复查的事"):
    return CTX.build(b, {"chat_id": chat, "user_id": uid, "message": msg}, preview=True)["block"]


def test_acceptance_private_secret(brain):
    r = M.remember(brain, content=SECRET, chat="p:10001", speaker="10001", importance=4, tags=["医院", "复查"])
    assert r["ok"]
    assert SECRET in _act(brain, "p:10001", "10001")          # 老爹自己的私聊能想起
    assert SECRET not in _act(brain, "g:20001", "10001")      # 家庭群里不出现
    assert SECRET not in _act(brain, "p:10002", "10002")      # 老妈私聊不出现
    s = M.search(brain, "医院复查", chat="g:20001")
    assert all(SECRET not in x["content"] for x in s["results"])


def test_hot_switch_to_public(brain):
    M.remember(brain, content=SECRET, chat="p:10001", speaker="10001", importance=4, tags=["医院", "复查"])
    assert SECRET not in _act(brain, "p:10002", "10002")
    p = brain.privacy.path
    d = json.loads(p.read_text(encoding="utf-8"))
    d["private_chats"]["10001"] = "public"
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")   # 不重启
    brain.privacy._mtime = 0
    assert SECRET in _act(brain, "p:10002", "10002")


def test_guard_blocks_leak(brain):
    M.remember(brain, content="老爸下周二去市一院心内科复查，别告诉老妈", chat="p:10001", speaker="10001", importance=4)
    g = brain.privacy.guard(brain.db, "p:10002", "你爸周二要去市一院心内科哦")
    assert g["blocked"]
    ok = brain.privacy.guard(brain.db, "p:10001", "周二去市一院心内科记得带病历")
    assert not ok["blocked"]


def test_unknown_origin_is_private(brain):
    M.remember(brain, content="旧库里来源不明的一句话", chat="legacy:unknown", scope="private")
    assert "来源不明" not in _act(brain, "p:10000", "10000", "来源不明的一句话")
    assert "来源不明" not in _act(brain, "g:20001", "10000", "来源不明的一句话")


def test_handoff_per_chat(brain):
    brain.cfg.data["handoff_in_context"] = True   # 大脑交接默认不注入（走插件 ctxplan），这里打开来测隔离
    from brain import continuity as C
    C.handoff_close(brain, None or brain.primary, "p:10001", "跟老爸聊到复查的事", "", "", "test")
    b1 = CTX.build(brain, {"chat_id": "p:10002", "user_id": "10002", "message": "在吗", "new_session": True}, preview=True)
    assert "复查" not in b1["block"]
    b2 = CTX.build(brain, {"chat_id": "p:10001", "user_id": "10001", "message": "在吗", "new_session": True}, preview=True)
    assert "复查" in b2["block"]
