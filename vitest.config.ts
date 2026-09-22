import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 20000,
    // Tests that touch the database work with a single data/test-radar.db file,
    // so test files run sequentially.
    fileParallelism: false,
    // The local database driver connects once for the whole run.
    setupFiles: ['tests/setup.ts'],
    // Throttling stays alive in tests but short: we verify the mechanics,
    // without paying ten seconds of waiting on every run.
    env: {
      HTTP_DOMAIN_DELAY_MS: '50',
      LOG_LEVEL: 'silent',
      LOG_FILE: 'logs/test.log',
      DB_PATH: 'data/test-radar.db',
      // Empty on purpose: dotenv does not override variables that already exist, so the
      // real bot from .env stays unreachable and a test run never messages the owner.
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
    },
  },
});
