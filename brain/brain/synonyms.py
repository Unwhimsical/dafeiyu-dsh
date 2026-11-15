"""口语扩写 / 同义词：把「还记得我最喜欢吃什么吗」这种自然问句补成能检索的词。

jieba 分词 + 停用词表会把这类句子切得只剩 1 个字，于是 tokens 为空、候选为 0。
这里补两层：
  1) 概念表：命中某个问法就补一组通用关键词
  2) 别名表：口语称呼 ↔ 通用称呼（妈→老妈、爹→老爹…）
  3) 兜底：抽 3 字片段给 FTS trigram 用
只做「加法」，不改原分词结果；调用方只在**原始召回为空**时才用，避免污染精度。
"""
from __future__ import annotations
import re
from .textutil import norm, STOP

# 同义/别名：口语 → 记忆里真实可能出现的写法
ALIAS: dict[str, list[str]] = {
    "妈": ["老妈"], "妈妈": ["老妈"], "母亲": ["老妈"], "娘": ["老妈"], "妈咪": ["老妈"],
    "爹": ["老爹"], "爸爸": ["老爹"], "父亲": ["老爹"], "老爸": ["老爹"], "爹地": ["老爹"],
    "姐": ["姐姐"], "姐姐": ["姐姐"],
    "对象": ["对象"], "宠物": ["猫", "狗", "宠物"],
}

# 问法 → 补充关键词（都要是长度>=2 的实词，能出现在记忆原文里）
CONCEPTS: list[tuple[str, list[str]]] = [
    (r"(喜欢|爱吃|喜欢吃|想吃|爱吃啥|吃啥|吃什么|口味|本命|最馋|好哪口)", ["喜欢", "爱吃", "口味", "白米饭", "红烧肉"]),
    (r"(记得|想起|回忆|忘没忘|还记得)", ["记得", "回忆"]),
    (r"(余额|多少钱|剩多少|还有多少钱|钱够|欠费|额度)", ["余额", "余额还有"]),
    (r"(名字|叫什么|昵称|称呼|怎么叫)", ["名字", "昵称", "叫我"]),
    (r"(生日|几岁|多大|年龄)", ["生日", "年龄"]),
    (r"(住哪|住在|家在|搬家|搬到)", ["住", "搬到"]),
    (r"(群|群里|群聊|群友)", ["群", "群聊", "群友"]),
    (r"(抖音|短视频|刷视频)", ["抖音", "视频"]),
    (r"(表情包|贴纸|表情)", ["表情", "表情包"]),
    (r"(语音|声音|嗓子|说话声)", ["语音", "声音"]),
    (r"(心情|情绪|感觉怎么样|开心吗)", ["开心", "心情", "情绪"]),
    (r"(生气|发火|吵架|凶)", ["生气", "吵架"]),
    (r"(qq|扣扣)", ["QQ"]),
    (r"(工作|上班|职业)", ["工作", "上班"]),
]


NOISE_FRAG = ["什么","多少","怎么","怎样","这个","那个","我们","你们","他们","还有","没有","可以","一个","是不","不是","是不","时候","现在","觉得","知道","喜欢"]

def _alias_terms(t: str) -> list[str]:
    out = []
    for k, vs in ALIAS.items():
        if k in t:
            out.extend(vs)
    return out


def _concept_terms(t: str) -> list[str]:
    out = []
    for pat, words in CONCEPTS:
        if re.search(pat, t):
            out.extend(words)
    return out


def expand(text: str) -> list[str]:
    """返回补充检索词（去重、去停用词、保持顺序）。"""
    t = norm(text)
    seen, out = set(), []
    for w in _alias_terms(t) + _concept_terms(t):
        w = norm(w).strip()
        if len(w) < 2 or w in STOP or w in seen:
            continue
        seen.add(w)
        out.append(w)
    return out[:14]


def ngrams(text: str, n: int = 3, limit: int = 6) -> list[str]:
    """给 FTS trigram 兜底的连续片段：只要中文/字母，去掉纯停用字符的片段。"""
    t = norm(text)
    chunks = re.findall(r"[\u3400-\u9fffA-Za-z0-9]{3,}", t)
    out: list[str] = []
    for c in chunks:
        for i in range(0, max(1, len(c) - n + 1)):
            frag = c[i:i + n]
            if len(frag) != n or frag in out:
                continue
            if any(w in frag for w in NOISE_FRAG):
                continue
            out.append(frag)
            if len(out) >= limit:
                return out
    return out
