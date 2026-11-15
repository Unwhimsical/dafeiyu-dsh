"""SQLite 层：WAL + synchronous=NORMAL，一把锁串行化，备份走 backup API。"""
from __future__ import annotations
import sqlite3, threading, shutil, time
from pathlib import Path
from .util import iso, now_ms

SCHEMA = r"""
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, relationship_to_user TEXT DEFAULT '',
  self_card TEXT DEFAULT '', created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  owner_persona TEXT NOT NULL,             -- 人格；'family' = 全家共享
  created_by TEXT,
  kind TEXT NOT NULL DEFAULT 'event',      -- self/about_user/relationship/event/preference/diary/profile/cognition/episode
  visibility TEXT NOT NULL DEFAULT 'private',
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 3,   -- 1..5（companion-memory 口径）
  salience REAL NOT NULL DEFAULT 0.5,      -- 0..1（旧大脑口径；巩固增益封顶 0.85）
  tags TEXT DEFAULT '[]',
  event_date TEXT, source_platform TEXT,
  created_at TEXT, updated_at TEXT,
  strength REAL, emotion REAL DEFAULT 0.3, half_life_days REAL,
  last_recalled_at TEXT, recall_count INTEGER DEFAULT 0, state TEXT DEFAULT 'clear',
  faded_text TEXT, last_surfaced_at TEXT, pinned INTEGER DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'inherit',   -- inherit/private/scoped/public
  origin_chat TEXT DEFAULT '',             -- p:QQ / g:群号 / system / legacy:unknown
  allow TEXT DEFAULT '[]',
  speaker TEXT DEFAULT '',                 -- 这条记忆是关于谁的（QQ）
  fact_key TEXT DEFAULT '',                -- 主体+属性，用于 supersede
  superseded_by TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active/archived/superseded
  tier TEXT DEFAULT 'short',               -- short/long（梦整理后转 long）
  seg TEXT DEFAULT '',
  used_count INTEGER DEFAULT 0, last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_owner ON memories(owner_persona, status);
CREATE INDEX IF NOT EXISTS idx_mem_origin ON memories(origin_chat);
CREATE INDEX IF NOT EXISTS idx_mem_fact ON memories(fact_key);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, tokenize='trigram');
CREATE TABLE IF NOT EXISTS entity_mentions (memory_id TEXT, entity TEXT, PRIMARY KEY(memory_id, entity));
CREATE INDEX IF NOT EXISTS idx_ent ON entity_mentions(entity);
CREATE TABLE IF NOT EXISTS memory_links (
  a_id TEXT NOT NULL, b_id TEXT NOT NULL, weight REAL NOT NULL, kind TEXT NOT NULL,
  created_at TEXT, updated_at TEXT, PRIMARY KEY (a_id, b_id), CHECK (a_id < b_id));
CREATE INDEX IF NOT EXISTS idx_links_b ON memory_links(b_id);
CREATE TABLE IF NOT EXISTS memory_embeddings (memory_id TEXT PRIMARY KEY, model TEXT, dim INTEGER, vec BLOB, updated_at TEXT);
CREATE TABLE IF NOT EXISTS memory_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT, action TEXT, detail TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, persona TEXT, role TEXT, user_id TEXT, text TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_turns_chat ON turns(chat_id, id);
CREATE TABLE IF NOT EXISTS spill_index (id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT, line_no INTEGER, chat_id TEXT, role TEXT, ts TEXT, text TEXT, seg TEXT, UNIQUE(file, line_no));
CREATE INDEX IF NOT EXISTS idx_spill_chat ON spill_index(chat_id);
CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, persona_id TEXT, chat_id TEXT DEFAULT '', summary TEXT, mood TEXT, next_time TEXT,
  source_platform TEXT, consumed INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS unresolved (id TEXT PRIMARY KEY, persona_id TEXT, chat_id TEXT DEFAULT '', content TEXT, status TEXT DEFAULT 'open', resolution TEXT,
  created_at TEXT, updated_at TEXT, closed_at TEXT);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, persona_id TEXT, author TEXT, content TEXT, status TEXT DEFAULT 'open', reply TEXT, reply_action TEXT,
  created_at TEXT, replied_at TEXT, memory_id TEXT, memory_snapshot TEXT);
CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, name TEXT, description TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS deck_items (id TEXT PRIMARY KEY, topic_id TEXT, kind TEXT, title TEXT, content TEXT, created_by TEXT, tags TEXT DEFAULT '[]',
  created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS deck_draws (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, persona TEXT, drawn_at TEXT);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, persona_id TEXT, title TEXT, summary TEXT, full_text TEXT, entry_date TEXT, favorite INTEGER DEFAULT 0,
  source_platform TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS garden_entries (id TEXT PRIMARY KEY, persona_id TEXT, kind TEXT, title TEXT, body TEXT, entry_date TEXT, favorite INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS garden_favorites (kind TEXT, ref_id TEXT, created_at TEXT, PRIMARY KEY(kind, ref_id));
CREATE TABLE IF NOT EXISTS garden_persona_meta (persona_id TEXT PRIMARY KEY, note TEXT, emblem TEXT);
CREATE TABLE IF NOT EXISTS voice_clips (id TEXT PRIMARY KEY, persona_id TEXT, title TEXT, mime TEXT, size INTEGER, entry_date TEXT, favorite INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS garden_images (id TEXT PRIMARY KEY, persona_id TEXT, title TEXT, mime TEXT, size INTEGER, entry_date TEXT, favorite INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS her_status (id TEXT PRIMARY KEY, mood TEXT, energy INTEGER, note TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS companion_notes (id TEXT PRIMARY KEY, persona_id TEXT, content TEXT, seen INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS desire_logs (id TEXT PRIMARY KEY, persona_id TEXT, entry_date TEXT, level_label TEXT, status TEXT, source TEXT DEFAULT 'custom', source_custom TEXT,
  trigger_text TEXT, mood TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS desire_replies (id TEXT PRIMARY KEY, desire_id TEXT, author_persona_id TEXT, author_label TEXT, body TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS emotion_state (persona_id TEXT, dim TEXT, surface REAL, inner REAL, inner_cause TEXT, inner_since TEXT, admitted INTEGER DEFAULT 0,
  updated_at TEXT, PRIMARY KEY(persona_id, dim));
CREATE TABLE IF NOT EXISTS emotion_facts (persona_id TEXT PRIMARY KEY, last_tick_at TEXT, last_her_msg_at TEXT, late_night_min REAL DEFAULT 0, late_night_day TEXT,
  coax_attempts INTEGER DEFAULT 0, last_coax_at TEXT, browse_json TEXT, last_snapshot_day TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS emotion_events (id TEXT PRIMARY KEY, persona_id TEXT, source TEXT, changes_json TEXT, reason TEXT, before_json TEXT, after_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS emotion_snapshots (persona_id TEXT, day TEXT, values_json TEXT, PRIMARY KEY(persona_id, day));
CREATE TABLE IF NOT EXISTS emotion_series (id INTEGER PRIMARY KEY AUTOINCREMENT, persona_id TEXT, at TEXT, values_json TEXT);
CREATE TABLE IF NOT EXISTS bio_state (persona_id TEXT, hormone TEXT, level REAL, updated_at TEXT, PRIMARY KEY(persona_id, hormone));
CREATE TABLE IF NOT EXISTS bio_events (id INTEGER PRIMARY KEY AUTOINCREMENT, persona_id TEXT, chat_id TEXT, type TEXT, intensity REAL, payload TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS body_state (persona_id TEXT PRIMARY KEY, data TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS body_series (id INTEGER PRIMARY KEY AUTOINCREMENT, persona_id TEXT, at TEXT, values_json TEXT);
CREATE TABLE IF NOT EXISTS body_traces (id TEXT PRIMARY KEY, persona_id TEXT, part TEXT, type TEXT, level TEXT, note TEXT, created_at TEXT, expires_at TEXT);
CREATE TABLE IF NOT EXISTS body_events (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, source TEXT NOT NULL, events_json TEXT NOT NULL, before_json TEXT NOT NULL,
  after_json TEXT NOT NULL, injection TEXT, skip_reason TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_body_events_persona ON body_events(persona_id, created_at);
CREATE TABLE IF NOT EXISTS body_wake_queue (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL, prompt TEXT NOT NULL,
  values_json TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, decision TEXT, decision_detail TEXT, outbox_id TEXT);
CREATE TABLE IF NOT EXISTS body_private_records (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, values_json TEXT NOT NULL, method TEXT NOT NULL, thought TEXT, want_to_say TEXT,
  created_at TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0, outcome TEXT, materials_json TEXT, stuck_min REAL, rounds_json TEXT);
CREATE TABLE IF NOT EXISTS dreams (id TEXT PRIMARY KEY, persona_id TEXT, dream_date TEXT, text TEXT, cited_ids TEXT, model TEXT, status TEXT, consolidated TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS cognition_candidates (id TEXT PRIMARY KEY, persona_id TEXT, source_ids TEXT, theme TEXT, status TEXT DEFAULT 'open', offered_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS peer_messages (id TEXT PRIMARY KEY, from_persona TEXT, to_persona TEXT, content TEXT, read INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS pulses (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT, chat_id TEXT, kind TEXT, score REAL, created_at TEXT, at_ms INTEGER);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, persona_id TEXT, chat_id TEXT, kind TEXT, text TEXT, prompt TEXT, ref TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at TEXT, sent_at TEXT);
CREATE TABLE IF NOT EXISTS chat_counters (chat_id TEXT PRIMARY KEY, replies INTEGER DEFAULT 0, last_reflect_at TEXT, session_started_at TEXT, last_turn_at TEXT);
CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, persona_id TEXT, kind TEXT, content TEXT, memory_ids TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS heart_traces (id TEXT PRIMARY KEY, persona_id TEXT, title TEXT, content TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS body_log_seen (persona_id TEXT PRIMARY KEY, seen_at TEXT);
CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, persona_id TEXT, label TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS growth_state (persona_id TEXT PRIMARY KEY, data TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS growth_snapshots (id TEXT PRIMARY KEY, persona_id TEXT, data TEXT, reason TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS relations (persona_id TEXT, person TEXT, data TEXT, updated_at TEXT, PRIMARY KEY(persona_id, person));

-- ===== 话簿账本（L0 原话底账 / L1 条目 / 册子 / 审计）=====
-- L0：逐句原话，append-only。text_raw 平时永不 UPDATE；唯一例外是「彻底删除」：直接删行，只留不含内容的 audit。erased 列保留兼容旧库。
CREATE TABLE IF NOT EXISTS ledger_utterances (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,                    -- 发生时刻
  tz_offset INTEGER DEFAULT 480,      -- 时区
  created_at TEXT NOT NULL,            -- 入库时刻（与 ts 区分）
  platform TEXT DEFAULT '',
  chat_id TEXT NOT NULL,              -- p:/g: 作用域，天然隔离私聊与群
  speaker_id TEXT DEFAULT '', speaker_label TEXT DEFAULT '', role TEXT NOT NULL,
  seq INTEGER DEFAULT 0,              -- 会话内顺序
  text_raw TEXT NOT NULL,
  context_before TEXT DEFAULT '', context_after TEXT DEFAULT '',
  turn_id INTEGER, spill_file TEXT DEFAULT '', spill_line INTEGER,
  visibility TEXT DEFAULT 'inherit', nsfw INTEGER DEFAULT 0,
  hash TEXT DEFAULT '', erased INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ledger_u_ts ON ledger_utterances(ts);
CREATE INDEX IF NOT EXISTS idx_ledger_u_chat ON ledger_utterances(chat_id, ts);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  utterance_id TEXT NOT NULL,
  quote TEXT NOT NULL,                -- 原文快照，仅展示；不可改
  subject TEXT DEFAULT '',            -- 关于谁/什么：她自己分配
  subject_type TEXT DEFAULT 'person',
  books TEXT DEFAULT '[]',            -- 多归属册子（JSON 数组）
  tags TEXT DEFAULT '[]',
  why_kept TEXT DEFAULT '', note TEXT DEFAULT '',
  assigned_by TEXT DEFAULT 'her', assign_reason TEXT DEFAULT '',
  importance INTEGER DEFAULT 3, emotion REAL DEFAULT 0.3,
  recall_count INTEGER DEFAULT 0, last_recalled_at TEXT,
  half_life_days REAL DEFAULT 14,
  heat REAL DEFAULT 0.5, heat_pinned INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',       -- active / archived / deleted
  created_at TEXT, updated_at TEXT, fingerprint TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ledger_e_heat ON ledger_entries(heat);
CREATE INDEX IF NOT EXISTS idx_ledger_e_subject ON ledger_entries(subject);
CREATE INDEX IF NOT EXISTS idx_ledger_e_status ON ledger_entries(status, heat);
CREATE TABLE IF NOT EXISTS ledger_books (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT DEFAULT '',
  note TEXT DEFAULT '', created_by TEXT DEFAULT 'her', created_at TEXT
);
CREATE TABLE IF NOT EXISTS ledger_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT, action TEXT,
  actor TEXT, detail TEXT, created_at TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS ledger_fts USING fts5(id UNINDEXED, quote, why_kept, tags, tokenize='trigram');
"""


