H = {"Authorization": "Bearer k"}


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["ok"]


def test_compat_endpoints(client):
    r = client.post("/remember", json={"chat_id": "p:10000", "content": "他明天体检", "importance": 0.8, "extra_field": 1})
    assert r.json()["ok"]
    a = client.post("/activate", json={"chat_id": "p:10000", "user_id": "10000", "message": "体检", "unknown": True}).json()
    for k in ("block", "context", "memory_block", "injection", "text", "memories"):
        assert k in a
    assert client.post("/activate", json={}).status_code == 200          # 缺字段也不炸
    assert client.post("/bio/event", json={"chat_id": "p:10000", "event": "hug"}).json()["ok"]
    assert "pulses" in client.get("/pulses").json()
    assert client.post("/after_reply", json={"chat_id": "p:10000", "reply": "好"}).json()["ok"]


def test_admin_auth(client):
    assert client.get("/api/stats").status_code == 401
    assert client.get("/api/stats", headers=H).status_code == 200
    assert client.get("/api/stats?key=k").status_code == 200
    assert client.get("/api/nothing", headers=H).json()["error"] == "not_found"


def test_views_shapes(client):
    a = client.get("/api/atlas", headers=H).json()
    for k in ("stars", "items", "links", "personas", "counts"):
        assert k in a
    g = client.get("/api/view/garden", headers=H).json()
    assert "people" in g and "cards" in g


def test_privacy_put_validates(client):
    assert client.put("/api/privacy", json={"private_chats": {"1": "weird"}}, headers=H).status_code == 400
    r = client.get("/api/privacy", headers=H).json()
    assert r["privacy"]["private_chats"]["10001"] == "private"


def test_mcp(client):
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}, headers=H).json()
    assert r["result"]["serverInfo"]["name"]
    tools = client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=H).json()["result"]["tools"]
    assert any(t["name"] == "recall" for t in tools) and any(t["name"] == "body_status" for t in tools)
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "remember", "arguments": {"content": "MCP 写的一条", "chat": "p:10000"}}}, headers=H).json()
    assert "result" in r
    assert client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=H).status_code == 202


def test_jobs_run(client):
    from brain import scheduler as SCH
    for j in SCH.JOBS:
        r = client.post(f"/api/run/{j}", headers=H)
        assert r.status_code == 200, (j, r.text)
        assert r.json()["ok"], (j, r.text)


def test_18plus_kept(client):
    m = client.get("/api/modules", headers=H).json()
    for k in ("emotion", "body", "dream"):
        assert m[k]["enabled"] is True
    assert m["desire"]["enabled"] is False   # 18+ 欲望日志：开源默认关闭
    assert client.get("/api/body", headers=H).json()["enabled"]
