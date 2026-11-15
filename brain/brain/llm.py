"""可选的 OpenAI 兼容大模型。没配置就返回 None，所有调用方都要能降级。"""
from __future__ import annotations
import json, logging
import httpx

log = logging.getLogger("brain.llm")


class LLM:
    def __init__(self, cfg):
        self.cfg = cfg

    @property
    def conf(self) -> dict:
        return self.cfg.get("llm") or {}

    @property
    def configured(self) -> bool:
        c = self.conf
        return bool(c.get("base_url") and c.get("model"))

    def _url(self) -> str:
        u = self.conf["base_url"].rstrip("/")
        return u if u.endswith("/chat/completions") else u + "/chat/completions"

    def chat(self, messages: list[dict], *, model: str | None = None, max_tokens=600, temperature=0.7, json_mode=False, timeout=None) -> str | None:
        if not self.configured:
            return None
        c = self.conf
        body = {"model": model or c["model"], "messages": messages, "max_tokens": max_tokens, "temperature": temperature}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        headers = {"content-type": "application/json"}
        if c.get("api_key"):
            headers["authorization"] = f"Bearer {c['api_key']}"
        try:
            r = httpx.post(self._url(), json=body, headers=headers, timeout=timeout or float(c.get("timeout") or 30))
            if r.status_code >= 400:
                raise RuntimeError(f"http{r.status_code}:{r.text[:120]}")
            d = r.json()
            return (d.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        except Exception as e:
            log.warning("LLM 调用失败：%s", e)
            raise

    def try_chat(self, *a, **k) -> str | None:
        try:
            return self.chat(*a, **k)
        except Exception:
            return None

    def try_json(self, system: str, user: str, **k) -> dict | None:
        txt = self.try_chat([{"role": "system", "content": system}, {"role": "user", "content": user}], json_mode=True, temperature=0, **k)
        if not txt:
            return None
        import re
        m = re.search(r"\{[\s\S]*\}", txt)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
