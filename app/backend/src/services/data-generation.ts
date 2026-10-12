import { Problem } from "./security";

const key = "job_data_generation";

/** Read the migration-seeded generation. A missing value is a deployment error and must fail closed. */
export async function dataGeneration(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value FROM app_metadata WHERE key=?").bind(key).first<{ value: string }>();
  if (!row?.value) throw new Problem(503, "data_generation_unavailable");
  return row.value;
}

export function assertGeneration(expected: string | null, current: string): asserts expected is string {
  if (!expected) throw new Problem(409, "data_generation_required");
  if (expected !== current) throw new Problem(409, "stale_data_generation");
}

/** This constraint-failing upsert belongs in the import D1 batch to fence every write atomically,
 * including when the metadata row is missing. */
export function generationGuard(db: D1Database, expected: string): D1PreparedStatement {
  return db.prepare("INSERT INTO app_metadata(key,value) VALUES(?,CASE WHEN (SELECT value FROM app_metadata WHERE key=?)=? THEN ? ELSE NULL END) ON CONFLICT(key) DO UPDATE SET value=CASE WHEN app_metadata.value=? THEN app_metadata.value ELSE NULL END")
    .bind(key, key, expected, expected, expected);
}
