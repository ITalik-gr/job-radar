import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { config } from '../config.js';
import { sameSecret } from '../lib/secret.js';
import { createMcpServer } from './server.js';

/**
 * Streamable HTTP at `/mcp`, stateless: a fresh server and transport per request, plain JSON
 * answers, no sessions. A worker isolate keeps nothing between requests anyway, and every tool
 * is one request and one answer.
 */
export const mcpRoutes = new Hono();

/**
 * Bearer token only, and closed without one, even locally. The API stays open on loopback
 * without a token for the interface, but this endpoint hands the whole contact base to any
 * client that can reach it, and a browser page can reach loopback.
 */
mcpRoutes.use('*', async (c, next) => {
  if (!config.token) {
    return c.json({ error: 'RADAR_TOKEN is not set, the MCP endpoint stays closed without it' }, 503);
  }
  const provided = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!provided || !sameSecret(provided, config.token)) {
    return c.json({ error: 'missing or invalid token' }, 401, { 'www-authenticate': 'Bearer' });
  }
  return next();
});

mcpRoutes.all('/', (c) => handleMcp(c.req.raw));

/**
 * One MCP request, already authenticated. On the worker the OAuth provider calls this
 * directly after checking the token, locally the bearer middleware above does.
 */
export async function handleMcp(request: Request): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
