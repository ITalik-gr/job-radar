#!/usr/bin/env node
/**
 * One command from a fresh clone to a running worker: `pnpm cf:setup`.
 *
 *   1. checks that wrangler is logged in
 *   2. finds the D1 database by name, or creates it
 *   3. writes its id into wrangler.local.jsonc (gitignored)
 *   4. applies migrations
 *   5. builds the frontend and deploys, uploading missing secrets in the same step
 *
 * Safe to run again: an existing database, id and secret are reused, never replaced.
 * `--dry-run` checks everything and runs `wrangler deploy --dry-run`, changing nothing.
 *
 * Secrets go up with the deploy itself (`--secrets-file`) rather than after it, so the
 * worker is never live without RADAR_TOKEN, not even for a minute.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonc } from './wrangler-config.mjs';

const DRY = process.argv.includes('--dry-run');
const LOCAL = 'wrangler.local.jsonc';
const DEPLOY_CONFIG = 'wrangler.deploy.json';

/** Taken from .env when present and not yet set on the worker. RADAR_TOKEN is generated. */
const SECRETS_FROM_ENV = [
  'ANTHROPIC_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'RESEND_API_KEY',
  'GMAIL_FROM_EMAIL',
];

function step(text) {
  console.log(`\n> ${text}`);
}

function fail(text) {
  console.error(`\n${text}`);
  process.exit(1);
}

function wrangler(args, { capture = false } = {}) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
}

/** wrangler can print a banner before the JSON, so start at the first bracket. */
function json(text) {
  const start = text.search(/[[{]/);
  return start === -1 ? null : JSON.parse(text.slice(start));
}

function readEnv() {
  if (!existsSync('.env')) return {};
  const env = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && match[2]) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) fail(`failed: ${command} ${args.join(' ')}`);
}

// 1. Login
step('Checking the Cloudflare login');
const who = wrangler(['whoami', '--json'], { capture: true });
const me = who.ok ? json(who.out) : null;
if (!me?.loggedIn) fail('Not logged in. Run `pnpm wrangler login` and then this command again.');
console.log(`logged in as ${me.email ?? 'API token'}`);

// 2. Database
const base = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
const dbName = base.d1_databases?.[0]?.database_name;
if (!dbName) fail('wrangler.jsonc has no d1_databases entry.');

const local = existsSync(LOCAL) ? parseJsonc(readFileSync(LOCAL, 'utf8')) : {};
let databaseId = local.d1_databases?.find((db) => db.binding === 'DB')?.database_id || '';

if (databaseId) {
  step(`Database id already in ${LOCAL}`);
} else {
  step(`Looking for the D1 database "${dbName}"`);
  const list = wrangler(['d1', 'list', '--json'], { capture: true });
  if (!list.ok) fail(`wrangler d1 list failed:\n${list.err}`);
  databaseId = (json(list.out) ?? []).find((db) => db.name === dbName)?.uuid ?? '';

  if (databaseId) {
    console.log(`found, ${databaseId}`);
  } else if (DRY) {
    console.log('not found, would be created (dry run)');
  } else {
    console.log('not found, creating it');
    if (!wrangler(['d1', 'create', dbName]).ok) fail('wrangler d1 create failed.');
    const info = wrangler(['d1', 'info', dbName, '--json'], { capture: true });
    databaseId = json(info.out)?.uuid ?? '';
    if (!databaseId) fail('Created the database but could not read its id back.');
  }

  // 3. Remember the id, keeping whatever else the local file already holds
  if (databaseId && !DRY) {
    const bindings = (base.d1_databases ?? []).map((db) => ({ binding: db.binding, database_id: databaseId }));
    const next = { ...local, d1_databases: bindings };
    writeFileSync(
      LOCAL,
      `// Personal deploy settings. Gitignored, never commit this file.\n` +
        `// See wrangler.local.example.jsonc for what else can go here.\n` +
        `${JSON.stringify(next, null, '\t')}\n`,
    );
    console.log(`saved to ${LOCAL}`);
  }
}

run('node', ['scripts/wrangler-config.mjs']);

// 4. Migrations
if (DRY) {
  step('Pending migrations (dry run, nothing applied)');
  if (databaseId) wrangler(['d1', 'migrations', 'list', dbName, '--remote', '--config', DEPLOY_CONFIG]);
} else {
  step('Applying migrations');
  if (!wrangler(['d1', 'migrations', 'apply', dbName, '--remote', '--config', DEPLOY_CONFIG]).ok) {
    fail('Migrations failed, nothing was deployed.');
  }
}

// 5. Secrets that the worker does not have yet
step('Checking secrets');
const listed = wrangler(['secret', 'list', '--format', 'json', '--config', DEPLOY_CONFIG], { capture: true });
// A worker that was never deployed has no secret list, which simply means nothing is set.
const existing = new Set(listed.ok ? (json(listed.out) ?? []).map((item) => item.name) : []);
const env = readEnv();
const secrets = {};
let generatedToken = '';

if (!existing.has('RADAR_TOKEN')) {
  generatedToken = env.RADAR_TOKEN || randomBytes(24).toString('base64url');
  secrets.RADAR_TOKEN = generatedToken;
}
for (const key of SECRETS_FROM_ENV) {
  if (!existing.has(key) && env[key]) secrets[key] = env[key];
}

const names = Object.keys(secrets);
console.log(names.length > 0 ? `will upload: ${names.join(', ')}` : 'nothing missing');
const skipped = SECRETS_FROM_ENV.filter((key) => !existing.has(key) && !env[key]);
if (skipped.length > 0) console.log(`not in .env, left unset: ${skipped.join(', ')}`);

// 6. Build and deploy
step('Building the frontend');
run('pnpm', ['build:web']);

step(DRY ? 'Deploying (dry run)' : 'Deploying');
const deployArgs = ['deploy', '--config', DEPLOY_CONFIG];
let secretsDir = '';
if (DRY) {
  deployArgs.push('--dry-run');
} else if (names.length > 0) {
  secretsDir = mkdtempSync(join(tmpdir(), 'job-radar-'));
  const file = join(secretsDir, 'secrets.json');
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  deployArgs.push('--secrets-file', file);
}
const deployed = wrangler(deployArgs);
if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
if (!deployed.ok) fail('Deploy failed.');

if (DRY) {
  console.log('\nDry run finished, nothing was changed.');
} else {
  console.log('\nDone. The worker URL is printed above.');
  if (generatedToken) {
    console.log(`\nRADAR_TOKEN (the interface password, shown once, keep it):\n  ${generatedToken}`);
    console.log('First visit: https://<your-worker>/?token=<RADAR_TOKEN>, after that the browser remembers it.');
  }
}
