"""思考事件流（只给星图「思考动画」用）。

每次 /activate（或 /recall）真正召回到记忆时，记一条事件：焦点（第一条命中）+ 其他命中 + 联想 + 自发浮现。
- 只存在内存里（环形缓冲，默认 200 条），不写库、不落盘，重启就清空。
- 事件里只有记忆 id 和时间，没有聊天内容、没有 chat_id、没有原文。
- 读取时按 chat / persona 做和 /api/atlas 完全一样的可见性过滤：看不到的 id 直接去掉，全部看不到的事件整条不返回。
"""
from __future__ import annotations

import collections
import threading

from .util import iso, now_ms


class ThinkFeed:
    def __init__(self, maxlen: int = 200):
        self.buf: collections.deque = collections.deque(maxlen=max(10, int(maxlen)))
        self.seq = 0
        self.lock = threading.Lock()

    def record(self, hits, assoc=(), spont=None, source: str = "activate", persona: str | None = None) -> int | None:
        def clean(xs):
            out = []
            for x in xs or ():
                x = str(x or "")
                if x and not x.startswith("spill:") and x not in out:
                    out.append(x)
            return out
        hits, assoc = clean(hits), clean(assoc)
        assoc = [x for x in assoc if x not in hits]
        sp = str(spont) if spont and not str(spont).startswith("spill:") and spont not in hits and spont not in assoc else None
        if not hits and not assoc and not sp:
            return None
        t = now_ms()
        with self.lock:
            self.seq += 1
            self.buf.append({"seq": self.seq, "at_ms": t, "at": iso(t), "source": source, "persona": persona,
                             "hits": hits[:12], "assoc": assoc[:12], "spontaneous": sp})
            return self.seq

    def since(self, since: int = 0, limit: int = 20) -> tuple[int, list]:
        with self.lock:
            last = self.seq
            evs = [dict(e) for e in self.buf if e["seq"] > since]
        return last, evs[-max(1, limit):]


def visible_ids(b, ids, chat: str | None, persona: str | None) -> set:
    """和 memory.visible_rows（/api/atlas 用的那个）同一套规则：status=active + 人格过滤 + privacy.visible_sql。"""
    ids = [i for i in dict.fromkeys(ids) if i]
    if not ids:
        return set()
    vis, vp = b.privacy.visible_sql(chat, "m")
    pf, pp = ("AND m.owner_persona IN (?, 'family')", [persona]) if persona else ("", [])
    q = f"SELECT m.id FROM memories m WHERE m.status='active' {pf} AND {vis} AND m.id IN ({','.join('?' * len(ids))})"
    return {r["id"] for r in b.db.q(q, pp + vp + ids)}


def feed(b, since: int = 0, limit: int = 20, chat: str | None = None, persona: str | None = None) -> dict:
    last, evs = b.think.since(since, max(1, min(100, limit)))
    ok = visible_ids(b, [i for e in evs for i in e["hits"] + e["assoc"] + ([e["spontaneous"]] if e["spontaneous"] else [])], chat, persona)
    out = []
    for e in evs:
        h = [i for i in e["hits"] if i in ok]
        a = [i for i in e["assoc"] if i in ok]
        s = e["spontaneous"] if e["spontaneous"] in ok else None
        focal = h[0] if h else (a[0] if a else s)
        if not focal:
            continue
        out.append({"seq": e["seq"], "at": e["at"], "source": e["source"], "focal": focal,
                    "hits": [i for i in h if i != focal], "assoc": [i for i in a if i != focal], "spontaneous": s if s != focal else None})
    return {"ok": True, "last_seq": last, "events": out}
