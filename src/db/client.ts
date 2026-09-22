import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.js';

/**
 * The portable part of database access. The native better-sqlite3 driver lives
 * separately in `client.node.ts`: otherwise it ends up in the Cloudflare Worker
 * bundle, where it is useless, and drags along two megabytes.
 *
 * A shared type for both drivers: better-sqlite3 in Node runs synchronously, D1 on
 * Workers asynchronously. The code awaits the result everywhere, so both fit.
 */
export type DrizzleDb = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>;

let injected: DrizzleDb | null = null;
let factory: (() => DrizzleDb) | null = null;

/** On Cloudflare the database arrives as a D1 binding on every request. */
export function setDb(db: DrizzleDb): void {
  injected = db;
}

/** In Node, `client.node.ts` sets the lazy factory, so the driver is not dragged in here. */
export function setDbFactory(create: () => DrizzleDb): void {
  factory = create;
}

export function getDb(): DrizzleDb {
  if (injected) return injected;
  if (!factory) throw new Error('database is not connected: import db/client.node.js or call setDb');
  injected = factory();
  return injected;
}

export function resetDb(): void {
  injected = null;
}

export { schema };
