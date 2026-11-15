"""身份对照表 people（QQ=抖音:名字）→ 大脑自己的 privacy.json。"""
import json
from brain import identity_sync as IDS

H = {"Authorization": "Bearer k"}  # conftest 里的测试用 admin_key


def test_parse_people_formats():
    got = IDS.parse_people("11111=22222:小王\n33333:老李；44444=55555\n# 注释\n乱写的")
    assert ("11111", "22222", "小王") in got
    assert ("33333", "", "老李") in got
    assert ("44444", "55555", "") in got
    assert len(got) == 3
    assert IDS.parse_people([{"qq": "66666", "dy": "77777", "name": "表"}]) == [("66666", "77777", "表")]


def test_sync_writes_brain_privacy_and_reloads(client, brain, tmp_path, monkeypatch):
    aura = tmp_path / "aurabot"
    aura.mkdir()
    (aura / "config.json").write_text(json.dumps({"ext": {"identity": {
        "ownerQq": "10000", "ownerDouyin": "90000", "people": "12345=67890:小王"}}}), encoding="utf-8")
    monkeypatch.setattr(IDS, "CONFIG", aura / "config.json")
    monkeypatch.setitem(IDS._last_state, "ok", False)
    r = client.post("/api/identity/sync", headers=H).json()
    assert r["ok"] and r["people"] == 2, r
    data = json.loads(brain.cfg.privacy_file.read_text(encoding="utf-8"))
    assert data["person_map"]["12345"]["douyin"] == "67890"
    assert data["person_map"]["12345"]["label"] == "小王"
    assert data["private_chats"]["67890"] == "private"
    snap = client.get("/api/identity", headers=H).json()
    assert "12345" in snap["person_map"]
