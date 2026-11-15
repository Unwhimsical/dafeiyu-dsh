"""升级后清一次旧数据：把已经存进日常存储的 18+ / 隔离号的话清掉（turns 表、spill 明文流水和索引、话簿底账）。
判断和写入时同一套（brain.ledger.skip_reason，事后只能看内容和隔离名单）。只打印条数，不打印内容。
用法（先停掉大脑，先备份数据目录）：
    python scripts/purge_sensitive.py [--config config.json]          只数一数（默认）
    python scripts/purge_sensitive.py [--config config.json] --apply  真删
"""
from __future__ import annotations
import argparse, json, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    ap.add_argument("--apply", action="store_true", help="真删（不加只统计）")
    a = ap.parse_args()
    if a.config:
        os.environ["BRAIN_CONFIG"] = a.config
    from brain.core import Brain
    from brain import ledger as L
    b = Brain()
    try:
        r = {"turns_spill": L.purge_turns_spill(b, dry_run=not a.apply)}
        if hasattr(L, "purge_sensitive"):
            r["ledger"] = L.purge_sensitive(b, dry_run=not a.apply)
        print(json.dumps(r, ensure_ascii=False, indent=1))
    finally:
        b.close()


if __name__ == "__main__":
    main()
