import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createTestD1 } from "./test/sqlite-d1";

it("normalizes the old status default for existing and new databases", async () => {
  const { db, close } = createTestD1();
  await db.prepare("INSERT INTO applications(id,company,role,applied_at,source,updated_at) VALUES('new','ExampleCo','Engineer','2026-09-30','manual','2026-09-30')").run();
  await db.prepare("INSERT INTO applications(id,company,role,applied_at,status,source,updated_at) VALUES('legacy','ExampleCo','Engineer','2026-09-30','submitted','manual','2026-09-30')").run();
  const rows = (await db.prepare("SELECT status FROM applications ORDER BY id").all<{ status: string }>()).results;
  expect(rows.map((row) => row.status)).toEqual(["application_submitted", "application_submitted"]);
  expect((await db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").first<{ value: string }>())?.value).toBe("3");
  close();
});

it("upgrades an existing database with the original submitted default", () => {
  const database = new DatabaseSync(":memory:");
  const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  database.exec(migration("0001_app_metadata.sql"));
  const currentSchema = migration("0002_job_intelligence.sql");
  const legacySchema = currentSchema.replace("DEFAULT 'application_submitted'", "DEFAULT 'submitted'");
  expect(legacySchema).not.toBe(currentSchema);
  database.exec(legacySchema);
  database.exec("INSERT INTO applications(id,company,role,applied_at,source,updated_at) VALUES('legacy','ExampleCo','Engineer','2026-09-30','manual','2026-09-30')");
  expect(database.prepare("SELECT status FROM applications WHERE id='legacy'").get()).toMatchObject({ status: "submitted" });
  database.exec(migration("0003_normalize_application_status.sql"));
  expect(database.prepare("SELECT status FROM applications WHERE id='legacy'").get()).toMatchObject({ status: "application_submitted" });
  database.close();
});
