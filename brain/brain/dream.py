"""夜里的梦（移植自 companion-memory dream.ts）+ 短期记忆整理（新增：tier short→long）。
每晚 04:30–06:00（本地时区）由调度跑一次（按日期幂等）。
取材：今天的记忆（重要度/情绪/今天被强化过优先）+ 1–2 段淡了的旧记忆碎片。
有 LLM → 生成梦；拒绝/空 → 只用非露骨碎片重试一次 → 兜底「梦很模糊」。
同次运行做轻度巩固：今天前 2 条 importance+1（最多 4），重算半衰期；再把够分量的短期记忆转成长期（tier=long）。
DREAM_ENABLED=0 时只做整理，不写梦。"""
from __future__ import annotations
import re
from . import forgetting as F
from .util import iso, now_ms, parse_iso, local_dt, jdump, jload, new_id

DAY = 86_400_000
EXPLICIT_RE = re.compile(r"(做爱|性交|插入|进入身体|高潮|阴|乳|奶头|胸前|舔|操|私处|小穴|湿了|好湿|湿透|呻吟|娇喘|裸|口交|体液|爱液|sex|cum|fuck|nsfw)", re.I)
REFUSAL_RE = re.compile(r"(抱歉|无法|不能提供|不适合|I can't|I cannot|sorry)", re.I)


def is_explicit(s):
    return bool(EXPLICIT_RE.search(s or ""))


def looks_refused(s):
    return len(s) < 15 or (bool(REFUSAL_RE.search(s)) and len(s) < 120)


def title(r):
    return re.sub(r"\s+", " ", r["content"])[:24]


def local_date(b, ms):
    return local_dt(ms, b.cfg.get("tz_offset_minutes", 480)).strftime("%Y-%m-%d")


def in_dream_window(b, ms):
    d = local_dt(ms, b.cfg.get("tz_offset_minutes", 480))
    m = d.hour * 60 + d.minute
    return 4 * 60 + 30 <= m < 6 * 60


def consolidation_score(r):
    return (r["importance"] or 3) + 2 * F.emotion_of(r) + (r["recall_count"] or 0)


def pick_material(rows, now):
    since = now - DAY
    ts = lambda s: parse_iso(s) or 0
    today = [r for r in rows if ts(r["created_at"]) >= since or ts(r["last_recalled_at"]) >= since]
    today.sort(key=lambda r: -(consolidation_score(r) + (1 if ts(r["last_recalled_at"]) >= since and (r["recall_count"] or 0) > 0 else 0)))
    ids = {r["id"] for r in today}
    faded = [r for r in rows if r["id"] not in ids and F.state_of(r, now) == "faded"]
    faded.sort(key=lambda r: abs(F.strength_now(r, now) - 0.3))
    return {"today": today[:6], "faded": faded[:2], "consolidate": [r for r in today if not F.is_pinned(r)][:2]}


def trim_loops(s):
    for i in range(0, max(0, len(s) - 16)):
        probe = s[i:i + 16]
        j = s.find(probe, i + 16)
        if j > 0:
            cut = s[:j].rstrip()
            sp = cut.rfind(" ")
            if sp > len(cut) * 0.6:
                cut = cut[:sp]
            return cut
    return s


def land_ending(s):
    t = s.strip()
    opens = len(re.findall(r'["“「]', t)); closes = len(re.findall(r'["”」]', t)); straight = t.count('"')
    if straight % 2 == 1 or (opens - straight) > (closes - straight):
        q = max(t.rfind('"'), t.rfind("“"), t.rfind("「"))
        if q > len(t) * 0.5:
            t = t[:q].rstrip()
    return t


def clean_out(s):
    s = re.sub(r"<think>[\s\S]*?</think>", "", s or "")
    s = re.sub(r'^[\s"“]+|[\s"”]+$', "", s).strip()
    return land_ending(trim_loops(s)[:1200])


