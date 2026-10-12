-- Additive, mailbox-scoped Gmail evidence. Legacy canonical rows and owner decisions remain untouched.
CREATE TABLE gmail_connections (
  id TEXT PRIMARY KEY, mailbox TEXT NOT NULL, encrypted_refresh_token TEXT NOT NULL,
  connected_at TEXT NOT NULL, updated_at TEXT NOT NULL, generation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','reconnect_required','disconnected')),
  granted_scopes TEXT NOT NULL
);
CREATE TABLE gmail_oauth_states (
  state_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, verifier TEXT NOT NULL,
  environment TEXT NOT NULL, intent TEXT NOT NULL CHECK(intent IN ('connect','connect_and_resume')),
  data_generation TEXT NOT NULL, connection_generation TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE gmail_message_instances (
  id TEXT PRIMARY KEY, mailbox TEXT NOT NULL, gmail_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  canonical_id TEXT, internet_message_id TEXT, labels_json TEXT NOT NULL,
  internal_date TEXT NOT NULL, original_date TEXT, sender TEXT NOT NULL, subject TEXT NOT NULL,
  excerpt TEXT, content_hash TEXT, available INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('pending','imported','alert_only','review','excluded','unavailable','retry')),
  review_reason TEXT, updated_at TEXT NOT NULL,
  UNIQUE(mailbox,gmail_id)
);
CREATE INDEX gmail_instances_cursor ON gmail_message_instances(mailbox,gmail_id);
CREATE TABLE gmail_candidates (
  mailbox TEXT NOT NULL, gmail_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('metadata','body','process','sweep','done')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(mailbox,gmail_id)
);
ALTER TABLE gmail_candidates ADD COLUMN metadata_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gmail_candidates ADD COLUMN body_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gmail_candidates ADD COLUMN process_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX gmail_candidates_due ON gmail_candidates(stage,next_attempt_at,created_at);
CREATE TABLE gmail_checkpoints (
  mailbox TEXT NOT NULL, name TEXT NOT NULL, cursor TEXT, window_start INTEGER,
  window_end INTEGER, target_end INTEGER, completed_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(mailbox,name)
);
CREATE TABLE gmail_budget (
  day TEXT PRIMARY KEY, units INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0, lists INTEGER NOT NULL DEFAULT 0,
  instances INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE gmail_minute_budget (
  minute TEXT PRIMARY KEY, units INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE gmail_cooldowns (
  mailbox TEXT PRIMARY KEY, until_at INTEGER NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE gmail_write_fences (
  id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1)
);
INSERT INTO app_metadata(key,value) VALUES('gmail_sync_paused','true') ON CONFLICT(key) DO NOTHING;
INSERT INTO app_metadata(key,value) VALUES('mail_source','none') ON CONFLICT(key) DO NOTHING;
INSERT INTO app_metadata(key,value) VALUES('gmail_connection_generation','00000000000000000000000000000000') ON CONFLICT(key) DO NOTHING;
INSERT INTO app_metadata(key,value) VALUES('schema_version','5') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
