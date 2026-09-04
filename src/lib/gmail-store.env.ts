import { config } from '../config.js';
import { setTokenStore, type StoredToken } from './gmail.js';

/**
 * Сховище токена для середовищ без файлової системи: Cloudflare Workers.
 *
 * Рефреш-токен приходить секретом (`wrangler secret put GMAIL_REFRESH_TOKEN`) і
 * не змінюється місяцями, тому писати його нікуди не треба. Короткоживучий
 * access token тримається в памʼяті ізоляту: він живе годину, ізолят зазвичай
 * менше, і в найгіршому випадку буде на один зайвий запит до Google більше.
 *
 * У базу токен не кладеться свідомо, розділ 0 OUTREACH.md: секрети окремо від
 * даних, інакше кожен бекап бази стає доступом до пошти.
 */
let cached: { accessToken: string; expiresAt?: number; email?: string } | null = null;

setTokenStore({
  load(): StoredToken | null {
    const refreshToken = config.gmail.refreshToken;
    if (!refreshToken) return null;
    return {
      refreshToken,
      accessToken: cached?.accessToken,
      expiresAt: cached?.expiresAt,
      email: cached?.email ?? config.gmail.fromEmail,
    };
  },
  save(token: StoredToken): void {
    // Секрет воркера ззовні не переписати, тому зберігається лише те, що коротке.
    if (token.accessToken) {
      cached = {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
        email: token.email ?? cached?.email,
      };
    }
  },
  forget(): void {
    cached = null;
  },
});
