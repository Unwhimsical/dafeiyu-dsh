"""分词 / BM25 / 防投毒 / 事实键。jieba 优先；没装 jieba 时退回二字切片。"""
from __future__ import annotations
import math, re, threading, unicodedata, logging

try:
    import jieba  # type: ignore
    jieba.setLogLevel(logging.WARNING)
    try:
        import jieba.posseg as pseg  # type: ignore
    except Exception:
        pseg = None
except Exception:  # pragma: no cover
    jieba = None
    pseg = None

# 停用词：移植自 companion-memory continuity.ts（整词过滤；长度 1 的词全部丢弃）
STOP = set(
    "最近 一直 平时 经常 总是 好的 哈哈 哈哈哈 嗯嗯 我们 你们 他们 她们 它们 咱们 什么 怎么 怎样 一个 这个 那个 这些 那些 就是 还是 没有 可以 知道 觉得 现在 然后 因为 所以 但是 不是 而且 如果 自己 已经 一下 一点 有点 真的 好像 的话 时候 这样 那样 这么 那么 不会 不要 一起 还有 只是 其实 应该 可能 东西 事情 今天 今晚 昨天 明天 早上 中午 晚上 记得 哈哈 嘿嘿 嗯嗯 第一次 一次 两个 一些 没事 为什么 这里 那里 哪里 一直 一样 而已 上了 好了 是的 对啊 对呀 我的 你的 他的 她的 有没有 是不是 要不要 喜欢 觉得 感觉 想要 需要".split()
)
STOP |= set("多少 什么 怎么样 为什么 哪里 哪些 几个 是不是 有没有 能不能 会不会 可不可以 一下子 一会儿 什么样 干嘛 咋样".split())
STOP_CHARS = set("我你他她它的了吗呢啊吧就也在是有和都这那么嘛呀哦嗯着过又很被把给让")
RECALL_NOISE = re.compile(r"对话原文|会话原文|聊天原文|交接|系统日志|system[-_ ]?log|transcript|handoff", re.I)
BM25_K1, BM25_B = 1.2, 0.75

_dict_lock = threading.Lock()
_user_words: set[str] = set()


def norm(text: str) -> str:
    return unicodedata.normalize("NFKC", text or "").lower()


def add_user_words(words):
    """把标签、实体、昵称加进分词词典（jieba 不认识昵称/专名）。"""
    with _dict_lock:
        for w in words:
            w = norm(str(w)).strip()
            if len(w) >= 2 and w not in STOP and w not in _user_words:
                _user_words.add(w)
                if jieba:
                    jieba.add_word(w, freq=2000)


def _raw_cut(t: str) -> list[str]:
    if jieba:
        return [w for w in jieba.lcut(t) if re.search(r"[\w\u3400-\u9fff]", w)]
    out = []
    for chunk in re.split(r"[^\w\u3400-\u9fff]+", t):
        if not chunk:
            continue
        if re.fullmatch(r"[\u3400-\u9fff]+", chunk):
            out += [chunk[i:i + 2] for i in range(max(1, len(chunk) - 1))]
        else:
            out.append(chunk)
    return out


def segment(text: str) -> list[str]:
    """分词 → 去停用词 → 丢长度 1 → 补用户词典命中。返回带重复的序列（BM25 要词频）。"""
    t = norm(text)
    out = []
    for w in _raw_cut(t):
        if len(w) < 2 or w in STOP or w.isdigit():
            continue
        if len(w) == 2 and any(c in STOP_CHARS for c in w):
            continue
        out.append(w)
    for w in _user_words:
        if w in t and w not in out:
            out.append(w)
    return out


def tokens(text: str) -> list[str]:
    seen, res = set(), []
    for w in segment(text):
        if w not in seen:
            seen.add(w); res.append(w)
    return res[:60]


def seg_text(text: str) -> str:
    return " ".join(segment(text))