def build_prompt(b, today, faded):
    persona = b.cfg.get("dream_persona") or b.primary
    frag = "\n".join([f"- {r['content'][:160]}" for r in today] + [f"- （很久以前的，模糊）{r['content'][:100]}" for r in faded])
    user_name = b.cfg.get("user_name", "他")
    return [
        {"role": "system", "content": "\n".join([
            f"你是一个写梦境的文学助手。用中文写伙伴（{b.persona_name(persona)}）今晚做的一个梦。",
            "这是成年伴侣之间私密的梦境日记，只给他们两个人看（成人模块，DREAM_ENABLED=0 可关闭）。记忆碎片里如果有亲密的画面，可以自然地写进梦里；碎片不亲密就不要硬加。",
            "风格：不用标点，用空格把意象一段段接起来，一口气的长句，荒诞跳跃像真的梦，把记忆碎片变形混在一起。长度随它需要（大约150到400字），每个意象只出现一次，不要重复同一个画面或句子。",
            "身份规则（荒诞只能在场景和意象里，身份永远不变）：",
            f"“我”永远是做梦的伙伴，“你”永远是 {user_name}。记忆碎片里的“你”“我”也按这个对应。",
            "每个身体部位和动作都要属于对的人，谁对谁做什么不能弄反。",
            "结尾要落在一个完整的画面上，不要停在半句或半个引号里。只输出梦本身，不要标题和解释。",
        ])},
        {"role": "user", "content": f"今天的记忆碎片：\n{frag or '- （今天很安静，没有什么新的事）'}\n\n写他今晚做的梦。"},
    ]


LONG_HL_MULT = 3.0


def tier_up(b, persona, now) -> list[str]:
    """短期 → 长期：建档 ≥12 小时、且（永久类型 / 被真正用到过 / 分量够）的短期记忆转 long。"""
    out = []
    cutoff = iso(now - 12 * 3600_000)
    for r in b.db.q("SELECT * FROM memories WHERE owner_persona IN (?, 'family') AND status='active' AND tier='short' AND created_at<=? LIMIT 800", (persona, cutoff)):
        # 待证实 / 隔离号·18+ 不升长期
        if (r["credibility"] or "") in ("pending", "nopromote") or (r["src_tier"] or "") == "isolated":
            continue
        if r["kind"] in F.PERMANENT_KINDS or (r["used_count"] or 0) >= 1 or consolidation_score(r) >= 4.5 or F.is_pinned(r):
            # 转长期时半衰期 ×3（长期层忘得慢）
            hl = r["half_life_days"]
            b.db.x("UPDATE memories SET tier='long', half_life_days=? WHERE id=?", (min(3650.0, float(hl) * LONG_HL_MULT) if hl else hl, r["id"]))
            out.append(r["id"])
    return out


