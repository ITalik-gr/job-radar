import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 20000,
    // Тести, що чіпають базу, працюють з одним файлом data/test-radar.db,
    // тому файли тестів виконуються послідовно.
    fileParallelism: false,
    // Локальний драйвер бази підключається один раз на весь прогін.
    setupFiles: ['tests/setup.ts'],
    // У тестах троттлінг лишається живим, але коротким: механіку перевіряємо,
    // а десять секунд очікування на кожен прогін не платимо.
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
