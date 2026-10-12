import { describe, expect, it, vi } from "vitest";
import { createExecutionBudget, ExecutionBudgetExceeded, reserveExternal, reserveWorkflowHandoff } from "./execution-budget";
import { fixture } from "../test/fixtures";

async function useFixture() {
  const f = fixture();
  const sourceEnv = f.env;
  const created = createExecutionBudget(sourceEnv);
  return { ...f, sourceEnv, ...created };
}

describe("per-invocation execution envelope", () => {
  it("allows exactly 30 ordinary D1 operations and rejects the next before D1 is called", async () => {
    const f = await useFixture();
    for (let index = 0; index < 30; index++) await f.env.JOB_SEARCH_DB.prepare("SELECT 1 AS value").first();
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 30, databaseOperations: 30, controlOperations: 0, blockedAttempts: 0 });
    expect(() => f.env.JOB_SEARCH_DB.prepare("SELECT 2 AS value").first()).toThrow(ExecutionBudgetExceeded);
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 30, blockedAttempts: 1 });
    // The original environment still uses its unwrapped database after the scoped cap is reached.
    expect(await f.sourceEnv.JOB_SEARCH_DB.prepare("SELECT 3 AS value").first()).toMatchObject({ value: 3 });
    f.close();
  });

  it("charges each batch member atomically before the underlying batch and preserves failed attempts", async () => {
    const f = await useFixture();
    for (let index = 0; index < 29; index++) await f.env.JOB_SEARCH_DB.prepare("SELECT 1").first();
    const underlyingBatch = vi.spyOn(f.db, "batch");
    const statements = ["SELECT 1", "SELECT 2"].map((sql) => f.env.JOB_SEARCH_DB.prepare(sql));
    await expect(f.env.JOB_SEARCH_DB.batch(statements)).rejects.toMatchObject({ mode: "ordinary" });
    expect(underlyingBatch).not.toHaveBeenCalled();
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 29, batchStatements: 0, blockedAttempts: 2 });

    // A provider/storage failure after reservation still consumes every attempted batch member.
    underlyingBatch.mockRejectedValueOnce(new Error("synthetic D1 outage"));
    await expect(f.budget.withControl(() => f.env.JOB_SEARCH_DB.batch([f.env.JOB_SEARCH_DB.prepare("SELECT 1"), f.env.JOB_SEARCH_DB.prepare("SELECT 2")]))).rejects.toThrow("synthetic D1 outage");
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 31, databaseOperations: 31, batchStatements: 2, controlOperations: 2 });
    f.close();
  });

  it("counts statement execution methods, not prepare or bind", async () => {
    const f = await useFixture();
    const statement = f.env.JOB_SEARCH_DB.prepare("SELECT ? AS value");
    const bound = statement.bind(7);
    expect(f.budget.snapshot.totalOperations).toBe(0);
    expect(await bound.first()).toMatchObject({ value: 7 });
    expect(f.budget.snapshot.totalOperations).toBe(1);
    await f.env.JOB_SEARCH_DB.prepare("SELECT 1").all();
    await f.env.JOB_SEARCH_DB.prepare("INSERT INTO app_metadata(key,value) VALUES('budget-test','run')").run();
    await f.env.JOB_SEARCH_DB.exec("SELECT 1;");
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 4, databaseOperations: 4 });
    f.close();
  });

  it("keeps the ten-operation control reserve available after ordinary work reaches 30", async () => {
    const f = await useFixture();
    for (let index = 0; index < 30; index++) await f.env.JOB_SEARCH_DB.prepare("SELECT 1").first();
    await f.budget.withControl(async () => {
      for (let index = 0; index < 10; index++) await f.env.JOB_SEARCH_DB.prepare("SELECT 1").first();
    });
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 40, controlOperations: 10, limit: 40 });
    await expect(f.budget.withControl(() => f.env.JOB_SEARCH_DB.prepare("SELECT 1").first())).rejects.toMatchObject({ mode: "control" });
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 40, blockedAttempts: 1 });
    f.close();
  });

  it("charges provider and Workflow handoff attempts through explicit capabilities without patching global fetch", async () => {
    const f = await useFixture();
    const originalFetch = globalThis.fetch;
    reserveExternal(f.env);
    await f.budget.withControl(async () => reserveWorkflowHandoff(f.env));
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 2, externalCalls: 2, controlOperations: 1 });
    expect(globalThis.fetch).toBe(originalFetch);
    expect(Object.keys(f.budget.snapshot).sort()).toEqual(["batchStatements", "blockedAttempts", "controlOperations", "databaseOperations", "externalCalls", "limit", "totalOperations"].sort());
    expect(JSON.stringify(f.budget.snapshot)).not.toMatch(/token|body|url|header|payload/i);
    f.close();
  });

  it("counts failed ordinary SQL execution and makes wrapper capabilities immutable", async () => {
    const f = await useFixture();
    const scopedDatabase = f.env.JOB_SEARCH_DB;
    expect(() => { (f.env as unknown as { JOB_SEARCH_DB: D1Database }).JOB_SEARCH_DB = f.db; }).toThrow();
    await expect(scopedDatabase.prepare("SELECT FROM definitely_missing").run()).rejects.toThrow();
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 1, databaseOperations: 1 });
    expect(Object.isFrozen(f.budget)).toBe(true);
    f.close();
  });

  it("counts D1 raw calls and wrapper-prevents an over-limit raw query before the provider call", async () => {
    const f = await useFixture();
    let rawCalls = 0;
    const stmt = {
      bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return {}; },
      async raw() { rawCalls++; return []; },
    } as unknown as D1PreparedStatement;
    const fakeDb = {
      prepare: () => stmt,
      batch: vi.fn(async () => []),
      exec: vi.fn(async () => ({ count: 0, duration: 0 })),
    } as unknown as D1Database;
    const scoped = createExecutionBudget({ ...f.env, JOB_SEARCH_DB: fakeDb });
    await scoped.env.JOB_SEARCH_DB.prepare("SELECT 1").raw();
    for (let index = 0; index < 29; index++) await scoped.env.JOB_SEARCH_DB.prepare("SELECT 1").first();
    expect(() => scoped.env.JOB_SEARCH_DB.prepare("SELECT 1").raw()).toThrow(ExecutionBudgetExceeded);
    expect(rawCalls).toBe(1);
    expect(scoped.budget.snapshot).toMatchObject({ totalOperations: 30, blockedAttempts: 1 });
    f.close();
  });

  it("charges control provider and handoff calls from the same reserved ten-operation pool", async () => {
    const f = await useFixture();
    await f.budget.withControl(async () => {
      for (let index = 0; index < 5; index++) reserveExternal(f.env);
      for (let index = 0; index < 5; index++) reserveWorkflowHandoff(f.env);
    });
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 10, controlOperations: 10, externalCalls: 10 });
    await expect(f.budget.withControl(() => reserveExternal(f.env))).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 10, blockedAttempts: 1 });
    f.close();
  });

  it("charges empty batches as invalid attempts and wraps D1 sessions without resetting counters", async () => {
    const f = await useFixture();
    const session = {
      prepare: () => ({ bind() { return this; }, async first() { return { value: 1 }; } } as unknown as D1PreparedStatement),
      batch: async () => [],
    } as unknown as D1DatabaseSession;
    const database = {
      prepare: f.sourceEnv.JOB_SEARCH_DB.prepare.bind(f.db),
      batch: f.sourceEnv.JOB_SEARCH_DB.batch.bind(f.db),
      exec: f.sourceEnv.JOB_SEARCH_DB.exec.bind(f.db),
      withSession: vi.fn(() => session),
    } as unknown as D1Database;
    const scoped = createExecutionBudget({ ...f.sourceEnv, JOB_SEARCH_DB: database });
    await expect(scoped.env.JOB_SEARCH_DB.batch([])).rejects.toThrow("workflow_operation_budget_invalid");
    expect(database.withSession).toBeDefined();
    const sessionScoped = scoped.env.JOB_SEARCH_DB.withSession("first-primary");
    expect(await sessionScoped.prepare("SELECT 1").first()).toMatchObject({ value: 1 });
    expect(scoped.budget.snapshot).toMatchObject({ totalOperations: 1, databaseOperations: 1 });
    f.close();
  });

  it("restores ordinary charging after a control callback fails and leaves unscoped provider calls untouched", async () => {
    const f = await useFixture();
    await expect(f.budget.withControl(() => { reserveExternal(f.env); throw new Error("control failed"); })).rejects.toThrow("control failed");
    // External helpers intentionally do nothing for an unscoped environment.
    reserveExternal(f.sourceEnv);
    reserveWorkflowHandoff(f.sourceEnv);
    await f.env.JOB_SEARCH_DB.prepare("SELECT 1").first();
    expect(f.budget.snapshot).toMatchObject({ totalOperations: 2, controlOperations: 1, externalCalls: 1, databaseOperations: 1 });
    f.close();
  });
});