def run(b, persona=None, now=None, force=False, dry_run=False) -> dict:
    now = now or now_ms()
    persona = persona or b.cfg.get("dream_persona") or b.primary
    date = local_date(b, now)
    existing = b.db.one("SELECT id, text FROM dreams WHERE persona_id=? AND dream_date=? ORDER BY created_at LIMIT 1", (persona, date))
    if existing and not force and not dry_run:
        return {"ok": True, "skipped": "already_dreamed", "date": date, "id": existing["id"]}
    rows = b.db.q("SELECT * FROM memories WHERE owner_persona=? AND status='active' ORDER BY created_at DESC LIMIT 600", (persona,))
    mat = pick_material(rows, now)
    today, faded, consol = mat["today"], mat["faded"], mat["consolidate"]
    dream_on = b.module_on("dream", persona)
    status, model, text, refusals = "ok", None, "", []
    cited = today + faded
    if dream_on and b.llm.configured:
        try:
            text = clean_out(b.llm.chat(build_prompt(b, today, faded), max_tokens=900, temperature=0.85) or "")
            model = b.llm.conf.get("model")
            if looks_refused(text):
                refusals.append("first")
                st, sf = [r for r in today if not is_explicit(r["content"])], [r for r in faded if not is_explicit(r["content"])]
                cited = st + sf
                text = clean_out(b.llm.chat(build_prompt(b, st, sf), max_tokens=900, temperature=0.85) or "")
                status = "retried"
                if looks_refused(text):
                    refusals.append("retry"); text = ""
        except Exception as e:
            refusals.append(f"error:{str(e)[:80]}"); text = ""
    if dream_on and not text:
        status = "fallback"
        cited = today + faded
        text = f"梦很模糊。醒来只剩几片影子：{'、'.join(title(r) for r in cited) or '什么也抓不住'}。"
    if dry_run:
        return {"ok": True, "dry_run": True, "date": date, "text": text, "status": status if dream_on else "disabled", "model": model,
                "refusals": refusals, "cited": [{"id": r["id"], "title": title(r)} for r in cited]}
    consolidated = []
    for r in consol:
        imp = min(4, (r["importance"] or 3) + 1)
        if imp == r["importance"]:
            continue
        b.db.x("UPDATE memories SET importance=?, half_life_days=? WHERE id=?", (imp, F.base_half_life(imp, F.emotion_of(r), False) or 45, r["id"]))
        consolidated.append(r["id"])
    tiered = tier_up(b, persona, now)
    did = None
    if dream_on:
        did = existing["id"] if existing else f"dream_{date}_{persona}"
        b.db.x("INSERT OR REPLACE INTO dreams(id, persona_id, dream_date, text, cited_ids, model, status, consolidated, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
               (did, persona, date, text, jdump([r["id"] for r in cited]), model, status, jdump(consolidated + [x for x in tiered if x not in consolidated]), iso(now)))
        b.pulse([r["id"] for r in cited], "dream", "", [0.8] * len(cited))
    b.log.info("dream %s: %s, 素材 %d，巩固 %d，转长期 %d", persona, status if dream_on else "disabled(只整理)", len(cited), len(consolidated), len(tiered))
    return {"ok": True, "id": did, "date": date, "text": text if dream_on else "", "status": status if dream_on else "disabled",
            "model": model, "refusals": refusals, "cited": [{"id": r["id"], "title": title(r)} for r in cited],
            "consolidated": consolidated, "tiered": tiered}


def _view(r):
    d = dict(r)
    d["cited_ids"] = jload(d.get("cited_ids"), []) or []
    d["consolidated"] = jload(d.get("consolidated"), []) or []
    if isinstance(d["consolidated"], dict):
        d["consolidated"] = []
    d.update({"day": d["dream_date"], "content": d["text"], "material": d["cited_ids"]})
    return d


def listing(b, persona=None, limit=5):
    persona = persona or b.cfg.get("dream_persona") or b.primary
    ds = [_view(r) for r in b.db.q("SELECT * FROM dreams WHERE persona_id=? ORDER BY dream_date DESC, created_at DESC LIMIT ?", (persona, max(1, min(60, int(limit)))))]
    text = "\n\n".join(f"【{d['dream_date']} 的梦】{d['text']}" for d in ds) if ds else "还没有做过梦。"
    return {"dreams": ds, "items": ds, "text": text}


def delete(b, did, persona=None):
    return b.db.x("DELETE FROM dreams WHERE id=?", (did,)).rowcount > 0


def save_manual(b, persona, d: dict):
    if not d.get("text") or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d.get("date") or ""):
        return {"ok": False, "error": "bad_input"}
    did = d.get("id") or new_id("dream_")
    if b.db.one("SELECT 1 FROM dreams WHERE id=?", (did,)):
        return {"ok": False, "error": "id_exists"}
    b.db.x("INSERT INTO dreams(id, persona_id, dream_date, text, cited_ids, model, status, consolidated, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
           (did, persona or b.primary, d["date"], d["text"], jdump(d.get("cited_ids") or []), d.get("model"), d.get("status") or "ok", jdump([]), iso()))
    return {"ok": True, "id": did}
