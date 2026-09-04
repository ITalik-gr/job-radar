import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { authUrl, exchangeCode, redirectUri, type StoredToken } from '../lib/gmail.js';

/**
 * Desktop OAuth flow: локальний сервер ловить `code` з редіректу браузера.
 *
 * Копіювати код руками з адресного рядка теж працює, але помиляєшся в ньому раз
 * із трьох, а помилка виглядає як "invalid_grant" без пояснень. Тому сервер.
 */

const PAGE = (title: string, note: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;padding:40px"><h1>${title}</h1><p>${note}</p></body>`;

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Браузер не відкрився, посилання вже надруковане в консолі, цього досить.
  }
}

export async function authorize(timeoutMs = 180_000): Promise<StoredToken> {
  const url = authUrl();

  return new Promise<StoredToken>((resolve, reject) => {
    const server = createServer(async (request, response) => {
      const parsed = new URL(request.url ?? '/', `http://127.0.0.1:${config.gmail.authPort}`);
      if (parsed.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }

      const error = parsed.searchParams.get('error');
      const code = parsed.searchParams.get('code');

      if (error || !code) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE('Не вийшло', `Google повернув: ${error ?? 'порожній код'}`));
        server.close();
        reject(new Error(`Gmail OAuth: ${error ?? 'порожній код'}`));
        return;
      }

      try {
        const token = await exchangeCode(code);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE('Gmail підключено', `Акаунт: ${token.email ?? 'невідомий'}. Вкладку можна закрити.`));
        server.close();
        resolve(token);
      } catch (failure) {
        response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE('Не вийшло', String(failure)));
        server.close();
        reject(failure instanceof Error ? failure : new Error(String(failure)));
      }
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('час на підтвердження вийшов, повторити: pnpm cli auth:gmail'));
    }, timeoutMs);
    timer.unref();

    server.on('close', () => clearTimeout(timer));
    server.listen(config.gmail.authPort, '127.0.0.1', () => {
      console.log(`redirect_uri для консолі Google: ${redirectUri()}`);
      console.log('відкриваю браузер, якщо не відкрився, посилання нижче:');
      console.log(url);
      openBrowser(url);
    });
  });
}
