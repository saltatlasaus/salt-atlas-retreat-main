// Local stand-ins for D1 and R2, backed by Node's built-in SQLite, so the database logic
// runs against the real schema and the real migration in tests.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result, R2Bucket } from '../src/types.ts';

class Stmt implements D1PreparedStatement {
  private db: DatabaseSync;
  private sql: string;
  private params: unknown[];
  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values: unknown[]): D1PreparedStatement {
    return new Stmt(this.db, this.sql, values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)));
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.params as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.sql).all(...(this.params as never[])) as T[];
    return { results: rows.map((r) => ({ ...(r as object) }) as T), success: true, meta: {} };
  }
  async run(): Promise<D1Result> {
    const r = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { results: [], success: true, meta: { changes: r.changes } };
  }
  exec() {
    return this.db.prepare(this.sql).run(...(this.params as never[]));
  }
}

export class FakeD1 implements D1Database {
  db = new DatabaseSync(':memory:');
  constructor() {
    this.db.exec(readFileSync(new URL('../schema/prospecting_schema.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../migrations/0100_crawl_pipeline.sql', import.meta.url), 'utf8'));
  }
  prepare(sql: string): D1PreparedStatement {
    return new Stmt(this.db, sql);
  }
  /** Like D1: all statements in one transaction; any failure rolls everything back. */
  async batch<T>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.db.exec('BEGIN');
    try {
      for (const s of stmts) (s as Stmt).exec();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return stmts.map(() => ({ results: [], success: true, meta: {} }));
  }
  rows(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).all(...(p as never[])).map((r) => ({ ...(r as object) })) as Record<string, unknown>[];
  }
}

export class FakeR2 implements R2Bucket {
  store = new Map<string, string>();
  async put(key: string, value: string | ArrayBuffer) {
    this.store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
    return {};
  }
  async get(key: string) {
    const v = this.store.get(key);
    return v === undefined ? null : { text: async () => v };
  }
}
