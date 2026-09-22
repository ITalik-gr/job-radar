import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import journal from '../src/db/migrations/meta/_journal.json' with { type: 'json' };

/**
 * Migration bookkeeping. The check is cheap and boring, but it catches an expensive case:
 * the database falls behind the code, and the app fails not where the bug is, but on the
 * first page that touches the new column. That is exactly how the Studios page used to
 * return a 500 "no such column: needs_browser" while `deep=1` still answered "ok".
 */

describe('migrations', () => {
  const files = readdirSync('src/db/migrations').filter((name) => name.endsWith('.sql'));

  it('the journal knows about every migration file', () => {
    expect(journal.entries).toHaveLength(files.length);
  });

  /*
   * The health check counts journal entries specifically, so the journal must be what
   * the worker sees. The file lands in the bundle through an import, so an error here
   * means a silently wrong number on `/api/health?deep=1`.
   */
  it('every journal entry points to an existing file', () => {
    for (const entry of journal.entries) {
      expect(files).toContain(`${entry.tag}.sql`);
    }
  });
});
