"""/style 给插件的体感情绪（只给数，情欲不出口子）。"""
from brain import emotion as EMO


def test_style_disabled_returns_empty(client, brain):
    brain.cfg.data["emotion_enabled"] = False
    r = client.get("/style").json()
    assert r["ok"] and r["enabled"] is False and r["felt"] == {}


def test_style_felt_blend_and_hides_adult(client, brain):
    brain.cfg.data["emotion_enabled"] = True
    EMO.apply(brain, brain.primary, {"changes": {"开心": {"surface": 60, "inner": 20}, "情欲": {"surface": 80}}, "reason": "测试"})
    r = client.get("/style").json()
    assert r["ok"] and r["enabled"]
    assert "情欲" not in r["felt"]
    assert "开心" in r["felt"] and r["felt"]["开心"] > 0
    st = EMO.state(brain, brain.primary)["dims"]["开心"]
    assert abs(r["felt"]["开心"] - round(st["surface"] * 0.7 + st["inner"] * 0.3, 1)) < 1.5
