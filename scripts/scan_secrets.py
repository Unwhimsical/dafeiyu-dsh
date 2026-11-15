#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
大肥鱼仓库脱敏扫描器 / Secret & privacy scanner
================================================

提交前或 CI 里运行，检查仓库里有没有混进真实凭据、本机用户目录或账号数字。

【硬失败 HARD】命中即退出码 1（CI 会失败）：
  * 常见密钥格式：OpenAI 风格 sk-…、GitHub 令牌 ghp_/gho_/ghs_/github_pat_…、
    AWS AKIA…、Slack xox?-…、Google AIza…、PEM 私钥头
  * 记忆令牌 dafeiyu-<20 位以上十六进制>
  * Windows 用户目录 C:\\Users\\<真实用户名>（占位符如 <你的用户名>、%USERNAME% 放行）
  * 环境变量 DENY_NUMBERS 里列出的账号数字（逗号分隔，只在你本机设置，不写进仓库）

【警告 WARN】只提示、不阻断：
  * 源码里 7–12 位的数字（可能是真实 QQ / 群号，也可能只是常数；明显的占位数字已放行）
  * 非 C:\\Users 的盘符绝对路径（多数是示例路径，例如 C:\\Aurabot）

只扫描 Git 跟踪的文本文件（不在 Git 仓库里时扫描整个目录），跳过图片等二进制文件、
压缩过的第三方脚本（*.min.js）和扫描器自身。

用法：
    python scripts/scan_secrets.py                  # 扫整个仓库
    python scripts/scan_secrets.py --path brain     # 只扫某个目录
    python scripts/scan_secrets.py --quiet          # 不列出警告明细
退出码：0 = 通过；1 = 有硬失败。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SELF_FILE = "scripts/scan_secrets.py"

EXCLUDE_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".pytest_cache"}
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf", ".zip", ".gz", ".7z",
    ".mp3", ".mp4", ".wav", ".webm", ".ogg", ".ttf", ".woff", ".woff2", ".db", ".sqlite",
    ".onnx", ".bin", ".pth", ".ckpt", ".exe", ".dll",
}
SKIP_FILE_RE = re.compile(r"\.min\.js$")

