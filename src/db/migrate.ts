import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import { log } from '../lib/log.js';
import { createDb } from './client.node.js';

export function runMigrations(path: string = config.dbPath) {
  const { db, sqlite } = createDb(path);
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  return { db, sqlite };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  log.info({ db: config.dbPath }, 'міграції застосовано');
  process.exit(0);
}
