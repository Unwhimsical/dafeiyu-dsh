"""18+ 写入打标、召回隔离、展示隐藏。"""
from brain import memory as M, context as CTX, sensitivity as SENS

ADULT = "那天晚上的亲密时刻（nsfw 测试样例）"
PLAIN = "那天晚上一起去吃了火锅，聊到很晚"


def _seed(brain):
    a = M.remember(brain, content=ADULT, chat="p:10000", kind="event", source="api", check_poison=False)
    p = M.remember(brain, content=PLAIN, chat="p:10000", kind="event", source="api", check_poison=False)
    return a, p


def test_mark_tags_on_write(brain):
    a, p = _seed(brain)
    ra, rp = M.get(brain, a["id"]), M.get(brain, p["id"])
    assert "nsfw" in (ra["tags"] or "")
    assert "nsfw" not in (rp["tags"] or "")
    assert "nsfw" in SENS.mark_tags("今天身体有点热", [], kind="body")


def test_recall_only_in_owner_private(brain):
    _seed(brain)
    q = "那天晚上 亲密时刻 火锅"
    own = M.search(brain, q, chat="p:10000", adult=True)["results"]
    assert any("亲密时刻" in x["content"] for x in own)
    # 没明确传 adult=true（没对上暗号）→ 不给
    plain = M.search(brain, q, chat="p:10000")["results"]
    assert not any("亲密时刻" in x["content"] for x in plain)
    # 主人会话但调用方声明不是 QQ 主人私聊（例如抖音私信）→ 不给
    dy = M.search(brain, q, chat="p:10000", adult=False)["results"]
    assert not any("亲密时刻" in x["content"] for x in dy)
    sysr = M.search(brain, q, chat="system")["results"]
    assert not any("亲密时刻" in x["content"] for x in sysr)


def test_activate_adult_false(brain):
    _seed(brain)
    r = CTX.build(brain, {"chat_id": "p:10000", "message": "那天晚上 亲密时刻", "adult": False}, preview=True)
    assert "亲密时刻" not in (r.get("block") or "")


def test_display_hidden_by_default(client, brain):
    _seed(brain)
    h = {"Authorization": "Bearer k"}
    for url in ("/api/memories", "/api/memories?include_adult=1", "/api/atlas", "/api/search?q=那天晚上", "/api/stats"):
        r = client.get(url, headers=h)
        assert r.status_code == 200, url
        assert "亲密时刻" not in r.text, url
    # 主人打开 adult_reveal 后，显式请求才显示
    brain.cfg.data["adult_reveal"] = True
    r = client.get("/api/memories?include_adult=1", headers=h)
    assert "亲密时刻" in r.text


def test_scrub_masks_nested():
    d = SENS.scrub({"items": [{"content": ADULT}, {"content": PLAIN}], "summary": ADULT})
    assert len(d["items"]) == 1 and d["summary"] == SENS.HIDDEN


def test_about_section_hides_adult_unless_allowed(brain):
    M.remember(brain, content="他喜欢" + ADULT, chat="p:10000", kind="preference", speaker="10000", source="api", check_poison=False)
    M.remember(brain, content="他喜欢吃火锅和辣的", chat="p:10000", kind="preference", speaker="10000", source="api", check_poison=False)
    t, _ = CTX.about_section(brain, "p:10000", brain.primary, "10000", "", 400, adult=True)
    assert "亲密时刻" in t and "火锅" in t
    t, _ = CTX.about_section(brain, "p:10000", brain.primary, "10000", "", 400)
    assert "亲密时刻" not in t and "火锅" in t
    t, _ = CTX.about_section(brain, "p:10000", brain.primary, "10000", "", 400, adult=False)
    assert "亲密时刻" not in t and "火锅" in t
    r = CTX.build(brain, {"chat_id": "p:10000", "user_id": "10000", "message": "你好", "adult": False}, preview=True)
    assert "亲密时刻" not in (r.get("block") or "")
