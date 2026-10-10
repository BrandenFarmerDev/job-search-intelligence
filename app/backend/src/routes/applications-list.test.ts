import { expect, it } from "vitest";
import type { ApplicationListResponse } from "@job-search/shared";
import { intelligenceRoute } from "./intelligence";
import { fixture } from "../test/fixtures";

type Seed = { id: string; company?: string; role?: string; applied?: string; status?: string; source?: string; excluded?: number; updated?: string };
const list = (env: Env) => async (query = "") => await (await intelligenceRoute(new Request(`https://api.example.com/api/job-intelligence/applications?${query}`), env, { kind: "owner", id: "owner" })).json() as ApplicationListResponse;
const ids = (result: ApplicationListResponse) => result.applications.map((app) => app.id);
async function seed(db: D1Database, rows: Seed[]) {
  for (const row of rows) await db.prepare("INSERT INTO applications(id,company,role,applied_at,status,source,reconciliation,excluded,updated_at) VALUES(?,?,?,?,?,?,'matched',?,?)")
    .bind(row.id, row.company ?? "Co", row.role ?? "Engineer", row.applied ?? "2026-09-01", row.status ?? "application_submitted", row.source ?? "sheet", row.excluded ?? 0, row.updated ?? "2026-09-01").run();
}
const many = (count: number): Seed[] => Array.from({ length: count }, (_, index) => ({ id: `app${String(index).padStart(3, "0")}`, applied: `2026-08-${String(1 + (index % 28)).padStart(2, "0")}` }));

it("sorts only by allowlisted keys and falls back safely for legacy, unknown and hostile values", async () => {
  const { env, db, close } = fixture(); const get = list(env);
  await seed(db, [
    { id: "a", company: "beta", applied: "2026-09-02", status: "offer", updated: "2026-09-10" }, { id: "b", company: "Alpha", applied: "2026-09-03", status: "application_submitted", updated: "2026-09-12" },
    { id: "c", company: "charlie", applied: "2026-09-01", status: "screening", updated: "2026-09-11" }, { id: "e", company: "Alpha", applied: "2026-09-03", status: "application_submitted", updated: "2026-09-12" },
  ]);
  expect(ids(await get("sort=applied_desc"))).toEqual(["b", "e", "a", "c"]);
  expect(ids(await get("sort=applied_asc"))).toEqual(["c", "a", "b", "e"]);
  expect(ids(await get("sort=company"))).toEqual(["b", "e", "a", "c"]);
  expect(ids(await get("sort=status"))).toEqual(["b", "e", "a", "c"]);
  expect(ids(await get("sort=updated"))).toEqual(["b", "e", "c", "a"]);
  for (const hostile of ["date", "", "nope", "constructor", "__proto__", "toString", encodeURIComponent("applied_at; DROP TABLE applications--"), encodeURIComponent("id) UNION SELECT 1--")]) expect(ids(await get(`sort=${hostile}`))).toEqual(["b", "e", "a", "c"]);
  expect((await db.prepare("SELECT COUNT(*) AS count FROM applications").first<{ count: number }>())?.count).toBe(4);
  close();
});

it("accepts only 25 or 50 rows per page and reports totals and continuation exactly", async () => {
  const { env, db, close } = fixture(); const get = list(env);
  await seed(db, many(60));
  const first = await get();
  expect(first).toMatchObject({ page: 0, pageSize: 50, total: 60, hasMore: true }); expect(first.applications).toHaveLength(50);
  for (const size of ["10", "abc", "", "100", "-25"]) expect((await get(`pageSize=${size}`)).pageSize).toBe(50);
  const small = await get("pageSize=25&page=1"); expect(small).toMatchObject({ page: 1, pageSize: 25, total: 60, hasMore: true }); expect(small.applications).toHaveLength(25);
  const last = await get("pageSize=25&page=2"); expect(last).toMatchObject({ hasMore: false, total: 60 }); expect(last.applications).toHaveLength(10);
  const next = await get("page=1"); expect(next.applications).toHaveLength(10); expect(next.hasMore).toBe(false);
  expect(new Set([...ids(first), ...ids(next)]).size).toBe(60);
  expect(await get("page=9999")).toMatchObject({ page: 1000, applications: [], total: 60, hasMore: false });
  expect((await get("page=-4")).page).toBe(0);
  close();
});

it("does not claim another page when the last page is exactly full", async () => {
  const { env, db, close } = fixture(); const get = list(env);
  await seed(db, many(50));
  expect(await get("pageSize=25&page=0")).toMatchObject({ hasMore: true, total: 50 });
  const last = await get("pageSize=25&page=1"); expect(last.hasMore).toBe(false); expect(last.applications).toHaveLength(25);
  const only = await get("pageSize=50"); expect(only.hasMore).toBe(false); expect(only.applications).toHaveLength(50);
  close();
});

it("filters by exact company and role, excludes hidden rows and reports filtered totals", async () => {
  const { env, db, close } = fixture(); const get = list(env);
  await seed(db, [
    { id: "a", company: "Acme", role: "Engineer", status: "offer" }, { id: "b", company: "Acme", role: "Designer" }, { id: "c", company: "Acme Labs", role: "Engineer" },
    { id: "d", company: "Acme", role: "Engineer", excluded: 1 }, { id: "e", company: "100%_Co", role: "Lead", source: "email" },
  ]);
  expect(await get()).toMatchObject({ total: 4 });
  expect(ids(await get("company=Acme&sort=company"))).toEqual(["a", "b"]);
  expect(await get("company=Acme")).toMatchObject({ total: 2, hasMore: false });
  expect(ids(await get("role=Engineer&sort=company"))).toEqual(["a", "c"]);
  expect(ids(await get("company=Acme&role=Engineer"))).toEqual(["a"]);
  expect((await get("company=Acme&role=Engineer&status=offer")).total).toBe(1);
  expect((await get("company=Acm")).total).toBe(0);
  expect((await get("company=acme")).total).toBe(0);
  expect((await get(`company=${encodeURIComponent("100%_Co")}`)).total).toBe(1);
  expect((await get(`company=${encodeURIComponent("' OR 1=1--")}`)).total).toBe(0);
  expect((await get("company=&role=")).total).toBe(4);
  expect((await get("source=email")).total).toBe(1);
  expect((await get("q=Acme&pageSize=25")).total).toBe(3);
  close();
});
