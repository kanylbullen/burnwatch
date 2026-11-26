/**
 * Just enough of D1's API over bun:sqlite to run the relay's real SQL in
 * tests. D1 is SQLite underneath, so the statements behave the same; this only
 * adapts the calling convention.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

class Stmt {
  constructor(
    private db: Database,
    private sql: string,
    private args: unknown[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args);
  }
  runSync() {
    const r = this.db.query(this.sql).run(...(this.args as never[]));
    return { success: true, meta: { changes: r.changes } };
  }
  async run() {
    return this.runSync();
  }
  async first<T>() {
    return (this.db.query(this.sql).get(...(this.args as never[])) ?? null) as T | null;
  }
  async all<T>() {
    return { results: this.db.query(this.sql).all(...(this.args as never[])) as T[] };
  }
}

export function memoryD1(migration: string): D1Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(migration, "utf8"));
  const shim = {
    prepare: (sql: string) => new Stmt(db, sql),
    // Synchronous on purpose: an await between BEGIN and COMMIT would let a
    // second batch start a transaction inside this one.
    batch: async (stmts: Stmt[]) => db.transaction(() => stmts.map((s) => s.runSync()))(),
  };
  return shim as unknown as D1Database;
}
