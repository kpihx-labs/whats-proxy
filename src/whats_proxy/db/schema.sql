-- whats-proxy SQLite schema
-- Applied automatically on first open (CREATE IF NOT EXISTS).
-- Migration from JSON: db/migrate.ts reads store.json and imports into these tables.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;

-- ── Core tables ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,               -- JSON-serialized AnyChat
  name TEXT,                        -- extracted for indexing
  pushName TEXT,                    -- extracted for indexing
  conversationTimestamp INTEGER DEFAULT 0,
  unreadCount INTEGER DEFAULT 0,
  updatedAt INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,               -- JSON-serialized AnyContact
  name TEXT,                        -- extracted for indexing
  notify TEXT,
  phoneNumber TEXT,
  lid TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  remoteJid TEXT NOT NULL,
  msgId TEXT NOT NULL,
  data TEXT NOT NULL,               -- JSON-serialized AnyMsg
  timestamp INTEGER DEFAULT 0,
  fromMe INTEGER DEFAULT 0,
  text TEXT,                        -- extracted text for FTS
  PRIMARY KEY (remoteJid, msgId)
);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages(remoteJid);

CREATE TABLE IF NOT EXISTS group_meta (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL               -- JSON-serialized AnyGroupMeta
);

CREATE TABLE IF NOT EXISTS lid_mappings (
  lid TEXT PRIMARY KEY,
  data TEXT NOT NULL,              -- JSON-serialized { pn, name? }
  pn TEXT,                         -- extracted for indexing
  name TEXT
);

CREATE TABLE IF NOT EXISTS contact_tags (
  jid TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (jid, tag)
);

CREATE TABLE IF NOT EXISTS message_receipts (
  msg_jid TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  reader_jid TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (msg_jid, reader_jid, receipt_type)
);

-- ── Full-text search ────────────────────────────────────────────────────────

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content=messages, content_rowid=rowid, tokenize='unicode61');

-- ── Performance ──────────────────────────────────────────────────────────────

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
