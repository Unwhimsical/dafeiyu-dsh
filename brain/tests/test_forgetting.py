from brain import forgetting as F
from brain.util import iso, now_ms

DAY = 86400_000


def row(imp=3, kind="event", days=0, pinned=0, **kw):
    t = iso(now_ms() - days * DAY)
    d = F.initial_fields(imp, kind, [], "x", t)
    d.update({"importance": imp, "kind": kind, "created_at": t, "pinned": pinned or d.get("pinned", 0), "tags": "[]", "content": "x"})
    d.update(kw)
    return d


def test_decay_halves():
    fresh = F.strength_now(row(3, days=0))
    old = F.strength_now(row(3, days=60))
    assert fresh > old and old < 0.5


def test_states_progress():
    assert F.state_of(row(3, days=0)) == "clear"
    assert F.state_of(row(1, days=60)) == "trace"


def test_permanent_by_type_only():
    assert F.state_of(row(2, kind="preference", days=400)) == "pinned"
    # 重要度 5 但类型是 event → 不自动永久
    assert F.state_of(row(5, kind="event", days=400)) != "pinned"


def test_display_prefix():
    r = row(1, days=60)
    assert F.display_content(r, F.state_of(r)).startswith("（")
