import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { setTokenStore, type StoredToken } from './gmail.js';

/**
 * Файлове сховище рефреш-токена для Node. Імпортується там, де є файлова система:
 * CLI, локальний API, планувальник. У бандл воркера цей файл не потрапляє.
 *
 * Токен лежить окремим файлом, а не в базі: бекап бази з рефреш-токеном усередині
 * означав би доступ до пошти власника в кожному архіві.
 */
setTokenStore({
  load(): StoredToken | null {
    if (!existsSync(config.gmail.tokenPath)) return null;
    const parsed = JSON.parse(readFileSync(config.gmail.tokenPath, 'utf8')) as StoredToken;
    return parsed.refreshToken ? parsed : null;
  },
  save(token: StoredToken): void {
    mkdirSync(dirname(config.gmail.tokenPath), { recursive: true });
    // Права 600: файл дає доступ до пошти, і читати його має тільки власник.
    writeFileSync(config.gmail.tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  },
  forget(): void {
    if (existsSync(config.gmail.tokenPath)) writeFileSync(config.gmail.tokenPath, '{}\n');
  },
});
