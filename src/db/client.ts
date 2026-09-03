import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.js';

/**
 * Портативна частина доступу до бази. Нативний драйвер better-sqlite3 живе окремо
 * у `client.node.ts`: інакше він потрапляє в бандл Cloudflare Worker, де ні на що
 * не здатний, і тягне за собою два мегабайти.
 *
 * Спільний тип для двох драйверів: better-sqlite3 у Node працює синхронно,
 * D1 на Workers асинхронно. Код скрізь чекає результат, тому підходять обидва.
 */
export type DrizzleDb = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>;

let injected: DrizzleDb | null = null;
let factory: (() => DrizzleDb) | null = null;

/** На Cloudflare база приходить біндінгом D1 на кожен запит. */
export function setDb(db: DrizzleDb): void {
  injected = db;
}

/** У Node ліниву фабрику ставить `client.node.ts`, щоб не тягнути драйвер сюди. */
export function setDbFactory(create: () => DrizzleDb): void {
  factory = create;
}

export function getDb(): DrizzleDb {
  if (injected) return injected;
  if (!factory) throw new Error('база не підключена: імпортуй db/client.node.js або виклич setDb');
  injected = factory();
  return injected;
}

export function resetDb(): void {
  injected = null;
}

export { schema };