# ---------------- 硬失败规则 ----------------
HARD_PATTERNS = [
    ("OpenAI 风格密钥 sk-…", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{24,}")),
    ("GitHub 令牌", re.compile(r"\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}")),
    ("AWS 访问密钥", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Slack 令牌", re.compile(r"\bxox[abprs]-[0-9A-Za-z\-]{10,}")),
    ("Google API Key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("PEM 私钥", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
    ("记忆令牌 dafeiyu-…", re.compile(r"dafeiyu-[0-9a-fA-F]{20,}")),
]

USERDIR_RE = re.compile(r"[A-Za-z]:(?:\\\\|\\|/)Users(?:\\\\|\\|/)([^\\/\"'`\s,，。;；)）]+)", re.I)
ALLOWED_USERS = {
    "me", "default", "user", "username", "public", "administrator", "example", "your-username",
    "yourname", "test", "vagrant", "xxx", "you", "name", "用户名", "你的用户名", "你", "你自己",
}


def _placeholder_user(name: str) -> bool:
    n = name.strip().lower()
    return (
        len(n) <= 1
        or n in ALLOWED_USERS
        or n[0] in "<{%$*."
        or n.startswith("…")
        or n.startswith("...")
    )


DENY_NUMBERS = {n.strip() for n in os.environ.get("DENY_NUMBERS", "").split(",") if n.strip()}

# ---------------- 警告规则 ----------------
NUM_RE = re.compile(r"(?<![\w.\-#/])[1-9]\d{6,11}(?![\w.\-])")
DRIVE_RE = re.compile(r"(?<![A-Za-z0-9/.])[A-Z]:(?:\\\\|\\|/)(?!Users)[^\\/\"'`\s]+")
# 常见的通用目录 / 示例目录：不提示
GENERIC_DIRS = ("program", "windows", "programdata", "aurabot", "ffmpeg", "tools", "bin",
                "snowluma", "rvc", "voices", "so-vits-svc", "my-data", "…")
WARN_SCOPE = ("ext-modules/", "brain/brain/", "brain/scripts/", "plugin/config.example.json",
              "brain/config.example.json", "brain/privacy")


def _placeholder_number(s: str) -> bool:
    """明显的占位数字：10000001、20000002、12345678、1111111、1000000000 之类。"""
    if len(set(s)) <= 2:
        return True
    if s in "1234567890123" or s in "9876543210987" or s in ("86400000", "3600000", "604800000", "2592000000"):
        return True
    if re.fullmatch(r"[1-9]0{4,}\d{0,2}", s):
        return True
    return False


def list_files(target: Path) -> list[Path]:
    try:
        out = subprocess.check_output(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", str(target)],
            cwd=ROOT, stderr=subprocess.DEVNULL,
        )
        files = [ROOT / p for p in out.decode("utf-8").split("\0") if p]
        return [f for f in files if f.is_file()]
    except Exception:
        found = []
        for root, dirs, names in os.walk(target):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            found += [Path(root) / n for n in names]
        return found


def read_text(path: Path) -> str | None:
    if path.suffix.lower() in BINARY_EXT or SKIP_FILE_RE.search(path.name):
        return None
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if b"\0" in data[:8192]:
        return None
    return data.decode("utf-8", errors="ignore")


def line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def scan_file(text: str, rel: str, hard: list, warn: list) -> None:
    for label, rx in HARD_PATTERNS:
        for m in rx.finditer(text):
            hard.append((rel, line_of(text, m.start()), label))
    for m in USERDIR_RE.finditer(text):
        if not _placeholder_user(m.group(1)):
            hard.append((rel, line_of(text, m.start()), "疑似真实 Windows 用户目录"))
    for num in DENY_NUMBERS:
        for m in re.finditer(r"(?<!\d)" + re.escape(num) + r"(?!\d)", text):
            hard.append((rel, line_of(text, m.start()), "DENY_NUMBERS 里的账号数字"))

    if rel.startswith(WARN_SCOPE):
        for m in NUM_RE.finditer(text):
            if not _placeholder_number(m.group(0)):
                warn.append((rel, line_of(text, m.start()), "7–12 位数字（请确认不是真实账号）"))
    if "/test/" in rel or rel.endswith((".test.js", ".test.mjs")):
        return
    for m in DRIVE_RE.finditer(text):
        tail = re.sub(r"^[A-Z]:[\\/]+", "", m.group(0)).lower()
        if tail.startswith(GENERIC_DIRS):
            continue
        warn.append((rel, line_of(text, m.start()), "盘符绝对路径（请确认只是示例）"))


def main() -> int:
    quiet = "--quiet" in sys.argv
    target = ROOT
    if "--path" in sys.argv:
        target = Path(sys.argv[sys.argv.index("--path") + 1])
        if not target.is_absolute():
            target = ROOT / target

    hard: list = []
    warn: list = []
    count = 0
    for fp in list_files(target):
        try:
            rel = fp.resolve().relative_to(ROOT).as_posix()
        except ValueError:
            rel = fp.name
        if rel == SELF_FILE or any(part in EXCLUDE_DIRS for part in Path(rel).parts):
            continue
        text = read_text(fp)
        if text is None:
            continue
        count += 1
        scan_file(text, rel, hard, warn)

    print(f"大肥鱼脱敏扫描：{count} 个文本文件（范围 {target.relative_to(ROOT) if target != ROOT else '整个仓库'}）")
    if hard:
        print(f"\n❌ 硬失败 {len(hard)} 处（必须处理）：")
        for rel, ln, msg in sorted(set(hard)):
            print(f"  {rel}:{ln}  {msg}")
    else:
        print("✅ 硬失败 0 处")
    if warn:
        print(f"⚠️  警告 {len(warn)} 处（不阻断，请人工确认）" + ("" if not quiet else "，用不带 --quiet 运行可看明细"))
        if not quiet:
            for rel, ln, msg in sorted(set(warn)):
                print(f"  {rel}:{ln}  {msg}")
    print("结论：" + ("未通过。" if hard else "通过。"))
    return 1 if hard else 0


if __name__ == "__main__":
    sys.exit(main())
