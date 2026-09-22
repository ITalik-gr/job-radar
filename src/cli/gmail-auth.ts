import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { authUrl, exchangeCode, redirectUri, type StoredToken } from '../lib/gmail.js';

/**
 * Desktop OAuth flow: a local server catches the `code` from the browser redirect.
 *
 * Copying the code by hand from the address bar also works, but you mistype it one
 * time in three, and the error looks like "invalid_grant" with no explanation.
 * Hence the server.
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
    // The browser did not open, the link is already printed in the console, that is enough.
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
        response.end(PAGE('Failed', `Google returned: ${error ?? 'empty code'}`));
        server.close();
        reject(new Error(`Gmail OAuth: ${error ?? 'empty code'}`));
        return;
      }

      try {
        const token = await exchangeCode(code);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE('Gmail connected', `Account: ${token.email ?? 'unknown'}. You can close this tab.`));
        server.close();
        resolve(token);
      } catch (failure) {
        response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE('Failed', String(failure)));
        server.close();
        reject(failure instanceof Error ? failure : new Error(String(failure)));
      }
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('confirmation timed out, retry: pnpm cli auth:gmail'));
    }, timeoutMs);
    timer.unref();

    server.on('close', () => clearTimeout(timer));
    server.listen(config.gmail.authPort, '127.0.0.1', () => {
      console.log(`redirect_uri for the Google console: ${redirectUri()}`);
      console.log('opening the browser, if it did not open, the link is below:');
      console.log(url);
      openBrowser(url);
    });
  });
}
