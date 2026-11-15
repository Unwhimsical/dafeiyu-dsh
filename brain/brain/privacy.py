"""隐私：privacy.json 热加载 + 统一的 visible_to(chat) SQL 过滤 + 出站防泄漏。

chat_id 规范化：私聊 = "p:<QQ>"，群聊 = "g:<群号>"。
privacy.json:
{
  "default_private": "private",               // 没写的私聊默认策略（安全起见默认 private）
  "default_group": "public",                  // 没写的群默认策略（群里说的话群里人都听见了）
  "private_chats": {"10001": "private"},      // 私聊策略：private / scoped / public
  "groups": {"20001": {"can_see": ["10001"], "policy": "public"}}  // 该群能看见哪些私聊的 scoped 记忆；群本身的策略
}
记忆的 scope 列：inherit（默认，跟随来源会话的当前策略，改 privacy.json 立即生效）/ private / scoped / public（手动覆盖）。
"""
from __future__ import annotations
import json, os, re, threading
from pathlib import Path
from .util import atomic_write_text, jdump
from . import textutil

DEFAULT_PRIVACY = {"default_private": "private", "default_group": "public", "private_chats": {}, "groups": {},
                   "guard": {"enabled": True, "allow_phrases": []}}
STRICT = {"public": 0, "scoped": 1, "private": 2, "inherit": -1}


def norm_chat(chat_id=None, *, group_id=None, user_id=None, is_group=None, message_type=None) -> str:
    """容错：接受 p:/g:/private:/group:/group_ 前缀；纯数字按 is_group 判断。"""
    if group_id not in (None, "", 0):
        return f"g:{group_id}"
    c = str(chat_id or "").strip()
    if not c:
        return f"p:{user_id}" if user_id not in (None, "") else "p:unknown"
    m = re.match(r"^(p|g|private|group|friend|qq)[:_\-](.+)$", c, re.I)
    if m:
        k = m.group(1).lower()
        return ("g:" if k in ("g", "group") else "p:") + m.group(2)
    if c.startswith(("system", "legacy", "mcp", "admin")):
        return c
    grp = bool(is_group) or (str(message_type or "").lower() == "group")
    return ("g:" if grp else "p:") + c


GROUP_TYPES = {"group", "g", "guild", "channel", "room", "群", "群聊", "discuss", "groupchat", "group_chat"}
QQ_PLATFORMS = {"", "qq", "onebot", "onebot11", "onebot12", "napcat", "llonebot", "lagrange", "go-cqhttp", "gocq", "aurabot"}


def _first(d, *keys):
    for k in keys:
        v = d.get(k)
        if v not in (None, "", 0):
            return v
    return None


def chat_from_payload(p: dict) -> str:
    """从机器人/OneBot/抖音事件里认出会话 id（隐私全靠它）。
    优先级：带前缀的 chat_id（p:/g:）> group_id（有就是群）> 不带前缀的 chat_id + 类型 > user_id（私聊）。
    类型字段：chat_type / message_type / detail_type / conversation_type / is_group。
    平台：platform=douyin 等非 QQ 平台时 id 自动加前缀（p:douyin_<id>），避免和 QQ 号撞号。
    标了群但拿不到群号时返回 g:unknown（绝不退化成发言人的私聊，防止群里召回私事）。"""
    p = p or {}
    plat = str(_first(p, "platform", "adapter", "source_platform") or "").strip().lower()
    pre = "" if plat in QQ_PLATFORMS else plat + "_"
    typ = str(_first(p, "chat_type", "chatType", "message_type", "messageType", "detail_type", "conversation_type") or "").strip().lower()
    isg = p.get("is_group")
    if isinstance(isg, str):
        isg = isg.strip().lower() in ("1", "true", "yes", "group")
    group = bool(isg) or typ in GROUP_TYPES
    chat = _first(p, "chat_id", "chatId", "chat", "session_id", "conversation_id")
    if chat is not None:
        c = str(chat).strip()
        if re.match(r"^(p|g|private|group|friend|qq)[:_\-]", c, re.I) or c.startswith(("system", "legacy", "mcp", "admin")):
            return norm_chat(c)
    gid = _first(p, "group_id", "groupId", "gid", "group_openid", "room_id", "guild_id")
    if gid is not None:
        return f"g:{pre}{gid}"
    if chat is not None:
        return ("g:" if group else "p:") + pre + str(chat).strip()
    if group:
        return "g:unknown"
    uid = _first(p, "user_id", "userId", "sender_id", "qq", "uid", "open_id", "openid", "sec_uid")
    if isinstance(uid, dict):
        uid = _first(uid, "user_id", "id")
    if uid is None and isinstance(p.get("sender"), dict):
        uid = _first(p["sender"], "user_id", "id", "open_id")
    return f"p:{pre}{uid}" if uid is not None else "p:unknown"


