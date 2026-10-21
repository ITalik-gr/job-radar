import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type ConsentDescription,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { sameSecret } from '../lib/secret.js';
import { handleMcp } from './route.js';

/**
 * OAuth in front of `/mcp`, so claude.ai and Claude Desktop can connect as custom connectors.
 * Worker only: the library imports `cloudflare:workers` and keeps grants in the OAUTH_KV
 * namespace, so the Node build never loads this file and stays on the plain bearer token.
 *
 * There is one user. Signing in is typing RADAR_TOKEN on the consent page, nothing more:
 * no accounts, no third-party login, section 12 of CLAUDE.md. Claude Code keeps sending
 * RADAR_TOKEN itself as the bearer, which `resolveExternalToken` accepts.
 */

export const AUTHORIZE_PATH = '/api/oauth/authorize';
const SCOPE = 'radar';
const USER_ID = 'owner';

export interface OAuthEnv {
  RADAR_TOKEN?: string;
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}

type Handler = { fetch: (request: Request, env: never, ctx: ExecutionContext) => Promise<Response> };

/**
 * The provider needs its canonical resource URL at construction, and that is the worker's own
 * address, different in every fork. So it is built on the first request from the request
 * origin and kept per origin for the life of the isolate.
 */
const providers = new Map<string, OAuthProvider<OAuthEnv>>();

export function oauthProvider(
  origin: string,
  hooks: { prepare: (env: OAuthEnv) => Promise<void>; site: Handler },
): OAuthProvider<OAuthEnv> {
  const cached = providers.get(origin);
  if (cached) return cached;

  const resource = `${origin}/mcp`;
  const provider = new OAuthProvider<OAuthEnv>({
    apiRoute: '/mcp',
    apiHandler: {
      async fetch(request, env) {
        await hooks.prepare(env);
        return handleMcp(request);
      },
    },
    defaultHandler: {
      async fetch(request, env, ctx) {
        if (new URL(request.url).pathname === AUTHORIZE_PATH) return authorize(request, env);
        return hooks.site.fetch(request, env as never, ctx);
      },
    },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: '/api/oauth/token',
    clientRegistrationEndpoint: '/api/oauth/register',
    scopesSupported: [SCOPE],
    resourceMetadata: { resource, resource_name: 'Lead Radar' },
    // A refresh keeps a connector alive as long as it is used, a month idle and it asks again.
    refreshTokenTTL: 30 * 86_400,
    refreshTokenIdleTTL: 30 * 86_400,
    async resolveExternalToken({ token, env }) {
      return env.RADAR_TOKEN && sameSecret(token, env.RADAR_TOKEN)
        ? { props: { via: 'radar-token' }, audience: resource }
        : null;
    },
  });

  providers.set(origin, provider);
  return provider;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const html = (body: string, status = 200, headers = new Headers()) => {
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Lead Radar access</title>
<body style="font:15px system-ui;background:#1a1b1e;color:#e9ecef;padding:32px;max-width:560px;margin:auto">${body}</body>`, {
    status,
    headers,
  });
};

/** Everything here came from the client's registration and is escaped, a client picks its own name. */
function consentPage(details: ConsentDescription, handle: string, error: string | null): string {
  return `<h2>Connect ${escape(details.clientName)} to Lead Radar?</h2>
<p>It will be able to read and change companies, contacts, templates and settings, and to queue
drafts. It cannot send letters.</p>
<p>Access goes to <strong>${escape(details.redirectHost)}</strong>.
${details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : 'The app registered itself, its name is not verified.'}</p>
${details.redirectIsLoopback ? '<p><strong>This sends access to an app on this computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
${error ? `<p style="color:#ff8787">${escape(error)}</p>` : ''}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><label>RADAR_TOKEN<br><input name="password" type="password" autocomplete="current-password" autofocus
    style="width:100%;padding:8px;margin-top:4px;background:#25262b;color:inherit;border:1px solid #373a40"></label></p>
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

/**
 * The consent page. GET shows it, POST checks the password and approves or declines.
 * A wrong password consumes nothing: the handle is used up only by approving or declining, so
 * going back and typing again works, and a typo does not send the owner back to the client.
 */
async function authorize(request: Request, env: OAuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return html('<p>OAuth is not configured on this worker.</p>', 500);

  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return html(consentPage(details, consent.handle, null), 200, consent.headers);
    }

    if (request.method !== 'POST') return html('<p>Method not allowed.</p>', 405);

    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');

    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const password = String(form.get('password') ?? '');
    if (!env.RADAR_TOKEN || !sameSecret(password, env.RADAR_TOKEN)) {
      return html(
        `<h2>Wrong token</h2><p>Go back and try again, or start connecting from the app once more.</p>`,
        401,
      );
    }

    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: USER_ID,
      metadata: {},
      scope: [SCOPE],
      props: { via: 'oauth' },
    });
    approved.headers.set('location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    // A redirect back is safe only once the library has validated the client and its redirect URI.
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return html(`<p>${escape(error.description)}</p>`, 400);
    if (error instanceof CimdFetchError) return html('<p>This app could not be verified.</p>', 400);
    throw error;
  }
}
