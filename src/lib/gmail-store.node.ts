import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { setTokenStore, type StoredToken } from './gmail.js';

/**
 * File-based refresh token store for Node. Imported where there is a filesystem: the CLI, the
 * local API, the scheduler. This file never reaches the worker bundle.
 *
 * The token lives in a separate file rather than the database: a database backup with the
 * refresh token inside would mean access to the owner's mailbox in every archive.
 */
setTokenStore({
  load(): StoredToken | null {
    if (!existsSync(config.gmail.tokenPath)) return null;
    const parsed = JSON.parse(readFileSync(config.gmail.tokenPath, 'utf8')) as StoredToken;
    return parsed.refreshToken ? parsed : null;
  },
  save(token: StoredToken): void {
    mkdirSync(dirname(config.gmail.tokenPath), { recursive: true });
    // Mode 600: the file grants mailbox access, and only the owner may read it.
    writeFileSync(config.gmail.tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  },
  forget(): void {
    if (existsSync(config.gmail.tokenPath)) writeFileSync(config.gmail.tokenPath, '{}\n');
  },
});
