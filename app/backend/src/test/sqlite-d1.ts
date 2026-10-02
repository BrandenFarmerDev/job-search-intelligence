import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
type Value = string | number | boolean | null;
export function createTestD1() {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON");
  for (const name of ["0001_app_metadata.sql", "0002_job_intelligence.sql"]) database.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const statement = (sql: string, raw: Value[] = []) => {
    const values = raw.map((value) => typeof value === "boolean" ? Number(value) : value);
    return { bind: (...next: Value[]) => statement(sql, next), run: async () => ({meta:{changes:Number(database.prepare(sql).run(...values).changes)}}),
      first: async () => database.prepare(sql).get(...values) ?? null, all: async () => ({results:database.prepare(sql).all(...values),meta:{}}) };
  };
  const db = { prepare: (sql: string) => statement(sql), exec: async (sql: string) => { database.exec(sql);return {count:1,duration:0}; },
    batch: async (items: ReturnType<typeof statement>[]) => { database.exec("BEGIN");try {const result=[];for(const item of items)result.push(await item.all());database.exec("COMMIT");return result;}catch(error){database.exec("ROLLBACK");throw error;} }
  } as unknown as D1Database; // Test-only adapter implements exercised D1 semantics, including atomic batches.
  return {db,close:()=>database.close()};
}
