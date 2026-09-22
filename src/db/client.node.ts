import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import { setDbFactory, type DrizzleDb } from './client.js';
import * as schema from './schema.js';

/** Local driver. Imported only from Node entry points: CLI, main.ts, tests. */
export function createDb(path: string = config.dbPath) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return { db: drizzle(sqlite, { schema }), sqlite };
}

let cached: ReturnType<typeof createDb> | null = null;

setDbFactory(() => {
  cached ??= createDb();
  return cached.db as unknown as DrizzleDb;
});

export function getSqlite() {
  cached ??= createDb();
  return cached.sqlite;
}
