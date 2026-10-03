-- Existing D1 databases retain the original default from migration 0002.
-- Normalize legacy rows and any future insert that relies on that default.
UPDATE applications SET status='application_submitted' WHERE status='submitted';
CREATE TRIGGER normalize_legacy_application_status
AFTER INSERT ON applications
WHEN NEW.status='submitted'
BEGIN
  UPDATE applications SET status='application_submitted' WHERE id=NEW.id;
END;
INSERT INTO app_metadata(key,value) VALUES('schema_version','3') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
