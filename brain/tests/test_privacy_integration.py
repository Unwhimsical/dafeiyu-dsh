"""私聊隐私隔离接入：会话识别 + 家庭示例端到端（走 HTTP，模拟 memcore 的真实调用）。"""
import json
from pathlib import Path
import pytest
from brain.privacy import chat_from_payload

ROOT = Path(__file__).resolve().parent.parent
DAD, MOM, ME, BRO, GROUP = "10001", "10002", "10000", "10003", "20001"
SECRET = "老爸说：我下周去医院复查，别跟你妈说。"
MOM_SECRET = "老妈偷偷给老爸织了生日毛衣，要保密到生日那天。"
SHARED = "哥哥下个月结婚，婚礼定在杭州西湖边。"


@pytest.mark.parametrize("payload,expect", [
    ({"message_type": "private", "user_id": 10001}, "p:10001"),                     # OneBot 私聊
    ({"message_type": "group", "group_id": 20001, "user_id": 10001}, "g:20001"),    # OneBot 群（发言人是老爸也算群）
    ({"chat_type": "group", "chat_id": "20001", "user_id": "10001"}, "g:20001"),    # chat_type + 裸 chat_id
    ({"chat_type": "private", "chat_id": "10001"}, "p:10001"),
    ({"chat_id": "g:20001", "user_id": "10001"}, "g:20001"),                        # 带前缀优先
    ({"chat_id": "group_20001"}, "g:20001"),
    ({"chat_id": "private:10001"}, "p:10001"),
    ({"detail_type": "group", "group_id": "20001"}, "g:20001"),                     # OneBot v12
    ({"is_group": True, "chat_id": "20001"}, "g:20001"),
    ({"is_group": "true", "group_id": 20001}, "g:20001"),
    ({"message_type": "group", "user_id": 10001}, "g:unknown"),                     # 标了群却没群号：绝不退化成老爸私聊
    ({"user_id": 10001}, "p:10001"),
    ({"sender": {"user_id": 10001}}, "p:10001"),
    ({"platform": "douyin", "chat_type": "private", "open_id": "abc"}, "p:douyin_abc"),   # 抖音：加平台前缀防撞号
    ({"platform": "douyin", "chat_type": "group", "chat_id": "xyz"}, "g:douyin_xyz"),
    ({"platform": "napcat", "message_type": "private", "user_id": 10001}, "p:10001"),     # QQ 系适配器不加前缀
    ({}, "p:unknown"),
])
def test_chat_identification(payload, expect):
    assert chat_from_payload(payload) == expect


@pytest.fixture
def fam(client, brain):
    """装上 privacy.family.example.json，并用 memcore 风格的 /remember 写三条记忆。"""
    d = json.loads((ROOT / "privacy.family.example.json").read_text(encoding="utf-8"))
    r = client.put("/api/privacy", json={"privacy": d}, headers={"Authorization": "Bearer k"})
    assert r.status_code == 200 and r.json()["ok"]
    for msg_type, uid, content, tags in [("private", DAD, SECRET, ["医院", "复查"]), ("private", MOM, MOM_SECRET, ["毛衣", "生日"]),
                                         ("private", BRO, SHARED, ["结婚", "婚礼"])]:
        r = client.post("/remember", json={"message_type": msg_type, "user_id": int(uid), "content": content, "importance": 4, "tags": tags})
        assert r.json()["ok"], r.json()
    return client


def act(c, payload, msg):
    r = c.post("/activate", json={**payload, "message": msg}).json()
    assert r["ok"]
    return r["block"] + json.dumps(r["memories"], ensure_ascii=False)


def test_dad_secret_never_in_group_even_when_dad_speaks(fam):
    blk = act(fam, {"message_type": "group", "group_id": int(GROUP), "user_id": int(DAD)}, "老爸你医院复查怎么样了")
    assert "医院复查" not in blk
    assert "结婚" in act(fam, {"message_type": "group", "group_id": int(GROUP), "user_id": int(ME)}, "哥哥结婚婚礼在哪")   # 共享的照样能聊


def test_dad_secret_only_in_dad_chat(fam):
    assert "医院复查" in act(fam, {"message_type": "private", "user_id": int(DAD)}, "医院复查的事")
    for uid in (MOM, ME, BRO):
        assert "医院复查" not in act(fam, {"message_type": "private", "user_id": int(uid)}, "老爸医院复查的事")


def test_mom_secret_hidden_from_dad(fam):
    assert "毛衣" not in act(fam, {"message_type": "private", "user_id": int(DAD)}, "生日毛衣是谁织的")
    assert "毛衣" in act(fam, {"message_type": "private", "user_id": int(MOM)}, "生日毛衣织完了吗")


def test_shared_chat_visible_everywhere(fam):
    for p in ({"message_type": "private", "user_id": int(DAD)}, {"message_type": "private", "user_id": int(MOM)}):
        assert "结婚" in act(fam, p, "哥哥结婚婚礼在哪")


