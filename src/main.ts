import { serve } from '@hono/node-server';
import './db/client.node.js';
import './lib/gmail-store.node.js';
import { app } from './api/index.js';
import { runMigrations } from './db/migrate.js';
import { log } from './lib/log.js';
import { startScheduler } from './scheduler.js';
import { isConfigured, startBot, stopBot } from './notify/telegram.js';
import { refreshRulesFromDb, watchRules } from './pipeline/rules.js';

/** Один процес: міграції, API, планувальник і телеграм-бот для довідки. */
const port = Number(process.env.API_PORT ?? 3000);

runMigrations().sqlite.close();
watchRules();
// Правки правил з інтерфейсу лежать у базі і старші за файл, тому читаються на старті.
void refreshRulesFromDb();

const server = serve({ fetch: app.fetch, port });

// Найчастіша помилка запуску це забутий попередній процес. Стектрейс тут нічого
// не пояснює, тому ловимо явно і кажемо, що робити.
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    log.error(
      { port },
      `порт ${port} уже зайнятий. Або десь працює інший Job Radar, або лишився старий процес.\n` +
        `  подивитись хто це:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
        `  зупинити:           kill $(lsof -t -iTCP:${port} -sTCP:LISTEN)\n` +
        `  або запустити на іншому порту:  API_PORT=3001 pnpm start`,
    );
    process.exit(1);
  }
  log.error({ err: error.message }, 'сервер не піднявся');
  process.exit(1);
});

if (process.env.SCHEDULER !== 'off') startScheduler();
if (isConfigured() && process.env.TELEGRAM_BOT !== 'off') void startBot();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('зупиняюсь');
    void stopBot();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

log.info(
  { port, telegram: isConfigured() ? 'налаштований' : 'вимкнений', scheduler: process.env.SCHEDULER !== 'off' },
  'Job Radar запущено',
);
