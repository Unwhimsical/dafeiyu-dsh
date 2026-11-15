"""第 11 轮：情绪/激素逐项可调、星海生长（有界漂移 + 回滚）、关系不串会话、间隔强化。"""
import json
from brain.util import now_ms, iso

H = {"Authorization": "Bearer k"}


def test_emotion_tuning_disable_and_weight(client, brain):
    from brain import emotion as E
    assert client.post("/api/emotion/tuning", json={"dims": {"生气": {"enabled": False}, "开心": {"weight": 2, "surface_half_h": 9999}}}).status_code == 401
    r = client.post("/api/emotion/tuning", headers=H, json={"dims": {"生气": {"enabled": False}, "开心": {"weight": 2, "surface_half_h": 9999}, "不存在": {"weight": 1}},
                                                            "hormones": {"皮质醇": {"enabled": False}}}).json()
    assert r["ok"] and r["dims"]["生气"]["enabled"] is False and r["dims"]["开心"]["weight"] == 2
    assert r["dims"]["开心"]["surface_half_h"] == 240.0            # 夹到上限
    assert "不存在" not in r["dims"] and "情欲" not in r["dims"]   # 18+ 维度默认不出现在列表
    out = E.apply(brain, None, {"changes": {"生气": {"surface": 30}, "开心": {"surface": 10}}, "reason": "测"})
    assert "生气" not in out["applied"] and out["applied"]["开心"]["surface"] == 20
    assert "生气" not in out["prompt_line"]
    bio = E.bio_event(brain, None, {"type": "argue", "intensity": 1})
    assert E.bio_state(brain, None)["hormones"]["皮质醇"]["enabled"] is False
    # reset 真的删掉覆盖
    r = client.post("/api/emotion/tuning", headers=H, json={"reset": ["生气"]}).json()
    assert r["dims"]["生气"]["enabled"] is True


def test_growth_bounded_rollback(client, brain):
    from brain import growth as G
    pid = brain.primary
    for i in range(7):
        brain.db.x("INSERT INTO emotion_snapshots VALUES (?,?,?)", (pid, f"2026-10-0{i+1}", json.dumps({"开心": {"surface": 100}, "生气": {"surface": 100}})))
    first = G.grow(brain, pid)
    assert first["ok"] and first["changed"]
    for _ in range(40):
        G.grow(brain, pid)
    t = G.view(brain, pid)["traits"]
    for k, v in t.items():
        assert abs(v["value"] - v["base"]) <= 0.25 + 1e-6
    assert t["外向性"]["value"] > t["外向性"]["base"] and t["宜人性"]["value"] < t["宜人性"]["base"]
    sid = first["snapshot"]
    assert client.post("/api/growth", headers=H, json={"action": "rollback", "id": sid}).json()["ok"]
    assert G.view(brain, pid)["traits"]["外向性"]["value"] == G.TRAITS["外向性"][0]
    client.post("/api/growth", headers=H, json={"frozen": True})
    assert G.grow(brain, pid)["skipped"] == "frozen"
    client.post("/api/growth", headers=H, json={"enabled": False})
    assert G.prompt_line(brain, pid, "p:10000", "10000") == ""


def test_relation_callbacks_never_cross_chats(brain):
    from brain import growth as G
    pid = brain.primary
    old = now_ms() - 3 * 86400_000
    G.on_turn(brain, pid, "p:10000", "10000", "我下周要去杭州出差", old)
    line_owner = G.prompt_line(brain, pid, "p:10000", "10000")
    assert "杭州" in line_owner
    # 同一个人在群里说话：只给熟悉度，不带话题
    assert "杭州" not in G.prompt_line(brain, pid, "g:20001", "10000")
    # 别人私聊看不到
    assert "杭州" not in G.prompt_line(brain, pid, "p:10002", "10002")
    # 18+ / 暗号类不记话题
    G.on_turn(brain, pid, "p:10000", "10000", "暗号是什么来着", old)
    assert all("暗号" not in t["w"] for t in G.relation(brain, pid, G.person_of(brain, "p:10000", "10000"))["topics"])


def test_spaced_reinforcement():
    from brain import forgetting as F
    now = now_ms()
    fresh = {"importance": 3, "half_life_days": 14, "strength": 0.8, "last_recalled_at": iso(now - 3600_000), "created_at": iso(now - 3600_000)}
    late = dict(fresh, last_recalled_at=iso(now - 20 * 86400_000))
    assert F.reinforce_patch(late, now)["half_life_days"] > F.reinforce_patch(fresh, now)["half_life_days"]
    assert F.reinforce_patch(dict(fresh, half_life_days=3000), now)["half_life_days"] <= 3650