def test_every_read_path_is_filtered(fam):
    H = {"Authorization": "Bearer k"}
    fam.post("/after_reply", json={"message_type": "private", "user_id": int(DAD), "message": "医院复查那天你提醒我带病历",
                                   "reply": "好，复查那天提醒你带病历", "record_user": True})
    texts = [
        fam.post("/recall", json={"chat_id": f"g:{GROUP}", "query": "医院复查"}).text,
        fam.get("/api/search", params={"q": "医院复查", "chat": f"g:{GROUP}"}, headers=H).text,
        fam.get("/api/context/preview", params={"chat": f"g:{GROUP}", "message": "医院复查"}, headers=H).text,
        fam.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                               "params": {"name": "recall", "arguments": {"chat": f"g:{GROUP}", "query": "医院复查"}}}).text,
        fam.get("/api/spill/search", params={"q": "病历", "chat": f"g:{GROUP}"}, headers=H).text,
    ]
    for t in texts:   # 查询词会被回显，所以检查只有秘密原文里才有的片段
        assert "别跟你妈说" not in t and "病历" not in t, t[:300]


def test_outbound_guard_blocks_leak_in_group(fam):
    r = fam.post("/after_reply", json={"message_type": "group", "group_id": int(GROUP), "user_id": int(ME),
                                       "message": "老爸最近咋样", "reply": "老爸下周要去医院复查呢"}).json()
    assert r["blocked"] is True and r["ok"] is False
    ok = fam.post("/after_reply", json={"message_type": "private", "user_id": int(DAD), "message": "嗯", "reply": "下周去医院复查别忘了"}).json()
    assert not ok.get("blocked")


def test_remember_without_source_is_private(client):
    client.post("/remember", json={"content": "某人的银行卡密码提示是猫的名字加生日"})
    for chat in ("g:20001", "p:10001", "p:10000"):
        assert "银行卡" not in act(client, {"chat_id": chat}, "银行卡密码提示")


def test_explicit_private_in_shared_chat(fam):
    fam.post("/remember", json={"message_type": "private", "user_id": int(BRO), "content": "哥哥其实还没想好要不要辞职创业", "scope": "private", "tags": ["辞职", "创业"]})
    assert "辞职" not in act(fam, {"message_type": "group", "group_id": int(GROUP)}, "辞职创业")
    assert "辞职" in act(fam, {"message_type": "private", "user_id": int(BRO)}, "辞职创业")


def test_scoped_allow_list(fam):
    fam.post("/remember", json={"message_type": "private", "user_id": int(DAD), "content": "老爸想给老妈办五十岁惊喜派对", "scope": "scoped",
                                "allow": ["p:10003"], "tags": ["派对", "惊喜"]})
    assert "派对" in act(fam, {"message_type": "private", "user_id": int(BRO)}, "惊喜派对准备")
    assert "派对" not in act(fam, {"message_type": "private", "user_id": int(MOM)}, "惊喜派对准备")
    assert "派对" not in act(fam, {"message_type": "group", "group_id": int(GROUP)}, "惊喜派对准备")


def test_workbench_toggle_hot(fam):
    H = {"Authorization": "Bearer k"}
    d = fam.get("/api/privacy", headers=H).json()["privacy"]
    d["private_chats"][DAD] = "public"
    assert fam.put("/api/privacy", json={"privacy": d}, headers=H).json()["ok"]
    assert "医院复查" in act(fam, {"message_type": "group", "group_id": int(GROUP)}, "医院复查")
    d["private_chats"][DAD] = "private"
    fam.put("/api/privacy", json={"privacy": d}, headers=H)
    assert "医院复查" not in act(fam, {"message_type": "group", "group_id": int(GROUP)}, "医院复查")


def test_privacy_check_endpoint(fam):
    r = fam.post("/api/privacy/check", json={"chat": f"g:{GROUP}", "text": "老爸下周去医院复查"}, headers={"Authorization": "Bearer k"}).json()
    assert r["guard"]["blocked"] and r["hidden"] >= 2


def test_read_paths_positive_control(fam):
    """对照组：同样的查询在老爸自己的私聊里能拿到，证明上面的“查不到”不是因为功能没工作。"""
    H = {"Authorization": "Bearer k"}
    fam.post("/after_reply", json={"message_type": "private", "user_id": int(DAD), "message": "医院复查那天你提醒我带病历",
                                   "reply": "好，复查那天提醒你带病历", "record_user": True})
    assert "别跟你妈说" in fam.post("/recall", json={"chat_id": f"p:{DAD}", "query": "医院复查"}).text
    assert "别跟你妈说" in fam.get("/api/search", params={"q": "医院复查", "chat": f"p:{DAD}"}, headers=H).text
    assert "病历" in fam.get("/api/spill/search", params={"q": "病历", "chat": f"p:{DAD}"}, headers=H).text