def bare(chat: str) -> str:
    return chat.split(":", 1)[1] if ":" in chat else chat


class Privacy:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._mtime = None
        self._lock = threading.RLock()
        self.data = dict(DEFAULT_PRIVACY)
        if not self.path.exists():
            self.save(DEFAULT_PRIVACY)
        self.reload(force=True)

    def reload(self, force=False):
        with self._lock:
            try:
                mt = self.path.stat().st_mtime_ns
            except FileNotFoundError:
                return
            if not force and mt == self._mtime:
                return
            try:
                d = json.loads(self.path.read_text(encoding="utf-8-sig"))
                merged = dict(DEFAULT_PRIVACY); merged.update(d or {})
                if isinstance(d, dict) and d.get("default") in ("private", "scoped", "public"):  # 旧写法：一个 default 管两种
                    merged.setdefault("default_private", d["default"])
                    if "default_private" not in d: merged["default_private"] = d["default"]
                    if "default_group" not in d: merged["default_group"] = d["default"]
                merged["private_chats"] = {str(k): v for k, v in (merged.get("private_chats") or {}).items()}
                merged["groups"] = {str(k): v for k, v in (merged.get("groups") or {}).items()}
                self.data = merged
                self._mtime = mt
            except Exception as e:
                print(f"[privacy] privacy.json 解析失败，沿用上一版：{e}")

    def save(self, d: dict):
        atomic_write_text(self.path, json.dumps(d, ensure_ascii=False, indent=2))
        self.reload(force=True)

    # —— 策略 ——
    def policy_of(self, origin: str) -> str:
        """来源会话的当前策略：public / scoped / private。"""
        self.reload()
        d = self.data
        if not origin or origin.startswith("legacy:unknown"):
            return "private"
        if origin.startswith("system"):
            return "public"
        b = bare(origin)
        if origin.startswith("p:"):
            v = d["private_chats"].get(b)
            return v if v in ("private", "scoped", "public") else self.default_for("p")
        if origin.startswith("g:"):
            g = d["groups"].get(b) or {}
            v = g.get("policy") if isinstance(g, dict) else None
            return v if v in ("private", "scoped", "public") else self.default_for("g")
        return "private"

    def default_for(self, kind: str) -> str:
        d = self.data
        v = d.get("default_private" if kind == "p" else "default_group") or d.get("default") or ("private" if kind == "p" else "public")
        return v if v in ("private", "scoped", "public") else "private"

    def can_see_list(self, chat: str) -> set[str]:
        """当前会话能看见哪些来源的 scoped 记忆（规范化成 p:/g:）。"""
        self.reload()
        out = set()
        if chat.startswith("g:"):
            g = self.data["groups"].get(bare(chat)) or {}
            for x in (g.get("can_see") or []) if isinstance(g, dict) else []:
                x = str(x)
                out.add(x if ":" in x else "p:" + x)
        return out

    def sealed(self) -> set[str]:
        """封存会话（主人 / 家人 / 隔离号的私聊）+ privacy.json 里手写的 sealed_chats。"""
        out = set()
        try:
            from .identity_sync import sealed_ids
            out |= set(sealed_ids())
        except Exception:
            pass
        # 主人 / 家人（privacy.json 的 person_map 里标了这些称呼的；旧称呼也认）：QQ 私聊和抖音私信都封存
        pm = self.data.get("person_map") or {}
        if isinstance(pm, dict):
            for qq, v in pm.items():
                if isinstance(v, dict) and str(v.get("label") or "").strip() in ("主人", "家人", "老爹", "老妈", "爸爸", "妈妈"):
                    if str(qq).strip().isdigit():
                        out.add("p:" + str(qq).strip())
                    dy = str(v.get("douyin") or "").strip()
                    if dy.isdigit():
                        out.add("p:" + dy)
        for x in (self.data.get("sealed_chats") or []):
            x = str(x)
            out.add(x if ":" in x else "p:" + x)
        return out

    # ---- 来源分层 + 群聊分寸 ----
    def owner_ids(self) -> set[str]:
        try:
            from .identity_sync import owner_ids
            return set(owner_ids())
        except Exception:
            return set()

    def isolated_ids(self) -> set[str]:
        try:
            from .identity_sync import isolated_ids
            return set(isolated_ids())
        except Exception:
            return set()

    def is_owner_chat(self, chat: str | None) -> bool:
        return bool(chat) and chat.startswith("p:") and bare(chat) in self.owner_ids()

    def is_stranger_private(self, chat: str | None) -> bool:
        """不是主人的私聊（也没写进 privacy.json trusted_private）= 陌生人私聊：群里的东西一概不带过去。"""
        if not chat or not chat.startswith("p:"):
            return False
        if self.is_owner_chat(chat):
            return False
        tp = {str(x if ":" in str(x) else "p:" + str(x)) for x in (self.data.get("trusted_private") or [])}
        return chat not in tp

    def src_tier(self, speaker: str, chat: str, source: str = "", tags=None) -> str:
        """owner / other / isolated / system。隔离号、18+ 永远不升格。"""
        sp = "".join(ch for ch in str(speaker or "") if ch.isdigit())
        chat = chat or ""
        t = tags if isinstance(tags, str) else " ".join(tags or [])
        iso_ = self.isolated_ids()
        if (chat.startswith("p:") and bare(chat) in iso_) or (sp and sp in iso_) or "nsfw" in t:
            return "isolated"
        own = self.owner_ids()
        if sp and sp in own:
            return "owner"
        if not sp and chat.startswith("p:") and bare(chat) in own:
            return "owner"
        if not sp and (chat.startswith("system") or source in ("persona", "mcp", "migrate", "seed", "system", "dream", "body", "api", "workbench")):
            return "system"
        return "other"

    def visible_sql(self, chat: str | None, alias: str = "m", discretion: bool = True) -> tuple[str, list]:
        """唯一的硬过滤。chat=None 表示管理员视角（全部可见）。
        封存会话产生的记忆，只有在同一会话里才可见（scope 写 public 也不行）。"""
        if chat is None:
            return "1=1", []
        self.reload()
        d = self.data
        a = alias + "." if alias else ""
        ex = {"p": {"private": [], "scoped": [], "public": []}, "g": {"private": [], "scoped": [], "public": []}}
        for k, v in d["private_chats"].items():
            if v in ex["p"]:
                ex["p"][v].append("p:" + k)
        for k, g in d["groups"].items():
            v = g.get("policy") if isinstance(g, dict) else None
            if v in ex["g"]:
                ex["g"][v].append("g:" + k)
        can_see = sorted(self.can_see_list(chat))
        params: list = []

        def inlist(xs):
            if not xs:
                return "('')"
            params.extend(xs)
            return "(" + ",".join("?" * len(xs)) + ")"

        parts = []
        # 1) 同一会话产生的永远可见（单独放，后面其余条件统一再加「不是封存会话」）
        same = f"{a}origin_chat = ?"; same_params = [chat]
        # 2) 手动 public
        parts.append(f"{a}scope = 'public'")
        # 3) 手动 scoped：allow 列里写了本会话（或裸号）
        parts.append(f"({a}scope = 'scoped' AND (instr({a}allow, ?) > 0 OR instr({a}allow, ?) > 0))")
        params += [f'"{chat}"', f'"{bare(chat)}"']
        # 4) inherit：跟随来源会话的当前策略
        inh_vis = [f"{a}origin_chat LIKE 'system%'"]
        for kind in ("p", "g"):
            if self.default_for(kind) == "public":
                nonpub = ex[kind]["private"] + ex[kind]["scoped"]
                inh_vis.append(f"({a}origin_chat LIKE '{kind}:%' AND {a}origin_chat NOT IN {inlist(nonpub)})")
            elif ex[kind]["public"]:
                inh_vis.append(f"{a}origin_chat IN {inlist(ex[kind]['public'])}")
        scoped_vis = [x for x in can_see if self.policy_of(x) == "scoped"]
        if scoped_vis:
            inh_vis.append(f"{a}origin_chat IN {inlist(scoped_vis)}")
        parts.append(f"({a}scope = 'inherit' AND (" + " OR ".join(inh_vis) + "))")
        # 手动 scoped 也认 privacy.json 的 can_see
        if can_see:
            parts.append(f"({a}scope = 'scoped' AND {a}origin_chat IN {inlist(can_see)})")
        sealed = sorted(self.sealed() - {chat})
        rest = "(" + " OR ".join(parts) + ")"
        if sealed:
            rest = f"({rest} AND COALESCE({a}origin_chat, '') NOT IN {inlist(sealed)})"
        if discretion and self.is_stranger_private(chat):   # 陌生人私聊里不出现任何群聊来源的记忆
            rest = f"({rest} AND COALESCE({a}origin_chat, '') NOT LIKE 'g:%')"
        return f"({same} OR {rest})", same_params + params

    def is_visible(self, row, chat: str | None) -> bool:
        """Python 侧同一套规则（用于 spill 等非 SQL 路径和测试对照）。"""
        if chat is None:
            return True
        origin = row["origin_chat"] or ""
        scope = row["scope"] or "inherit"
        if origin == chat:
            return True
        if origin in self.sealed():
            return False   # 封存会话只在本会话可见
        if origin.startswith("g:") and self.is_stranger_private(chat):
            return False   # 陌生人私聊不带群聊来源
        if scope == "public":
            return True
        if scope == "private":
            return False
        if scope == "scoped":
            allow = row["allow"] or "[]"
            return f'"{chat}"' in allow or f'"{bare(chat)}"' in allow or origin in self.can_see_list(chat)
        pol = self.policy_of(origin)
        if pol == "public":
            return True
        if pol == "scoped":
            return origin in self.can_see_list(chat)
        return False

    def effective(self, row) -> str:
        sc = row["scope"] or "inherit"
        return self.policy_of(row["origin_chat"] or "") if sc == "inherit" else sc

    # —— 出站防泄漏 ——
    def guard(self, db, chat: str, reply: str, context_text: str = "", persona: str | None = None) -> dict:
        self.reload()
        g = self.data.get("guard") or {}
        if g.get("enabled") is False or not reply:
            return {"ok": True, "blocked": False, "hits": []}
        allow = set(textutil.norm(x) for x in g.get("allow_phrases") or [])
        vis, vp = self.visible_sql(chat, "m", discretion=False)   # 群聊分寸不算「私密」，不拿它拦回复
        pfilter, pp = ("AND m.owner_persona IN (?, 'family')", [persona]) if persona else ("", [])
        hidden = db.q(f"SELECT id, content FROM memories m WHERE status='active' AND NOT {vis} {pfilter} ORDER BY created_at DESC LIMIT 3000", vp + pp)
        if not hidden:
            return {"ok": True, "blocked": False, "hits": []}
        visible = db.q(f"SELECT content FROM memories m WHERE status='active' AND {vis} {pfilter} ORDER BY created_at DESC LIMIT 3000", vp + pp)
        known = set()
        for r in visible:
            known.update(textutil.segment(r["content"]))
        known.update(textutil.segment(context_text))
        rtoks = set(textutil.segment(reply))
        hits = []
        for r in hidden:
            toks = set(textutil.segment(r["content"]))
            secret = {t for t in toks if t not in known and t not in allow and len(t) >= 2}
            inter = sorted(secret & rtoks)
            if len(inter) >= 2 or any(len(t) >= 4 for t in inter):
                hits.append({"memory_id": r["id"], "phrases": inter[:6]})
        return {"ok": not hits, "blocked": bool(hits), "hits": hits[:10]}
