"""思考动画的召回事件流 /api/think：/activate 记事件、只给 id、按隐私过滤。"""
H = {"Authorization": "Bearer k"}


def _mem(client, chat, content, scope=None, tags=None):
    d = {"chat_id": chat, "content": content, "importance": 0.8, "tags": tags or ["体检", "医院"]}
    if scope:
        d["scope"] = scope
    return client.post("/remember", json=d).json()["id"]


def test_activate_records_think_event(client):
    a = _mem(client, "p:10000", "他下周三去医院体检，要空腹")
    _mem(client, "p:10000", "上次体检他说医院排队很久")
    r0 = client.get("/api/think", headers=H).json()
    assert r0["ok"] and isinstance(r0["events"], list)
    since = r0["last_seq"]
    act = client.post("/activate", json={"chat_id": "p:10000", "user_id": "10000", "message": "我明天去医院体检，要空腹吗"}).json()
    rec = [x["id"] for x in act["recalled"] if not str(x["id"]).startswith("spill:")]
    assert rec, act.get("debug")
    r = client.get(f"/api/think?since={since}", headers=H).json()
    if rec:
        assert r["last_seq"] > since and r["events"]
        ev = r["events"][-1]
        assert ev["focal"] in rec
        ids = [ev["focal"]] + ev["hits"] + ev["assoc"]
        assert set(ids) <= {x["id"] for x in act["recalled"]} | ({ev["spontaneous"]} if ev["spontaneous"] else set())
        # 没有聊天内容、没有 chat_id
        assert set(ev) == {"seq", "at", "source", "focal", "hits", "assoc", "spontaneous"}
        assert "体检" not in str(ev) and "10000" not in str(ev)
    assert a


def test_think_requires_auth_and_atlas_key(client, brain):
    assert client.get("/api/think").status_code == 401
    brain.cfg.data["atlas_key"] = "view"
    assert client.get("/api/think?key=view").status_code == 200
    assert client.post("/api/think/demo?key=view").status_code == 401   # 演示只给管理员


def test_think_privacy_filter(client, brain):
    pub = _mem(client, "p:10000", "公开的体检记忆", scope="public")
    priv = _mem(client, "p:10001", "10001 私聊里的体检秘密")       # p:10001 是 private 策略
    since = client.get("/api/think", headers=H).json()["last_seq"]
    brain.think.record([priv, pub], source="activate")
    brain.think.record([priv], source="activate")
    adm = client.get(f"/api/think?since={since}", headers=H).json()["events"]
    assert [e["focal"] for e in adm] == [priv, priv] and pub in adm[0]["hits"]
    # 别的私聊视角：看不到 10001 的私聊记忆 → 那条 id 被去掉；全看不到的事件整条不返回
    other = client.get(f"/api/think?since={since}&chat=p:10002", headers=H).json()["events"]
    assert len(other) == 1 and other[0]["focal"] == pub and priv not in str(other)
    # 和 /api/atlas 同一套规则
    atl = {s["id"] for s in client.get("/api/atlas?chat=p:10002", headers=H).json()["stars"]}
    assert pub in atl and priv not in atl


def test_think_ring_and_demo(client, brain):
    for i in range(5):
        _mem(client, "p:10000", f"第{i}条公开记忆 体检", scope="public")
    r = client.post("/api/think/demo", json={"count": 4}, headers=H).json()
    assert r["ok"] and r["seq"]
    ev = client.get(f"/api/think?since={r['seq'] - 1}", headers=H).json()["events"]
    assert ev and ev[0]["source"] == "demo" and len([ev[0]["focal"]] + ev[0]["hits"]) == 4
    assert brain.think.record([], []) is None and brain.think.record(["spill:x"]) is None
    for i in range(300):
        brain.think.record([f"x{i}"])
    assert len(brain.think.buf) <= 200


def test_think_feed_can_be_disabled(client, brain):
    _mem(client, "p:10000", "他下周三去医院体检，要空腹")
    brain.cfg.data["think_feed_enabled"] = False
    since = client.get("/api/think", headers=H).json()["last_seq"]
    client.post("/activate", json={"chat_id": "p:10000", "user_id": "10000", "message": "医院体检空腹"})
    client.post("/recall", json={"chat_id": "p:10000", "message": "医院体检"})
    assert client.get("/api/think", headers=H).json()["last_seq"] == since


def test_atlas_key_opens_star_sea(client, brain):
    """星海 iframe 只带只读 atlas_key：能过开门检查、看星图和思考，碰不到管理接口。"""
    brain.cfg.data["atlas_key"] = "view-only"
    assert client.get("/api/auth/check?key=view-only").status_code == 200
    assert client.get("/api/atlas?key=view-only").status_code == 200
    assert client.get("/api/think?key=view-only").status_code == 200
    assert client.get("/api/memories?key=view-only").status_code == 401
    assert client.post("/api/think?key=view-only", json={}).status_code == 401
    for url in ("/api/settings", "/api/privacy", "/api/search?q=x"):
        assert client.get(url + ("&" if "?" in url else "?") + "key=view-only").status_code == 401, url


def test_local_no_auth_rejects_cross_site_origin(client):
    """本机免密只给不带 Origin 的本机程序；别的网站跨站 POST（带外站 Origin）要密钥。"""
    body = {"chat_id": "p:10000", "user_id": "10000", "content": "跨站测试"}
    assert client.post("/remember", json=body).status_code == 200
    assert client.post("/remember", json=body, headers={"Origin": "http://127.0.0.1:8780"}).status_code == 200
    assert client.post("/remember", json=body, headers={"Origin": "https://evil.example"}).status_code == 401
    assert client.post("/remember", json=body, headers={"Origin": "null"}).status_code == 401
    assert client.post("/remember", json=body, headers={"Origin": "https://evil.example", "Authorization": "Bearer k"}).status_code == 200
