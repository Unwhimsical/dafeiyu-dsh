"""话簿账本端到端自检：全程临时目录，不碰任何真实数据。

覆盖：逐句底账 / 不写明文镜像 / 原话不可改 / 她自己分配 / 冷热与热因 /
      平时零触发零注入 / 按需只捞相关 / 她知道有这本子 / 回顾 / 导出 / 彻底抹除。
"""
from __future__ import annotations
import json, logging, os, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _brain(tmp: Path):
    os.environ["BRAIN_DATA_DIR"] = str(tmp / "data")
    os.environ["DAFEIYU_LEDGER_DIR"] = str(tmp / "ledger")
    from brain.config import Config
    from brain.db import DB

    class B:
        pass

    b = B()
    b.cfg = Config()
    b.db = DB(b.cfg.db_file)
    b.primary = b.cfg.get("primary_persona")
    b.log = logging.getLogger("ledger-test")
    return b


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def test_ledger_flow(tmp_path=None):
    tmp = Path(tmp_path) if tmp_path is not None else Path(tempfile.mkdtemp(prefix="ledger-test-"))
    b = _brain(tmp)
    from brain import ledger as L

    # 1) 默认两本册子
    L.ensure(b)
    names = [x["name"] for x in L.books(b)]
    _check("惦记" in names and "当日琐碎" in names, "默认两本册子没建好")

    # 2) 逐句原话进底账（只进数据库，不写明文 jsonl 镜像）
    u1 = L.append_utterance(b, "p:test", b.primary, "user", "u1", "今天下大雨了，我还挺想你的")
    u2 = L.append_utterance(b, "p:test", b.primary, "assistant", "", "嗯，我也想你")
    u3 = L.append_utterance(b, "g:test", b.primary, "user", "u2", "群里今天好安静")
    _check(all([u1, u2, u3]), "底账没写入")
    _check(len(L.recent_utterances(b, limit=10)) == 3, "底账没逐句记全")
    _check(not list(tmp.rglob("*.jsonl")), "话簿不该写任何明文 jsonl 镜像")

    # 3) 摘一句成条目：原话一字不改，冷热可解释
    e1 = L.add_entry(b, u1, why_kept="这句得留着")
    _check(e1["item"]["quote"] == "今天下大雨了，我还挺想你的", "原话被改了")
    _check(e1["item"]["state"] in ("热", "温", "冷"), "冷热没算")
    _check(bool(e1["item"]["hot_why"]), "没有热因")

    # 4) 她自己分配：改主体 / 一条可属多本 / 留痕
    L.set_entry(b, e1["id"], {"subject": "家里人", "books": ["惦记", "当日琐碎"], "why_kept": "改过的理由"}, "her")
    rows = L.list_entries(b)
    _check(rows and rows[0]["subject"] == "家里人", "她自己分配没生效")
    _check(len(rows[0]["books"]) == 2, "一句不能同时属两本")
    audits = b.db.q("SELECT action FROM ledger_audit WHERE entry_id=?", (e1["id"],))
    _check(any(a["action"] == "assign" for a in audits), "分配没留痕")

    # 5) 平时零触发零注入；触发时才查
    _check(L.wants(b, "今天吃啥")[0] is False, "平时不该触发查询")
    _check(L.wants(b, "还记得上次那句吗")[0] is True, "回忆词没触发")
    _check(L.for_context(b, "今天吃啥")[0] == "", "平时不该注入任何东西")

    txt, ids = L.for_context(b, "还记得下大雨那天吗")
    _check(txt == "" or ("话簿" in txt and len(txt) <= 700), "触发式注入格式/预算不对")
    _check(isinstance(ids, list), "命中 id 没返回")

    # 6) 按需检索：只给相关的，且有 LIMIT
    res = L.search(b, "大雨", strict=True)
    _check(any("大雨" in x["quote"] for x in res), "按需检索没找到相关句")
    _check(len(res) <= 6, "检索没受上限约束")
    _check(L.search(b, "完全不相关的词xyz", strict=True) == [], "无关词不该硬塞热句")

    # 6.5) 对话里一句「收进话簿」要真的写进去，不是只嘴上答应
    L.append_utterance(b, "p:test", b.primary, "assistant", "", "这句想留下来")
    txt2, ids2 = L.for_context(b, "把这句收进话簿，放惦记那本", chat="p:test")
    _check("收好了" in txt2, "收句指令没生效")
    _check(any(x["quote"] == "这句想留下来" for x in L.list_entries(b)), "收句没真写进账本")
    _check(L.for_context(b, "今天天气不错", chat="p:test")[0] == "", "平时仍应零注入")

    # 7) 她自己知道有这本账（写进人格卡，幂等；旧文案能自动升级）
    L.awareness(b)
    card = b.db.one("SELECT self_card FROM personas WHERE id=?", (b.primary,))
    _check(L.SELF_MARK in (card["self_card"] or ""), "她不知道有这本账")
    _check(L.awareness(b).get("already") is True, "自我认知应该幂等")
    _check(L.awareness_status(b) is True, "状态没同步")
    b.db.x("UPDATE personas SET self_card=? WHERE id=?",
           ("旧内容保留\n" + L.SELF_MARK + "：旧版文案，没有操作提示", b.primary))
    L.awareness(b)
    card2 = b.db.one("SELECT self_card FROM personas WHERE id=?", (b.primary,))
    _check(L.SELF_VER in (card2["self_card"] or ""), "旧版自我认知没升级")
    _check("旧内容保留" in (card2["self_card"] or ""), "升级时不该动人设卡别的内容")

    # 8) 每日回顾 + 导出，都落本地
    ec = L.echo(b, write_file=True)
    _check("每日回顾" in ec["text"], "每日回顾没生成")
    _check((tmp / "ledger" / ("echo-" + ec["day"] + ".txt")).exists(), "回顾没落本地")
    ex = L.export(b)
    _check(Path(ex["path"]).exists(), "导出没落地")

    # 9) 彻底删除：底账行、条目行、全文索引真删，只留不含内容的审计壳
    L.erase(b, e1["id"])
    _check(b.db.one("SELECT id FROM ledger_utterances WHERE id=?", (u1,)) is None, "彻底删除后底账行还在")
    _check(b.db.one("SELECT id FROM ledger_entries WHERE id=?", (e1["id"],)) is None, "彻底删除后条目行还在")
    _check(b.db.one("SELECT id FROM ledger_fts WHERE id=?", (e1["id"],)) is None, "彻底删除后全文索引还在")
    _check(not any("下大雨" in (a["detail"] or "") for a in b.db.q("SELECT detail FROM ledger_audit")), "审计里不该留原话")
    _check(not list(tmp.rglob("*.jsonl")), "删除也不该写 jsonl")

    b.db.close()
    return {"ok": True, "tmp": str(tmp)}




