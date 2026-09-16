import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import journal from '../src/db/migrations/meta/_journal.json' with { type: 'json' };

/**
 * Облік міграцій. Перевірка дешева і нудна, а ловить дорогий випадок: база
 * відстає від коду, і застосунок падає не там, де помилка, а на першій сторінці,
 * яка торкнулась нової колонки. Саме так сторінка Студії віддавала 500
 * "no such column: needs_browser", поки `deep=1` відповідав "ok".
 */

describe('міграції', () => {
  const files = readdirSync('src/db/migrations').filter((name) => name.endsWith('.sql'));

  it('журнал знає про кожен файл міграції', () => {
    expect(journal.entries).toHaveLength(files.length);
  });

  /*
   * Перевірка здоровʼя рахує саме записи журналу, тому журнал мусить бути тим,
   * що бачить воркер. Файл потрапляє в бандл імпортом, тобто помилка тут означає
   * мовчазно неправильне число на `/api/health?deep=1`.
   */
  it('кожен запис журналу вказує на наявний файл', () => {
    for (const entry of journal.entries) {
      expect(files).toContain(`${entry.tag}.sql`);
    }
  });
});
