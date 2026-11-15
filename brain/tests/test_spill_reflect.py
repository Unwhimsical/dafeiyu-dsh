from brain import spill as S, maintenance as MT, context as CTX


def test_spill_append_and_search_same_chat(brain):
    S.append(brain, "p:10000", "user", "上次说的那家火锅店叫小龙坎", user_id="10000")
    S.append(brain, "p:10001", "user", "上次说的火锅店叫海底捞", user_id="10001")
    S.index(brain, full=True)
    hits = S.search(brain, "上次说的火锅店", "p:10000", force=True, min_hits=1)
    assert hits and all("海底捞" not in h["content"] for h in hits)


def test_reflect_rules(brain):
    for m in ["我最喜欢吃草莓", "我下个月去北京出差", "我不喜欢下雨天"]:
        CTX.record_turn(brain, "p:10000", brain.primary, "user", "10000", m)
    r = MT.reflect(brain, "p:10000")
    assert r["ok"]
    for w in r.get("written") or []:
        row = brain.db.one("SELECT origin_chat FROM memories WHERE id=?", (w if isinstance(w, str) else w.get("id"),))
        assert row is None or row["origin_chat"] == "p:10000"
