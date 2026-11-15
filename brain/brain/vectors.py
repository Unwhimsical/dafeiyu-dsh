"""可选向量（默认关闭）。打开 config.vectors.enabled 且装了 sentence-transformers 才生效；
否则所有函数返回空，系统照常跑在 jieba+BM25 上。"""
from __future__ import annotations
import struct, threading
from .util import iso

_model = None
_lock = threading.Lock()
_failed = False


def _enabled(b) -> bool:
    return bool((b.cfg.get("vectors") or {}).get("enabled")) and not _failed


def _get_model(b):
    global _model, _failed
    if _model is not None or _failed:
        return _model
    with _lock:
        if _model is None and not _failed:
            try:
                from sentence_transformers import SentenceTransformer  # type: ignore
                _model = SentenceTransformer((b.cfg.get("vectors") or {}).get("model") or "BAAI/bge-small-zh-v1.5")
            except Exception as e:
                b.log.warning("向量模型加载失败，退回关键词检索：%s", e)
                _failed = True
    return _model


def _pack(v):
    return struct.pack(f"{len(v)}f", *v)


def _unpack(bs):
    return struct.unpack(f"{len(bs) // 4}f", bs)


def embed(b, texts):
    m = _get_model(b)
    if not m:
        return None
    return [list(map(float, x)) for x in m.encode(texts, normalize_embeddings=True)]


def ensure(b, ids=None, max_n=64):
    if not _enabled(b):
        return 0
    rows = b.db.q("SELECT m.id, m.content FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id=m.id WHERE e.memory_id IS NULL LIMIT ?", (max_n,))
    if not rows:
        return 0
    vs = embed(b, [r["content"][:1000] for r in rows])
    if not vs:
        return 0
    b.db.many("INSERT OR REPLACE INTO memory_embeddings(memory_id, model, dim, vec, updated_at) VALUES (?,?,?,?,?)",
              [(r["id"], "bge", len(v), _pack(v), iso()) for r, v in zip(rows, vs)])
    return len(rows)


def _cos(a, c):
    return sum(x * y for x, y in zip(a, c))


def search(b, q, ids, top=6):
    if not _enabled(b) or not q or not ids:
        return []
    ensure(b)
    qv = embed(b, [q])
    if not qv:
        return []
    qv = qv[0]
    ph = ",".join("?" * len(ids))
    res = [(r["memory_id"], _cos(qv, _unpack(r["vec"]))) for r in b.db.q(f"SELECT memory_id, vec FROM memory_embeddings WHERE memory_id IN ({ph})", ids)]
    return sorted(res, key=lambda x: -x[1])[:top]


def similar(b, mid, top=4):
    if not _enabled(b):
        return []
    ensure(b)
    me = b.db.one("SELECT vec FROM memory_embeddings WHERE memory_id=?", (mid,))
    if not me:
        return []
    v = _unpack(me["vec"])
    rows = b.db.q("SELECT e.memory_id, e.vec, m.id, m.owner_persona, m.tags, m.seg, m.created_at, m.origin_chat FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id WHERE e.memory_id<>?", (mid,))
    res = [(r, _cos(v, _unpack(r["vec"]))) for r in rows]
    return [(r, s) for r, s in sorted(res, key=lambda x: -x[1])[:top] if s >= 0.55]
