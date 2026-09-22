import { config } from '../config.js';
import { setTokenStore, type StoredToken } from './gmail.js';

/**
 * Token store for environments without a filesystem: Cloudflare Workers.
 *
 * The refresh token arrives as a secret (`wrangler secret put GMAIL_REFRESH_TOKEN`) and does not
 * change for months, so there is nowhere it needs writing. The short-lived access token is kept
 * in isolate memory: it lives an hour, an isolate usually lives less, and at worst that means
 * one extra request to Google.
 *
 * The token deliberately never goes into the database, section 0 of OUTREACH.md: secrets stay
 * apart from data, otherwise every database backup becomes mailbox access.
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
    // A worker secret cannot be rewritten from outside, so only the short-lived part is kept.
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
