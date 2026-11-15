"""溢出日志（spill）：每轮对话追加一行 jsonl，单文件超过 spill_rotate_chars（默认 40000 字）就换新文件。
spill 是第 5 个检索源：只有用户提到「上次/之前/那天/上回/以前/还记得…」时才去翻。
隐私：spill 是原始对话，只在**同一个会话**里能被翻到（管理员视角除外）。
兼容旧格式：字段名容忍 ts/time/at/created_at、chat/chat_id/group_id/user_id、role、text/content/message/msg。"""
from __future__ import annotations
import json, os, re, glob
from pathlib import Path
from . import textutil as T
from .util import iso, now_ms, local_dt, first, clip, parse_iso
from .privacy import norm_chat

TRIGGER = re.compile(r"(上次|之前|那天|上回|以前|还记得|记不记得|那次|前几天|前阵子|上个月|上周|昨天说)")


def _dir(b) -> Path:
    d = Path(b.cfg.spill_path)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _today(b):
    return local_dt(now_ms(), b.cfg.get("tz_offset_minutes", 480)).strftime("%Y-%m-%d")


def current_file(b) -> Path:
    d, day = _dir(b), _today(b)
    limit = int(b.cfg.get("spill_rotate_chars", 40000))
    base = d / f"spill-{day}.jsonl"
    n, f = 1, base
    while f.exists():
        try:
            size = len(f.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            size = 0
        if size < limit:
            return f
        n += 1
        f = d / f"spill-{day}-{n}.jsonl"
    return f


def append(b, chat, role, text, user_id="", persona="", extra=None):
    text = (text or "").strip()
    if not text:
        return None
    rec = {"ts": iso(), "chat": chat, "role": role, "user_id": str(user_id or ""), "persona": persona, "text": text}
    if extra:
        rec.update({k: v for k, v in extra.items() if k not in rec})
    f = current_file(b)
    with open(f, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return str(f)


def parse_line(line: str) -> dict | None:
    line = line.strip()
    if not line:
        return None
    try:
        d = json.loads(line)
    except Exception:
        return {"ts": None, "chat": "", "role": "user", "text": line[:2000]} if len(line) > 2 else None
    if not isinstance(d, dict):
        return None
    text = first(d, "text", "content", "message", "msg", "reply")
    if isinstance(text, list):
        text = " ".join(str(x.get("text", x)) if isinstance(x, dict) else str(x) for x in text)
    if not text:
        return None
    chat = first(d, "chat", "chat_id", "session", default="")
    if not chat:
        g, u = first(d, "group_id", "group"), first(d, "user_id", "uid", "qq")
        if g or u:
            chat = norm_chat(None, group_id=g, user_id=u)
    elif not re.match(r"^[pg]:", str(chat)):
        chat = norm_chat(str(chat), is_group=bool(d.get("is_group")))
    ts = first(d, "ts", "time", "at", "created_at", "timestamp")
    ms = parse_iso(ts)
    return {"ts": iso(ms) if ms else None, "chat": chat or "", "role": str(first(d, "role", "from", default="user")), "text": str(text)[:4000]}


def index(b, full=False) -> dict:
    """把 spill 目录下所有 jsonl 增量索引进 spill_index。"""
    added, files = 0, 0
    for fp in sorted(glob.glob(str(_dir(b) / "spill-*.jsonl"))):
        files += 1
        key = f"spill_off:{os.path.basename(fp)}"
        r = b.db.one("SELECT v FROM meta WHERE k=?", (key,))
        start = 0 if full or not r else int(r["v"])
        try:
            with open(fp, encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
        except OSError:
            continue
        batch = []
        for i in range(start, len(lines)):
            d = parse_line(lines[i])
            if d:
                batch.append((os.path.basename(fp), i, d["chat"], d["role"], d["ts"], d["text"], T.seg_text(d["text"])))
        if batch:
            b.db.many("INSERT OR IGNORE INTO spill_index(file, line_no, chat_id, role, ts, text, seg) VALUES (?,?,?,?,?,?,?)", batch)
            added += len(batch)
        b.db.x("INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)", (key, str(len(lines))))
    return {"files": files, "indexed": added, "total": b.db.one("SELECT COUNT(*) c FROM spill_index")["c"]}


def wants(query: str) -> bool:
    return bool(TRIGGER.search(query or ""))


def search(b, query: str, chat: str | None, limit=3, force=False, min_hits=2) -> list[dict]:
    """chat=None → 管理员视角（全部）；否则只翻同一会话的 spill。"""
    if not force and not wants(query):
        return []
    toks = [t for t in T.tokens(TRIGGER.sub(" ", query or "")) if t]
    if not toks:
        return []
    try:
        index(b)
    except Exception as e:
        b.log.debug("spill index 失败：%s", e)
    where, ps = ("WHERE chat_id=?", [chat]) if chat else ("", [])
    rows = b.db.q(f"SELECT * FROM spill_index {where} ORDER BY id DESC LIMIT 4000", ps)
    if not rows:
        return []
    res = T.bm25([(r["seg"] or "").split() for r in rows], toks)
    out = []
    for r, (s, hits) in zip(rows, res):
        if len(hits) >= min(min_hits, len(toks)) and s > 0:
            out.append({"id": f"spill:{r['id']}", "score": round(s, 3), "hits": hits, "via": "spill", "chat_id": r["chat_id"], "role": r["role"], "ts": r["ts"],
                        "content": r["text"], "file": r["file"], "line_no": r["line_no"]})
    out.sort(key=lambda x: (-x["score"], x["ts"] or ""))
    return out[:limit]


def files(b) -> list[dict]:
    out = []
    for fp in sorted(glob.glob(str(_dir(b) / "spill-*.jsonl")), reverse=True):
        st = os.stat(fp)
        out.append({"name": os.path.basename(fp), "size": st.st_size, "mtime": iso(st.st_mtime * 1000)})
    return out
