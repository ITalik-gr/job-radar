#!/usr/bin/env node
/**
 * Builds the config wrangler actually deploys with.
 *
 *   wrangler.jsonc        committed, generic, the same for every fork
 *   wrangler.local.jsonc  yours, gitignored: database id, From name, gateway, worker URL
 *   wrangler.deploy.json  generated here, gitignored, passed to wrangler with --config
 *
 * Why not leave database_id out and let wrangler find the database by name: that lookup
 * is an extra D1 API call, and a deploy token without D1 permissions fails on it with
 * "Authentication error [code: 10000]" before anything is uploaded. With the id present
 * wrangler asks nothing.
 *
 * Why vars rather than secrets for the personal values: a deploy deletes every var that
 * is missing from the config, and a secret cannot take the name of an existing var. Keeping
 * them as vars in a file that only you have avoids both traps.
 *
 * In CI the local file does not exist, so the workflow writes it from the
 * WRANGLER_LOCAL_JSONC repository secret first. Without a local file the output is the
 * committed config unchanged, which is what a fresh fork deploys with.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = 'wrangler.jsonc';
const LOCAL = 'wrangler.local.jsonc';
const OUT = 'wrangler.deploy.json';

/** Drops comments and trailing commas, leaving string contents alone ("/api/*" included). */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') out += text[++i];
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment');
      i = end + 1;
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * vars merge key by key, D1 bindings merge by binding name (so the local file can add just a
 * database_id), anything else in the local file replaces the committed value.
 */
export function mergeConfig(base, local) {
  const merged = { ...base, ...local };
  if (base.vars || local.vars) merged.vars = { ...base.vars, ...local.vars };
  if (local.d1_databases) {
    const overrides = new Map(local.d1_databases.map((db) => [db.binding, db]));
    merged.d1_databases = (base.d1_databases ?? []).map((db) => ({ ...db, ...overrides.get(db.binding) }));
    for (const db of local.d1_databases) {
      if (!merged.d1_databases.some((item) => item.binding === db.binding)) merged.d1_databases.push(db);
    }
  }
  return merged;
}

function main() {
  const base = parseJsonc(readFileSync(BASE, 'utf8'));
  const hasLocal = existsSync(LOCAL);
  const config = hasLocal ? mergeConfig(base, parseJsonc(readFileSync(LOCAL, 'utf8'))) : base;
  delete config.$schema;
  writeFileSync(OUT, JSON.stringify(config, null, 2) + '\n');
  console.log(`${OUT} written from ${BASE}${hasLocal ? ` and ${LOCAL}` : ` (no ${LOCAL}, generic config)`}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
