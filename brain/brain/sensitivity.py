"""18+ 敏感度：写入时打 nsfw 标签，读/展示时统一过滤。

规则（保留用户原有的两套词表：views.ADULT_RE + dream.EXPLICIT_RE 里的多字词，单字词容易误伤“阴天/乳酪”所以不收）：
- 写入：内容命中成人词、或 kind/来源是 body/desire、或调用方显式带 nsfw/adult/18+ 标签 → tags 里加 "nsfw"。
- 召回：只有 adult_chat_ok(chat)（默认 = owner_chat，主人 QQ 私聊）才召回 nsfw 记忆；其他会话一律剔除。
- 展示：工作台/星图/统计/导出等展示接口默认把 nsfw 条目整条剔掉；
  只有 config.adult_reveal=true（主人手动打开，默认关）且请求带 include_adult=1 才显示。
"""
from __future__ import annotations
import re

ADULT_RE = re.compile(
    r"湿润|湿了|湿透|好湿|高潮|情欲|做爱|性交|口交|插进|插入身体|进入身体|腿间|乳头|奶头|自慰|内裤|呻吟|娇喘|色情|上床|小穴|肉棒|阴道|阴茎|淫|射了|爱液|体液|私处|nsfw",
    re.I)
TAG_WORDS = ("nsfw", "adult", "18+", "成人")
ADULT_KINDS = {"body", "desire"}
ADULT_DIMS = {"情欲"}   # 18+ 情绪维度：只在主人视角（include_adult）里出现
TEXT_KEYS = ("content", "text", "summary", "title", "body", "note", "mood", "trigger_text", "reply", "extra", "inner_cause", "cause", "reason", "desc", "line", "snippet")
HIDDEN = "（18+ 内容已隐藏）"


def is_adult_text(s) -> bool:
    return bool(s) and bool(ADULT_RE.search(str(s)))


def _tag_blob(tags) -> str:
    if isinstance(tags, (list, tuple, set)):
        return " ".join(str(t) for t in tags).lower()
    return str(tags or "").lower()


def has_adult_tag(tags) -> bool:
    blob = _tag_blob(tags)
    return any(w in blob for w in TAG_WORDS)


def mark_tags(content: str, tags: list, kind: str = "", source: str = "") -> list:
    """写入时调用：需要时在 tags 里补上 nsfw（不改用户写的其它标签）。"""
    tags = list(tags or [])
    if "nsfw" in [str(t).lower() for t in tags]:
        return tags
    if has_adult_tag(tags) or is_adult_text(content) or str(kind) in ADULT_KINDS or str(source) in ADULT_KINDS:
        tags.append("nsfw")
    return tags


def _get(r, k):
    try:
        if isinstance(r, dict):
            return r.get(k)
        return r[k] if k in r.keys() else None
    except Exception:
        return None


def is_adult_row(r) -> bool:
    """记忆行 / 视图 dict 通用判断。"""
    if has_adult_tag(_get(r, "tags")) or has_adult_tag(_get(r, "meta")):
        return True
    return any(is_adult_text(_get(r, k)) for k in TEXT_KEYS if isinstance(_get(r, k), str))


def reveal_allowed(cfg, flag) -> bool:
    """主人手动打开 adult_reveal（默认关）且这次请求明确要看，才显示。"""
    try:
        on = bool(cfg.get("adult_reveal", False))
    except Exception:
        on = False
    return on and str(flag or "").lower() in ("1", "true", "yes")


def scrub(obj, _depth=0):
    """递归过滤 JSON：列表里的 18+ 条目整条剔掉；不在列表里的 18+ 文本字段换成占位。"""
    if _depth > 12:
        return obj
    if isinstance(obj, list):
        out = []
        for x in obj:
            if isinstance(x, dict) and is_adult_row(x):
                continue
            if isinstance(x, str) and is_adult_text(x):
                continue
            out.append(scrub(x, _depth + 1))
        return out
    if isinstance(obj, dict):
        d = {}
        for k, v in obj.items():
            if isinstance(v, str) and k in TEXT_KEYS and is_adult_text(v):
                d[k] = HIDDEN
            else:
                d[k] = scrub(v, _depth + 1)
        return d
    return obj
