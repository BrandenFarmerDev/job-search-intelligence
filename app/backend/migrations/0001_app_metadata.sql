-- Scaffold metadata only. Job-search records and mailbox storage are deferred.
CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

INSERT INTO app_metadata (key, value) VALUES ('schema_version', '1');
