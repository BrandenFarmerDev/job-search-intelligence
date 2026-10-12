/**
 * A per-Workflow-invocation operation envelope. Instrument only operations that
 * reach D1 or an external service; preparing and binding a statement are free.
 */
const MAX_OPERATIONS = 40;
const CONTROL_RESERVE = 10;
const ORDINARY_LIMIT = MAX_OPERATIONS - CONTROL_RESERVE;
const statementTargets = new WeakMap<object, D1PreparedStatement>();

export interface ExecutionBudgetSnapshot {
  readonly totalOperations: number;
  readonly databaseOperations: number;
  readonly batchStatements: number;
  readonly externalCalls: number;
  readonly controlOperations: number;
  readonly blockedAttempts: number;
  readonly limit: number;
}

export interface ExecutionBudget {
  readonly snapshot: ExecutionBudgetSnapshot;
  withControl<T>(operation: () => T | Promise<T>): Promise<T>;
  reserveExternal(): void;
  reserveHandoff(): void;
}

export class ExecutionBudgetExceeded extends Error {
  constructor(readonly mode: "ordinary" | "control") {
    super(mode === "ordinary" ? "workflow_operation_budget_exhausted" : "workflow_control_budget_exhausted");
    this.name = "ExecutionBudgetExceeded";
  }
}

export function createExecutionBudget(source: Env): { env: Env; budget: ExecutionBudget } {
  let ordinaryOperations = 0;
  let controlOperations = 0;
  let databaseOperations = 0;
  let batchStatements = 0;
  let externalCalls = 0;
  let blockedAttempts = 0;
  let controlDepth = 0;
  const total = () => ordinaryOperations + controlOperations;
  const reserve = (count: number, kind: "database" | "batch" | "external" | "handoff") => {
    const isControl = controlDepth > 0;
    if (count < 1 || !Number.isSafeInteger(count)) throw new Error("workflow_operation_budget_invalid");
    if (total() + count > MAX_OPERATIONS || (isControl ? controlOperations + count > CONTROL_RESERVE : ordinaryOperations + count > ORDINARY_LIMIT)) {
      blockedAttempts += count;
      throw new ExecutionBudgetExceeded(isControl ? "control" : "ordinary");
    }
    if (isControl) controlOperations += count; else ordinaryOperations += count;
    if (kind === "database" || kind === "batch") databaseOperations += count;
    if (kind === "batch") batchStatements += count;
    if (kind === "external" || kind === "handoff") externalCalls += count;
  };

  const unwrap = (statement: D1PreparedStatement) => statementTargets.get(statement as object) || statement;
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrapStatement(target.bind(...args));
        if (property === "first" || property === "all" || property === "run" || property === "raw") {
          const method = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
          return (...args: unknown[]) => {
            reserve(1, "database");
            return method.apply(target, args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set() { return false; },
    });
    statementTargets.set(proxy as object, statement);
    return proxy;
  };

  const wrapDatabase = (database: D1Database | D1DatabaseSession): D1Database => new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (...args: Parameters<D1Database["prepare"]>) => wrapStatement(target.prepare(...args));
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        // D1 batch is atomic. Reserve every member before calling D1 so a
        // partially charged batch can never reach the storage provider.
        reserve(statements.length, "batch");
        return target.batch(statements.map(unwrap));
      };
      if (property === "exec" && "exec" in target) return async (...args: Parameters<D1Database["exec"]>) => {
        reserve(1, "database");
        return target.exec(...args);
      };
      if (property === "withSession" && "withSession" in target) return (...args: Parameters<D1Database["withSession"]>) => wrapDatabase(target.withSession(...args));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set() { return false; },
  }) as D1Database;

  const scoped = Object.create(source) as Env & { EXECUTION_BUDGET?: { reserveExternal(): void; reserveHandoff(): void } };
  Object.defineProperty(scoped, "JOB_SEARCH_DB", { enumerable: true, configurable: false, writable: false, value: wrapDatabase(source.JOB_SEARCH_DB) });
  const budget: ExecutionBudget = Object.freeze({
    get snapshot() {
      return Object.freeze({ totalOperations: total(), databaseOperations, batchStatements, externalCalls, controlOperations, blockedAttempts, limit: MAX_OPERATIONS });
    },
    async withControl<T>(operation: () => T | Promise<T>): Promise<T> {
      controlDepth++;
      try { return await operation(); } finally { controlDepth--; }
    },
    reserveExternal() { reserve(1, "external"); },
    reserveHandoff() { reserve(1, "handoff"); },
  });
  // Provider services receive this immutable reservation capability and call it
  // immediately before each outbound fetch. Credentials and request data never
  // enter the budget object or its counters.
  Object.defineProperty(scoped, "EXECUTION_BUDGET", { configurable: false, enumerable: true, writable: false, value: Object.freeze({ reserveExternal: budget.reserveExternal, reserveHandoff: budget.reserveHandoff }) });
  return { env: scoped, budget };
}

/** Charge an outbound provider attempt before fetch. Does not wrap or replace global fetch. */
export function reserveExternal(env: Env): void {
  (env as Env & { EXECUTION_BUDGET?: { reserveExternal(): void } }).EXECUTION_BUDGET?.reserveExternal();
}

/** Charge a Workflow continuation/handoff attempt before invoking JOB_SYNC.create. */
export function reserveWorkflowHandoff(env: Env): void {
  (env as Env & { EXECUTION_BUDGET?: { reserveHandoff(): void } }).EXECUTION_BUDGET?.reserveHandoff();
}