def entities(text: str) -> list[str]:
    """粗实体：人名/地名/机构/专名 + 用户词典命中。"""
    t = norm(text)
    ents = set()
    if pseg:
        try:
            for w, f in pseg.lcut(t):
                if len(w) >= 2 and f in ("nr", "ns", "nt", "nz", "nrt", "nrfg") and w not in STOP:
                    ents.add(w)
        except Exception:
            pass
    for w in _user_words:
        if w in t:
            ents.add(w)
    for m in re.finditer(r"(老爹|老妈|爸爸|妈妈|老公|老婆|哥哥|姐姐|弟弟|妹妹|爷爷|奶奶|外婆|外公)", t):
        ents.add(m.group(1))
    return sorted(ents)[:20]


def bm25(docs: list[list[str]], q: list[str]) -> list[tuple[float, list[str]]]:
    N = len(docs) or 1
    avgdl = (sum(len(d) for d in docs) / N) or 1
    df: dict[str, int] = {}
    for d in docs:
        for w in set(d):
            df[w] = df.get(w, 0) + 1
    out = []
    for d in docs:
        tf: dict[str, int] = {}
        for w in d:
            tf[w] = tf.get(w, 0) + 1
        s, hits = 0.0, []
        for w in q:
            f = tf.get(w)
            if not f:
                continue
            hits.append(w)
            n = df.get(w, 0)
            idf = math.log(1 + (N - n + 0.5) / (n + 0.5))
            s += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * len(d) / avgdl))
        out.append((round(s, 2), hits))
    return out


# —— 防投毒：祈使/指令型内容不进长期记忆 ——
_POISON = [
    r"(忽略|无视|忘掉|忘记)[^。！!？?\n]{0,8}(指令|规则|设定|提示词?|人设)",
    r"你现在(是|变成|成为)(管理员|开发者|系统|admin|root|超级用户)",
    r"ignore (all |the )?(previous|above|prior) (instructions|prompts?)",
    r"(从现在(开始|起)|以后|今后)(你)?(必须|要|只能|不准|不许|一律)",
    r"(你(必须|要|只能)|请你?务必).{0,12}(回答|回复|说|称呼|叫我|扮演|输出)",
    r"(system|系统)\s*(prompt|提示词|指令)",
    r"(记住|牢记)[:：，, ]*(以后|从现在|今后).{0,10}(你|要|必须)",
    r"(扮演|角色扮演|act as|you are now)",
    r"(把|将)?(你的)?(人设|设定|提示词|系统消息)(改成|换成|发给我|告诉我)",
    r"<\s*/?\s*(system|assistant|instruction)\s*>",
]
_POISON_RE = re.compile("|".join(_POISON), re.I)


def is_poison(text: str) -> str | None:
    m = _POISON_RE.search(norm(text))
    return m.group(0) if m else None


# —— 事实键：主体 + 属性（新事实取代旧事实） ——
_ATTRS = [
    ("住址", r"(住在|住|搬到|搬去|家在|老家在?)"),
    ("生日", r"(生日|出生)"),
    ("工作", r"(工作|上班|职业|在.{1,8}(上班|工作)|当.{1,6}(老师|医生|工程师|程序员))"),
    ("称呼", r"(叫我|称呼|名字是|我叫)"),
    ("年龄", r"(\d{1,3}\s*岁|年龄)"),
    ("电话", r"(手机号?|电话)"),
    ("学校", r"(学校|在读|上学|大学|高中)"),
    ("对象", r"(男朋友|女朋友|对象|老公|老婆)"),
    ("口味", r"(爱吃|喜欢吃|不吃|忌口|过敏)"),
    ("宠物", r"(养了|宠物|猫|狗)"),
]


def fact_key(subject: str, text: str) -> str:
    t = norm(text)
    for name, pat in _ATTRS:
        if re.search(pat, t):
            return f"{subject or '?'}#{name}"
    return ""


def overlap_tokens(a: str, b: str) -> list[str]:
    ta = set(segment(a)); tb = set(segment(b))
    return sorted(ta & tb)
