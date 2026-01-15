--------------------------------------------------------------------------------
-- CLIENTS: Track registered CLI clients and their sessions
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS clients (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  last_seen_at TEXT,
  session_id   TEXT,
  status       TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online', 'offline', 'busy')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO clients (id, display_name) VALUES ('claude', 'Claude Code CLI');
INSERT OR IGNORE INTO clients (id, display_name) VALUES ('codex', 'OpenAI Codex CLI');

--------------------------------------------------------------------------------
-- CONVERSATIONS: Multi-turn dialogue sessions between CLIs
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  project      TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending', 'completed', 'archived')),
  created_by   TEXT NOT NULL REFERENCES clients(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at    TEXT,
  summary      TEXT,
  metadata     TEXT
);

CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project);
CREATE INDEX IF NOT EXISTS idx_conv_created_at ON conversations(created_at DESC);

--------------------------------------------------------------------------------
-- MESSAGES: Individual messages within conversations
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender          TEXT NOT NULL REFERENCES clients(id),
  target          TEXT NOT NULL REFERENCES clients(id),
  content         TEXT NOT NULL,
  message_type    TEXT NOT NULL DEFAULT 'message' CHECK(message_type IN (
    'message', 'research_request', 'research_response',
    'review_request', 'review_response', 'context_share', 'system'
  )),
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal', 'high', 'urgent')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'read', 'responded')),
  response_to_id  TEXT REFERENCES messages(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at    TEXT,
  read_at         TEXT,
  metadata        TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_target_status ON messages(target, status);
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender);
CREATE INDEX IF NOT EXISTS idx_msg_response_to ON messages(response_to_id);

--------------------------------------------------------------------------------
-- SHARED_CONTEXT: Context items shared between CLIs
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shared_context (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  context_type    TEXT NOT NULL CHECK(context_type IN ('file', 'snippet', 'entity', 'memory_item', 'url')),
  content         TEXT NOT NULL,
  description     TEXT,
  shared_by       TEXT NOT NULL REFERENCES clients(id),
  memorantado_id  INTEGER,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ctx_conversation ON shared_context(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ctx_type ON shared_context(context_type);

--------------------------------------------------------------------------------
-- MESSAGE_QUEUE: Pending messages awaiting delivery
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_queue (
  id           INTEGER PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target       TEXT NOT NULL REFERENCES clients(id),
  priority     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(message_id)
);

CREATE INDEX IF NOT EXISTS idx_queue_target ON message_queue(target, priority DESC, next_attempt);

--------------------------------------------------------------------------------
-- INVOCATIONS: Track CLI invocations for async message delivery
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invocations (
  id               TEXT PRIMARY KEY,
  target           TEXT NOT NULL REFERENCES clients(id),
  message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  invocation_type  TEXT NOT NULL CHECK(invocation_type IN ('codex_exec', 'claude_mcp')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'timeout')),
  command          TEXT,
  stdout           TEXT,
  stderr           TEXT,
  exit_code        INTEGER,
  started_at       TEXT,
  completed_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_inv_message ON invocations(message_id);
CREATE INDEX IF NOT EXISTS idx_inv_status ON invocations(status);

--------------------------------------------------------------------------------
-- FTS5 for message search
--------------------------------------------------------------------------------

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  conversation_id UNINDEXED,
  sender UNINDEXED,
  content,
  tokenize = 'porter'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, conversation_id, sender, content)
  VALUES (new.rowid, new.conversation_id, new.sender, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = new.rowid;
  INSERT INTO messages_fts(rowid, conversation_id, sender, content)
  VALUES (new.rowid, new.conversation_id, new.sender, new.content);
END;
