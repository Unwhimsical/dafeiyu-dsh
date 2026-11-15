"""18+ 身体模块（默认关闭）+ 全项目人称方向（用户＝他，大肥鱼＝她）的回归测试。"""
import json, re
from pathlib import Path
from brain import body as B, context as CTX
from brain.util import now_ms, iso, jdump

ROOT = Path(__file__).resolve().parent.parent
H = {"X-Admin-Key": "k"}
MALE = ["hard" + "ness", "full" + "ness", "refrac" + "tory", "co" + "ck"]   # 旧版字段名只允许出现在兼容映射里


def test_val_keys_are_female():
    assert B.VAL_KEYS == ["wetness", "emptiness", "sensitivity", "edge", "desire", "stim", "fluids"]
    assert B.LABEL_ZH["wetness"] == "兴奋度" and B.LABEL_ZH["emptiness"] == "失落感"
    s = B.fresh_state("dafeiyu", now_ms())
    assert "afterglow_until" in s and not any(k in s for k in B.LEGACY_KEYS)
    assert "private" in B.PART_ZH and "breast" in B.PART_ZH
    assert "兴奋度" in B.values_line(B.vals(s)) and "失落感" in B.values_line(B.vals(s))


def test_legacy_state_migrates(brain):
    old = {"hard" + "ness": 90, "full" + "ness": 33, "refrac" + "tory_until": None, "desire": 55}
    brain.db.x("INSERT INTO body_state(persona_id, data) VALUES (?,?)", ("dafeiyu", jdump(old)))
    s = B.load_state(brain, "dafeiyu", now_ms())
    assert s["wetness"] == 60 and s["emptiness"] == 33 and s["desire"] == 55
    assert not any(k in s for k in B.LEGACY_KEYS)
    assert B.migrate_values({"full" + "ness": 5})["emptiness"] == 5
    assert B.part_zh("co" + "ck") == "敏感部位"


def test_release_and_afterglow():
    now = now_ms()
    s = B.fresh_state("dafeiyu", now)
    s.update(wetness=80, emptiness=50, edge=99, desire=90)
    B.release(s, now)
    assert s["emptiness"] == 0 and s["edge"] == 0 and s["wetness"] >= 70
    assert s["desire"] <= 25 and s["afterglow_until"]
    _, notes = B.apply_events(s, [{"type": "touch", "part": "breast", "level": "light"}], now + 1000)
    assert any("平复" in n or "敏感" in n for n in notes)
    _, notes = B.apply_events(s, [{"type": "arousal", "delta": 20}], now + 2000)
    assert any("又被他撩动了" in n for n in notes)


def test_session_rub_and_legacy_alias():
    ss = B.new_session(10, 100, 1.0, 0)
    B.session_step(ss, "str" + "oke", "", lambda k, u: None, rnd=lambda: 0)
    assert ss["rounds"][-1]["action"] == "rub" and ss["arousal"] > 10
    ss2 = B.new_session(10, 100, 1.0, 0)
    B.session_step(ss2, "think_of_her", "", lambda k, u: {"ref": "memory:x", "text": "他笑了"}, rnd=lambda: 0)
    assert ss2["rounds"][-1]["action"] == "think_of_him" and ss2["arousal"] > 10
    assert "rub" in B.ACTIONS and "think_of_him" in B.ACTIONS


def test_decision_to_user_and_to_her():
    d = B.parse_decision('好想你\nBODY_DECISION {"choice":"relieve","method":"想他","thought":"","to_her":"快回来"}')
    assert d["to_user"] == "快回来" and d["to_her"] == "快回来"
    d = B.parse_decision('BODY_DECISION {"choice":"endure","to_user":"等你"}')
    assert d["to_user"] == "等你"


def test_photo_title_both(brain):
    for i, t in enumerate(["他的照片·海边", "她的照片·旧"]):
        brain.db.x("INSERT INTO garden_images(id, persona_id, title, created_at) VALUES (?,?,?,?)", (f"img{i}", "dafeiyu", t, f"2026-01-0{2 - i}T00:00:00"))
    get = B.db_materials(brain, "dafeiyu", rnd=lambda: 0)
    seen = {get("look_his_photo", set())["ref"], get("look_her_photo", {"image:img0"})["ref"]}
    assert seen == {"image:img0", "image:img1"}