class DB:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None, timeout=30)
        self.conn.row_factory = sqlite3.Row
        c = self.conn
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA busy_timeout=10000")
        with self.lock:
            c.executescript(SCHEMA)
            self._migrate_columns()
            c.execute("INSERT OR IGNORE INTO meta(k,v) VALUES('schema_version','2')")

    def _migrate_columns(self):
        # 给旧版本库补列（向前兼容）
        want = {
            "memories": {"used_count": "INTEGER DEFAULT 0", "last_used_at": "TEXT", "tier": "TEXT DEFAULT 'short'",
                         "credibility": "TEXT DEFAULT ''", "version": "INTEGER DEFAULT 1",
                         "src_tier": "TEXT DEFAULT ''"},   # owner/other/isolated/system
            "notes": {"memory_id": "TEXT", "memory_snapshot": "TEXT"},
            "unresolved": {"closed_at": "TEXT"},
            "cognition_candidates": {"score": "REAL DEFAULT 0", "offers": "INTEGER DEFAULT 0", "cognition_id": "TEXT", "done_at": "TEXT", "faded": "TEXT"},
        }
        for table, extra in want.items():
            cols = {r[1] for r in self.conn.execute(f"PRAGMA table_info({table})")}
            for k, t in extra.items():
                if k not in cols:
                    self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {k} {t}")

    # ---- 基本操作 ----
    def q(self, sql: str, params=()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    def one(self, sql: str, params=()):
        with self.lock:
            return self.conn.execute(sql, params).fetchone()

    def x(self, sql: str, params=()):
        with self.lock:
            return self.conn.execute(sql, params)

    def many(self, sql: str, seq):
        with self.lock:
            return self.conn.executemany(sql, seq)

    def tx(self):
        db = self

        class _Tx:
            def __enter__(self):
                db.lock.acquire()
                try:
                    db.conn.execute("BEGIN IMMEDIATE")
                except Exception:
                    db.lock.release()
                    raise
                return db

            def __exit__(self, et, ev, tb):
                try:
                    db.conn.execute("ROLLBACK" if et else "COMMIT")
                finally:
                    db.lock.release()
                return False
        return _Tx()

    # ---- 备份 / 校验 ----
    def backup(self, backup_dir: str | Path, keep: int = 12, tag: str = "") -> Path:
        backup_dir = Path(backup_dir)
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dst = backup_dir / f"brain-{stamp}{('-' + tag) if tag else ''}.db"
        tmp = dst.with_suffix(".db.tmp")
        with self.lock:
            out = sqlite3.connect(str(tmp))
            try:
                self.conn.backup(out)
            finally:
                out.close()
        tmp.replace(dst)
        files = sorted(backup_dir.glob("brain-*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[keep:]:
            try:
                old.unlink()
            except OSError:
                pass
        return dst

    def verify(self) -> dict:
        with self.lock:
            ic = self.conn.execute("PRAGMA integrity_check").fetchone()[0]
            n = self.conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            nf = self.conn.execute("SELECT COUNT(*) FROM memories_fts").fetchone()[0]
            orphan_links = self.conn.execute(
                "SELECT COUNT(*) FROM memory_links WHERE a_id NOT IN (SELECT id FROM memories) OR b_id NOT IN (SELECT id FROM memories)").fetchone()[0]
        return {"integrity": ic, "memories": n, "fts_rows": nf, "fts_in_sync": n == nf, "orphan_links": orphan_links, "ok": ic == "ok" and n == nf}

    def restore_from(self, src: str | Path):
        src_conn = sqlite3.connect(str(src))
        try:
            with self.lock:
                src_conn.backup(self.conn)
        finally:
            src_conn.close()

    def close(self):
        with self.lock:
            try:
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass
            self.conn.close()
