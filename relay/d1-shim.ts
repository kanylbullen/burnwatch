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
  async run() {
    const r = this.db.query(this.sql).run(...(this.args as never[]));
    return { success: true, meta: { changes: r.changes } };
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
    batch: async (stmts: Stmt[]) => {
      const out = [];
      db.exec("BEGIN");
      try {
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return out;
    },
  };
  return shim as unknown as D1Database;
}
