"""写入演示数据（与前端离线演示同一套，约 150 条记忆 + 梦/心痕/交接/未了/便条/欲望）。
用法：python scripts/seed_demo.py [--config config.json] [--reset]
--reset 会先清空当前库的记忆类表（只建议在演示库上用！真实库请别加）。"""
from __future__ import annotations
import argparse, json, os, random, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

WIPE = ["memories", "memories_fts", "entity_mentions", "memory_links", "memory_audit", "pulses", "dreams", "heart_traces", "handoffs", "unresolved",
        "notes", "desire_logs", "desire_replies", "reviews", "turns", "chat_counters", "garden_entries", "conversations", "topics", "deck_items",
        "her_status", "companion_notes", "peer_messages"]


def seed(b, reset=False, rnd=None):
    from brain import memory as M, continuity as C
    from brain.util import iso, now_ms, new_id, jdump
    rnd = rnd or random.Random(7)
    data = json.loads((ROOT / "scripts" / "demo_data.json").read_text(encoding="utf-8"))
    if reset:
        for t in WIPE:
            try:
                b.db.x(f"DELETE FROM {t}")
            except Exception:
                pass
    priv = dict(data["PRIV"])
    priv.pop("default", None)
    priv.update({"default_private": "private", "default_group": "public"})
    b.privacy.save(priv)
    now = now_ms()
    for p in data["PERSONAS"]:
        if p["id"] == "family":
            continue
        b.db.x("INSERT OR IGNORE INTO personas(id, display_name, created_at, updated_at) VALUES (?,?,?,?)", (p["id"], p["name"], iso(), iso()))
        b.db.x("UPDATE personas SET display_name=?, relationship_to_user=?, self_card=? WHERE id=?", (p["name"], p.get("relationship_to_user") or "", p.get("core") or "", p["id"]))
    chats = data["CHATS"]
    ids = []
    rows = [(k, c, imp, tags, content, pin, "dafeiyu") for k, c, imp, tags, content, *rest in data["M"] for pin in [rest[0] if rest else 0]]
    rows += [(k, "sys", 3, [], content, 0, pid) for pid, k, content in data["SIDE"]]
    rows.append(("event", "ba", 4, ["老爸", "医院", "复查"], "老爸说：我下周去医院复查，别跟你妈说。", 0, "dafeiyu"))
    for i, (kind, ck, imp, tags, content, pin, pid) in enumerate(rows):
        age_d = rnd.uniform(0, 40) if i % 5 else rnd.uniform(0, 4)
        created = iso(now - age_d * 86400_000)
        chat = chats.get(ck, "system")
        speaker = chat.split(":", 1)[1] if chat.startswith("p:") else ""
        r = M.remember(b, content=content, persona=pid, kind=kind, importance=imp, tags=tags, chat=chat, speaker=speaker, pin=bool(pin),
                       source="demo", check_poison=False, created_at=created, link=False, fact_key="")
        if r.get("ok") and r.get("id"):
            ids.append(r["id"])
            if rnd.random() < 0.35:
                rc = rnd.randint(1, 6)
                b.db.x("UPDATE memories SET recall_count=?, last_recalled_at=?, strength=MIN(1, COALESCE(strength,0.6)+0.15) WHERE id=?",
                       (rc, iso(now - rnd.uniform(0, 5) * 86400_000), r["id"]))
    for mid in ids:
        M.link_one(b, mid)
    for a, c in zip(ids[::7], ids[3::7]):
        M.upsert_link(b, a, c, 0.35, "co_recall")
    # 非记忆条目
    for typ, title, content in data["ITEMS"]:
        t = iso(now - rnd.uniform(0, 12) * 86400_000)
        if typ == "dream":
            day = "2026-" + title.split("·")[-1].strip().replace(".", "-").zfill(5)
            b.db.x("INSERT OR IGNORE INTO dreams(id, persona_id, dream_date, text, cited_ids, model, status, consolidated, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                   (f"dream_{day}_dafeiyu", "dafeiyu", day, content, jdump(rnd.sample(ids, 3)), None, "demo", "[]", t))
        elif typ == "heart":
            C.heart_save(b, "dafeiyu", title, content, "dafeiyu")
        elif typ == "handoff":
            chat = "p:10001" if "老爸" in content else "p:10000"
            C.handoff_close(b, "dafeiyu", chat, content, "疲惫但想努力" if chat == "p:10000" else "", "", "demo")
        elif typ == "worry":
            C.unresolved_add(b, "dafeiyu", content, "p:10001" if "老爸" in title else "p:10000")
        elif typ == "note":
            C.note_write(b, "dafeiyu", content, None, "user")
        elif typ == "desire":
            b.db.x("INSERT INTO desire_logs(id, persona_id, entry_date, level_label, status, source, source_custom, trigger_text, mood, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                   (new_id("ds_"), "dafeiyu", t[:10], str(rnd.randint(2, 4)), "藏着", "custom", "", title, content, t, t))
        elif typ in ("mood", "diary"):
            b.db.x("INSERT INTO garden_entries(id, persona_id, kind, title, body, entry_date, favorite, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?)",
                   (new_id("ge_"), "dafeiyu", "diary", title, content, t[:10], t, t))
    b.db.x("INSERT INTO her_status(id, mood, energy, note, created_at) VALUES (?,?,?,?,?)", (new_id("s_"), "有点累", 3, "今天加班，晚点聊", iso()))
    tid = new_id("t_")
    b.db.x("INSERT INTO topics(id, name, description, created_at) VALUES (?,?,?,?)", (tid, "聊天话题", "没话聊时抽一张", iso()))
    for tt, cc in [("如果", "如果明天放假一天，你最想做什么？"), ("小时候", "小时候最怕的东西是什么？"), ("旅行", "下一次旅行想去哪里？")]:
        b.db.x("INSERT INTO deck_items(id, topic_id, kind, title, content, created_by, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
               (new_id("dk_"), tid, "card", tt, cc, "demo", "[]", iso(), iso()))
    # 几条对话，让交接/反思/溢出有素材
    from brain import context as CTX
    for chat, uid, msgs in [("p:10000", "10000", ["今天又加班了", "软考的书还没拆", "晚安小鱼"]), ("p:10001", "10001", ["我下周去医院复查", "别告诉你妈"])]:
        for m in msgs:
            CTX.record_turn(b, chat, "dafeiyu", "user", uid, m)
            CTX.record_turn(b, chat, "dafeiyu", "assistant", "", "嗯，我记着呢。")
    return {"memories": len(set(ids))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    ap.add_argument("--reset", action="store_true")
    a = ap.parse_args()
    if a.config:
        os.environ["BRAIN_CONFIG"] = a.config
    from brain.core import Brain
    b = Brain()
    if not a.reset and b.db.one("SELECT COUNT(*) c FROM memories")["c"] > 0:
        print("库里已经有记忆了。演示数据只建议写进空库；确实要覆盖请加 --reset（会清空记忆！）。")
        return
    print("写入完成：", seed(b, reset=a.reset))
    b.close()


if __name__ == "__main__":
    main()