def test_ledger_raw_fallback(tmp_path=None):
    """回归：底账有原话但没有条目时，翻账本也要能翻到；只念叨账本时给状态句。"""
    tmp = Path(tmp_path) if tmp_path is not None else Path(tempfile.mkdtemp(prefix="ledger-raw-"))
    b = _brain(tmp)
    from brain import ledger as L
    L.ensure(b)
    _check(L.append_utterance(b, "system", b.primary, "user", "", "系统内部轮次") is None, "系统轮次没被过滤")
    L.append_utterance(b, "p:t", b.primary, "user", "u1", "今天下大雨了，我还挺想你的")
    L.append_utterance(b, "p:t", b.primary, "assistant", "", "嗯我也想你")
    _check(len(L.recent_utterances(b)) == 2, "底账应只有两句")
    _check(bool(L.recent_utterances(b)[0].get("ts_local")), "时间没本地化")
    _check(bool(L.search(b, "翻翻话簿", strict=True)), "底账回退失效：翻账本看到空的")
    _check(any("大雨" in x["quote"] for x in L.search(b, "还记得大雨吗", strict=True)), "关键词没命中底账")
    _check(L.search(b, "完全无关xyz", strict=True) == [], "无关词不该硬塞")
    txt, ids = L.for_context(b, "账本我还是没找到", chat="p:t")
    _check("已经自动收了 2 句" in txt, "状态兜底没生效")
    _check(ids == [], "状态句不该带条目 id")
    txt2, ids2 = L.for_context(b, "翻翻话簿", chat="p:t")
    _check("话簿" in txt2 and len(txt2) <= 700, "翻阅注入异常")
    _check(L.for_context(b, "今天吃啥", chat="p:t")[0] == "", "平时仍应零注入")
    b.db.close()
    return {"ok": True, "tmp": str(tmp)}


if __name__ == "__main__":
    print(test_ledger_flow())
    print(test_ledger_raw_fallback())
