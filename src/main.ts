import { serve } from '@hono/node-server';
import './db/client.node.js';
import './lib/gmail-store.node.js';
import { app } from './api/index.js';
import { runMigrations } from './db/migrate.js';
import { log } from './lib/log.js';
import { startScheduler } from './scheduler.js';
import { isConfigured, startBot, stopBot } from './notify/telegram.js';
import { refreshRulesFromDb, watchRules } from './pipeline/rules.js';

/** One process: migrations, the API, the scheduler, and the Telegram bot for reference. */
const port = Number(process.env.API_PORT ?? 3000);

runMigrations().sqlite.close();
watchRules();
// Rule edits made from the interface live in the database and are newer than the file, so they get read on startup.
void refreshRulesFromDb();

const server = serve({ fetch: app.fetch, port });

// The most common startup error is a forgotten previous process. The stack trace
// explains nothing here, so it is caught explicitly and tells what to do.
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    log.error(
      { port },
      `port ${port} is already in use. Either another Job Radar is running somewhere, or an old process is stuck.\n` +
        `  see who it is:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
        `  stop it:        kill $(lsof -t -iTCP:${port} -sTCP:LISTEN)\n` +
        `  or start on a different port:  API_PORT=3001 pnpm start`,
    );
    process.exit(1);
  }
  log.error({ err: error.message }, 'server failed to start');
  process.exit(1);
});

if (process.env.SCHEDULER !== 'off') startScheduler();
if (isConfigured() && process.env.TELEGRAM_BOT !== 'off') void startBot();

/*
 * The last line of defense. Every scheduled task is already wrapped in `safely`, but
 * the process has to live for weeks unattended, and one uncaught promise somewhere
 * in new code crashes all of Node by default. A radar stopped silently is worse than
 * an error in the log: it looks like it is working right up until the day the owner
 * notices there have been no new vacancies for a week.
 */
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled promise rejection');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutting down');
    void stopBot();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

log.info(
  { port, telegram: isConfigured() ? 'configured' : 'disabled', scheduler: process.env.SCHEDULER !== 'off' },
  'Job Radar started',
);