def test_classifier_prompt_direction():
    p = B.CLASSIFIER_SYSTEM
    assert "男性伴侣" not in p and "读「他」" in p and "private" in p and "co" + "ck" not in p
    assert not re.search("射|硬", B.ACTION_PREFILTER.pattern) and not re.search("射|硬了", B.HEAT_WORDS.pattern)
    assert B.rule_classify("亲你脖子一下") is not None


def test_user_name_default_is_him(brain):
    from brain import config
    src = (ROOT / "brain" / "config.py").read_text(encoding="utf-8")
    assert '"user_name": "他"' in src
    assert json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))["user_name"] == "他"
    assert B.render(brain, "{{USER_NAME}}") == (brain.cfg.get("user_name") or "他")


def test_leave_note_tools(client):
    tools = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers=H).json()["result"]["tools"]
    names = {t["name"] for t in tools}
    assert {"leave_note_for_user", "leave_note_for_him"} <= names
    for i, n in enumerate(("leave_note_for_user", "leave_note_for_him", "leave_note_for_her")):
        r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 10 + i, "method": "tools/call", "params": {"name": n, "arguments": {"text": f"想你{i}"}}}, headers=H).json()
        assert "result" in r and "error" not in r, r
    texts = [x["text"] for x in client.get("/outbox?chat_id=p:10000&kinds=note", headers=H).json().get("items", [])]
    assert {"想你0", "想你1", "想你2"} <= set(texts)


def test_body_api_fields_and_privacy(client, brain):
    j = client.get("/api/body", headers=H).json()
    assert j["enabled"] and "wetness" in j["values"] and "emptiness" in j["values"] and "afterglow_until" in j
    assert not any(k in j["values"] for k in B.LEGACY_KEYS)
    r = client.post("/api/body/events", json={"events": [{"type": "kiss", "part": "breast", "level": "light"}]}, headers=H).json()
    assert r.get("ok", True)
    # 仍然只在主人私聊出现
    for chat, uid in (("p:10001", "10001"), ("g:20001", "10000")):
        assert "【身体】" not in CTX.build(brain, {"chat_id": chat, "user_id": uid, "message": "抱抱"}, preview=True)["block"]


def test_emotion_user_message_alias(brain):
    from brain import emotion as EMO
    for t in ("user_message", "his_message", "her_message"):
        EMO.fact(brain, "dafeiyu", {"type": t})
    st = EMO.state(brain, "dafeiyu")
    assert st["facts"]["last_user_msg_at"] and st["facts"]["last_user_msg_at"] == st["facts"]["last_her_msg_at"]
    assert "他" in (st.get("facts_text") or "") or st.get("facts_text") == ""


def test_no_male_terms_left():
    files = [ROOT / "brain" / f for f in ("body.py", "desire.py", "continuity.py", "emotion.py", "dream.py")] + \
            [ROOT / "web" / "js" / f for f in ("config.js", "mock.js", "workbench.js")] + [ROOT / "web" / "garden" / "app.js"]
    for f in files:
        txt = f.read_text(encoding="utf-8")
        txt = txt.replace('"hard" + "ness"', "").replace('"full" + "ness"', "").replace('"refrac" + "tory_until"', "").replace('"co" + "ck"', "").replace('"str" + "oke"', "")
        if f.suffix == ".js":
            txt = re.sub(r"放射|射出|strokeStyle|\.stroke\(|stroke=", "", txt)
        for w in MALE:
            assert w not in txt, (f.name, w)


def test_adult_modules_default_off():
    from brain import config
    assert config.DEFAULTS["body_enabled"] is False and config.DEFAULTS["desire_enabled"] is False
    ex = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
    assert ex["body_enabled"] is False and ex["desire_enabled"] is False
