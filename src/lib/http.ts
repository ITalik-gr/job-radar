import pLimit from 'p-limit';
import pRetry, { AbortError } from 'p-retry';
import robotsParser from 'robots-parser';
import { config } from '../config.js';
import { log } from './log.js';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt forbids ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

const globalLimit = pLimit(config.http.concurrency);

/**
 * Using the global fetch instead of undici directly: the same code must work both in
 * Node and on Cloudflare Workers. fetch follows redirects itself.
 */
async function get(url: string, headers: Record<string, string>, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// No more than one request per domain per second: we track the time of the next allowed start.
const nextSlotByHost = new Map<string, number>();

async function waitForSlot(host: string): Promise<void> {
  const delay = config.http.domainDelayMs;
  const now = Date.now();
  const earliest = Math.max(now, nextSlotByHost.get(host) ?? 0);
  nextSlotByHost.set(host, earliest + delay);
  const wait = earliest - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

type RobotsEntry = { checkedAt: number; robots: ReturnType<typeof robotsParser> | null };
const robotsCache = new Map<string, Promise<RobotsEntry>>();

async function loadRobots(origin: string): Promise<RobotsEntry> {
  const url = `${origin}/robots.txt`;
  try {
    const res = await get(url, { 'user-agent': config.http.userAgent }, config.http.timeoutMs);
    if (!res.ok) {
      // No robots.txt means allowed, this is the standard behavior.
      return { checkedAt: Date.now(), robots: null };
    }
    return { checkedAt: Date.now(), robots: robotsParser(url, await res.text()) };
  } catch (error) {
    log.warn({ url, err: String(error) }, 'could not read robots.txt, treating as allowed');
    return { checkedAt: Date.now(), robots: null };
  }
}

export async function isAllowed(target: string): Promise<boolean> {
  const { origin } = new URL(target);
  let entry = robotsCache.get(origin);
  if (!entry) {
    entry = loadRobots(origin);
    robotsCache.set(origin, entry);
  }
  const { robots } = await entry;
  if (!robots) return true;
  return robots.isAllowed(target, config.http.userAgent) !== false;
}

export function resetHttpCaches(): void {
  robotsCache.clear();
  nextSlotByHost.clear();
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Skip the robots.txt check. Only for the ATS's own API endpoints. */
  ignoreRobots?: boolean;
  retries?: number;
  timeoutMs?: number;
}

export interface FetchResult {
  url: string;
  status: number;
  body: string;
  headers: Record<string, string>;
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const { host } = new URL(url);

  if (!options.ignoreRobots && !(await isAllowed(url))) {
    throw new RobotsDisallowedError(url);
  }

  const attempt = async (): Promise<FetchResult> => {
    await waitForSlot(host);
    const timeout = options.timeoutMs ?? config.http.timeoutMs;
    const res = await get(
      url,
      {
        'user-agent': config.http.userAgent,
        'accept-language': 'en,uk;q=0.8',
        ...options.headers,
      },
      timeout,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = new HttpError(`${res.status} on ${url}: ${body.slice(0, 200)}`, res.status, url);
      // No point retrying a 4xx other than 408 and 429.
      if (res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new AbortError(error);
      }
      throw error;
    }

    return {
      url,
      status: res.status,
      body: await res.text(),
      headers: Object.fromEntries(res.headers.entries()),
    };
  };

  return globalLimit(() =>
    pRetry(attempt, {
      retries: options.retries ?? config.http.retries,
      minTimeout: 1000,
      factor: 2,
      onFailedAttempt: (error) => {
        log.warn(
          { url, attempt: error.attemptNumber, left: error.retriesLeft, err: error.message },
          'request failed, retrying',
        );
      },
    }),
  );
}

export async function fetchJson<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const res = await fetchText(url, {
    ...options,
    headers: { accept: 'application/json', ...options.headers },
  });
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new HttpError(`invalid JSON from ${url}`, res.status, url);
  }
}
