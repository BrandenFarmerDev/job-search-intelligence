CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE);
CREATE TABLE applications (
 id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organizations(id), company TEXT NOT NULL,
 role TEXT NOT NULL, requisition_id TEXT, application_url TEXT, applied_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'application_submitted', source TEXT NOT NULL, reconciliation TEXT NOT NULL DEFAULT 'needs_review',
 excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)), updated_at TEXT NOT NULL
);
CREATE INDEX applications_search ON applications(company,role,applied_at);
CREATE TABLE message_references (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, immutable_id TEXT NOT NULL, conversation_id TEXT,
 internet_message_id TEXT, subject TEXT NOT NULL, sender TEXT NOT NULL, occurred_at TEXT NOT NULL,
 web_link TEXT, excerpt TEXT, content_hash TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL, processed_hash TEXT, UNIQUE(account_id,immutable_id)
);
CREATE TABLE message_folders (message_id TEXT REFERENCES message_references(id) ON DELETE CASCADE, folder TEXT NOT NULL, PRIMARY KEY(message_id,folder));
CREATE TABLE sheet_rows (id TEXT PRIMARY KEY, spreadsheet_id TEXT NOT NULL, row_key TEXT NOT NULL, row_hash TEXT NOT NULL,
 snapshot TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, processed_hash TEXT, UNIQUE(spreadsheet_id,row_key));
CREATE TABLE sheet_versions (id TEXT PRIMARY KEY, row_id TEXT NOT NULL REFERENCES sheet_rows(id) ON DELETE CASCADE,
 row_hash TEXT NOT NULL, snapshot TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(row_id,row_hash));
CREATE TABLE application_events (id TEXT PRIMARY KEY, application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
 type TEXT NOT NULL, occurred_at TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
 confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1), evidence TEXT NOT NULL,
 UNIQUE(source,source_id,type));
CREATE TABLE classification_decisions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, cache_key TEXT NOT NULL UNIQUE,
 decision TEXT NOT NULL, method TEXT NOT NULL, reviewed_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE reconciliation_matches (id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
 application_id TEXT REFERENCES applications(id) ON DELETE CASCADE, state TEXT NOT NULL, reason TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0,
 UNIQUE(source,source_id));
CREATE TABLE manual_overrides (id TEXT PRIMARY KEY, application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
 field TEXT NOT NULL, value TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE connections (provider TEXT PRIMARY KEY, account_id TEXT NOT NULL, encrypted_credentials TEXT NOT NULL,
 connected_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE sync_state (provider TEXT NOT NULL, scope TEXT NOT NULL, cursor TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(provider,scope));
CREATE TABLE sync_runs (id TEXT PRIMARY KEY, trigger TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
 finished_at TEXT, counters TEXT NOT NULL DEFAULT '{}', error_code TEXT);
CREATE TABLE sync_locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE follow_up_tasks (id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
 due_at TEXT NOT NULL, completed_at TEXT, UNIQUE(application_id,due_at));
CREATE TABLE ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0);
INSERT INTO app_metadata(key,value) VALUES('schema_version','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
