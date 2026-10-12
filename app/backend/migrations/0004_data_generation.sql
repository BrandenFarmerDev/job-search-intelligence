-- A stable genesis epoch is safe because no pre-migration client can present it.
-- Typed deletion rotates it before any later automated upload can be accepted.
INSERT INTO app_metadata(key,value) VALUES('job_data_generation','00000000000000000000000000000000')
ON CONFLICT(key) DO NOTHING;
INSERT INTO app_metadata(key,value) VALUES('schema_version','4')
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