def test_backup_download_strips_adult_and_logs_redacted(client, brain, tmp_path, monkeypatch):
    import sqlite3, logging, tempfile
    tdir = tmp_path / "tmp"; tdir.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(tdir))
    from brain import memory as M
    M.remember(brain, content="他喜欢吃火锅", persona=brain.primary, tags=["饮食"], chat="p:10000")
    M.remember(brain, content="昨晚的私密记录（18+ 测试样例）", persona=brain.primary, tags=["nsfw"], chat="p:10000")
    name = client.post("/api/backups", headers=H).json()["name"]
    r = client.get(f"/api/backups/{name}/download?full=1", headers=H)
    assert r.status_code == 200
    p = tmp_path / "dl.db"; p.write_bytes(r.content)
    rows = [x[0] for x in sqlite3.connect(str(p)).execute("SELECT content FROM memories")]
    assert any("火锅" in x for x in rows) and not any("私密记录" in x for x in rows)
    assert list(tdir.iterdir()) == [], "下载完临时副本要删掉"
    logging.getLogger("brain").warning("测试 Bearer abcdefghijk 密钥 k 口令：芝麻开门")
    msgs = " ".join(x["msg"] for x in brain.ring.buf)
    assert "abcdefghijk" not in msgs and "芝麻开门" not in msgs


def test_starhalo_confidence_feedback_tint(client, brain):
    from brain import emotion as E, memory as M, starhalo as SH
    r = E.apply(brain, None, {"changes": {"开心": {"surface": 30}}, "reason": "他说「真棒哦」（反话）", "confidence": 0.3})
    assert r.get("skipped") == "low_confidence" and not r["applied"]
    m = M.remember(brain, content="他说他最喜欢吃草莓", persona=brain.primary, tags=["草莓"], chat="p:10000")
    mid = m["id"]
    j = client.post(f"/api/memories/{mid}/feedback", headers=H, json={"action": "confirm", "expected_version": 1}).json()
    assert j["ok"] and j["version"] == 2
    assert client.post(f"/api/memories/{mid}/feedback", headers=H, json={"action": "deny", "expected_version": 1}).status_code == 409
    j = client.post(f"/api/memories/{mid}/feedback", headers=H, json={"action": "correct", "content": "他以前最喜欢草莓，现在更喜欢蓝莓"}).json()
    assert j["ok"] and M.get(brain, mid)["status"] == "superseded"     # 原文保留
    line, t = SH.tint("- x", 0.0, 0.5)
    assert not t and line == "- x"                                     # 中性不加滤镜
    assert SH.tint("- x", -0.9, 0.5)[0].startswith("- x（")           # 只加尾注，不改原文


def test_random_walk_never_private_in_group(brain):
    from brain import starhalo as SH, memory as M
    M.remember(brain, content="和他私下说好的秘密计划", persona=brain.primary, tags=["计划"], chat="p:10001", emotion=0.5)
    row = brain.db.one("SELECT * FROM memories WHERE content LIKE '%秘密计划%'")
    assert not SH.walk_ok(brain, "g:20001", row, False)
    assert not SH.walk_ok(brain, "p:10002", row, False)


def test_baseline_drift_bounded_and_inertia_off_by_default(brain):
    from brain import growth as G, emotion as E
    base0 = E.dim_conf(brain, "开心")[2]
    G._emotion_avgs_orig = G._emotion_avgs
    G._emotion_avgs = lambda b, pid: {"开心": 100.0}
    try:
        for _ in range(10):
            G.grow(brain, force=True)
    finally:
        G._emotion_avgs = G._emotion_avgs_orig
    sh = G.load(brain, brain.primary)["emo_shift"]["开心"]
    assert 0 < sh <= 10.0 and E.dim_conf(brain, "开心")[2] <= base0 + 10.0
    assert E._inertia_k(brain) == 1.0            # 默认不改原情绪算法


def test_wechat_identity_map_and_person_merge(client, brain):
    from brain import growth
    brain.privacy.data.setdefault("person_map", {})["10001"] = {"douyin": "", "wechat": "o9x@im.wechat", "label": "测试"}
    r = client.get("/wechat_map")
    assert r.status_code == 200 and r.json()["map"] == {"o9x@im.wechat": "10001"}
    assert growth.person_of(brain, "p:wx_o9ximwechat") == "qq:10001"
    assert growth.person_of(brain, "p:wx_stranger") == "id:wx_stranger"
