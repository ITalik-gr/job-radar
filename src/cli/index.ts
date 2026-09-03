import { Command } from 'commander';

import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { getSqlite } from '../db/client.node.js';
import { runs } from '../db/schema.js';
import { desc } from 'drizzle-orm';
import { runMigrations } from '../db/migrate.js';
import { log } from '../lib/log.js';
import { listSources } from '../sources/registry.js';
import { crawlSource } from '../pipeline/crawl.js';
import { syncSource } from '../pipeline/sync.js';
import { queue } from '../pipeline/ingest.js';
import { remainingBudget, today } from '../pipeline/classify.js';
import { classifyPending } from '../pipeline/reclassify.js';
import { upsertCompany } from '../pipeline/companies.js';
import { importCsvFile } from './commands.js';
import { importFiles, syncDou } from '../pipeline/catalogs.js';
import { BUSINESS_TYPES, DOMAINS } from '../sources/catalogs/dou.js';
import { discover } from '../pipeline/discover.js';
import { fullStats } from '../pipeline/stats.js';
import { studioQueue } from '../pipeline/studios.js';
import { explain, scoreVacancy } from '../pipeline/score.js';
import { scoreCompany } from '../pipeline/company-score.js';
import { vacancies, companies as companiesTable } from '../db/schema.js';
import { recalcScores } from '../pipeline/recalc.js';
import { notify, isConfigured, probe, HELP_TEXT, statusText } from '../notify/telegram.js';
import { normalizePage } from '../pipeline/normalize.js';
import { saveSnapshot } from '../pipeline/snapshots.js';
import { fetchText } from '../lib/http.js';
import { companies } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { readFileSync, writeFileSync } from 'node:fs';
import '../sources/index.js';
import { watchRules } from '../pipeline/rules.js';

watchRules();

const program = new Command();

program.name('radar').description('Job Radar CLI').version('0.1.0');

program
  .command('db:migrate')
  .description('застосувати міграції')
  .action(() => {
    runMigrations();
    log.info({ db: config.dbPath }, 'міграції застосовано');
  });

program
  .command('db:stats')
  .description('скільки чого в базі')
  .action(() => {
    const sqlite = getSqlite();
    const tables = ['companies', 'company_state', 'contacts', 'snapshots', 'vacancies', 'outreach', 'runs'];
    const stats: Record<string, number> = {};
    for (const table of tables) {
      const row = sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number };
      stats[table] = row.n;
    }
    console.table(stats);
  });

program
  .command('sources:list')
  .description('перелік зареєстрованих джерел')
  .action(() => {
    const all = listSources();
    if (all.length === 0) {
      console.log('джерел ще немає, вони зʼявляться на Етапі 2');
      return;
    }
    console.table(all.map((s) => ({ id: s.id, kind: s.kind, browser: Boolean(s.needsBrowser) })));
  });

program
  .command('runs:last')
  .description('останні запуски адаптерів')
  .option('-n, --limit <number>', 'скільки рядків', '20')
  .action(async (opts: { limit: string }) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(runs)
      .orderBy(desc(runs.startedAt))
      .limit(Number(opts.limit));
    if (rows.length === 0) {
      console.log('запусків ще не було');
      return;
    }
    console.table(
      rows.map((r) => ({
        id: r.id,
        source: r.source,
        status: r.status,
        found: r.itemsFound,
        new: r.itemsNew,
        started: new Date(r.startedAt).toISOString(),
        errors: r.errors.length,
      })),
    );
  });

program
  .command('companies:add')
  .description('додати компанію вручну')
  .argument('<domain>', 'домен, наприклад vercel.com')
  .option('-n, --name <name>', 'назва, за замовчуванням домен')
  .option('--ats <kind>', 'greenhouse | lever | ashby | html | rss | none')
  .option('--slug <slug>', 'slug дошки в ATS')
  .option('--careers-url <url>', 'сторінка вакансій')
  .option('--country <country>', 'країна')
  .option('--city <city>', 'місто')
  .action(async (domain: string, opts: Record<string, string>) => {
    const { company, created } = await upsertCompany({
      name: opts.name ?? domain,
      domain,
      careersKind: opts.ats ?? null,
      careersSlug: opts.slug ?? null,
      careersUrl: opts.careersUrl ?? null,
      country: opts.country ?? null,
      city: opts.city ?? null,
      source: 'manual',
    });
    console.log(created ? 'створено' : 'оновлено', `#${company.id}`, company.domain, `[${company.careersKind}${company.careersSlug ? ':' + company.careersSlug : ''}]`);
  });

program
  .command('import:csv')
  .description('імпорт компаній з CSV: name,domain,country,note[,ats,slug,careers_url]')
  .argument('<files...>', 'шляхи до файлів')
  .action(async (files: string[]) => {
    for (const file of files) {
      const report = await importCsvFile(file);
      console.log(`${file}: створено ${report.created}, оновлено ${report.updated}, пропущено ${report.skipped.length}`);
      for (const skip of report.skipped) console.log(`  рядок ${skip.line}: ${skip.reason}`);
    }
  });

program
  .command('source:run')
  .description('прогнати адаптер і показати знайдене')
  .argument('<id>', 'id джерела, дивись sources:list')
  .option('--slug <slug>', 'разовий slug ATS без запису в базу')
  .option('-n, --limit <number>', 'скільки компаній обійти')
  .option('--full', 'показати повний текст першої вакансії')
  .action(async (id: string, opts: { slug?: string; limit?: string; full?: boolean }) => {
    const result = await crawlSource(id, {
      slug: opts.slug,
      limit: opts.limit ? Number(opts.limit) : undefined,
    });

    if (result.vacancies.length === 0) {
      console.log('нуль записів, дивись WARN у логах вище');
      return;
    }

    console.table(
      result.vacancies.slice(0, 30).map((v) => ({
        company: v.companyName ?? '',
        title: (v.title ?? '').slice(0, 48),
        location: (v.location ?? '').slice(0, 28),
        remote: v.remote === null ? '?' : v.remote ? 'так' : 'ні',
        chars: v.rawText.length,
      })),
    );
    console.log(`всього ${result.vacancies.length}, помилок ${result.errors.length}`);

    if (opts.full && result.vacancies[0]) {
      console.log('\n--- перша вакансія ---\n');
      console.log(result.vacancies[0].url);
      console.log(result.vacancies[0].rawText.slice(0, 1500));
    }
  });

program
  .command('page:normalize')
  .description('показати, що лишається від сторінки після нормалізації')
  .argument('<target>', 'шлях до файлу або URL')
  .action(async (target: string) => {
    const html = /^https?:\/\//.test(target)
      ? (await fetchText(target)).body
      : readFileSync(target, 'utf8');
    const page = normalizePage(html);

    console.log(`хеш ${page.contentHash}, блоків ${page.blocks.length}\n`);
    console.table(
      page.blocks.map((b) => ({
        hash: b.hash,
        title: (b.title ?? '').slice(0, 44),
        url: (b.url ?? '').slice(0, 52),
      })),
    );
    console.log('\n--- нормалізований текст ---\n');
    console.log(page.text);
  });

program
  .command('page:check')
  .description('зняти знімок career-сторінки компанії і показати діф із попереднім')
  .argument('<domain>', 'домен компанії з бази')
  .argument('[url]', 'сторінка, за замовчуванням careers_url компанії')
  .action(async (domain: string, url?: string) => {
    const db = getDb();
    const [company] = await db.select().from(companies).where(eq(companies.domain, domain));
    if (!company) {
      console.error(`компанії ${domain} немає в базі, додай через companies:add`);
      process.exitCode = 1;
      return;
    }

    const target = url ?? company.careersUrl;
    if (!target) {
      console.error(`у ${domain} немає careers_url, передай URL другим аргументом`);
      process.exitCode = 1;
      return;
    }

    const { body } = await fetchText(target);
    const result = await saveSnapshot(company.id, target, body);

    if (result.first) {
      console.log(`перший знімок, блоків ${result.diff.added.length}, хеш ${result.snapshot.contentHash}`);
    } else if (!result.diff.changed) {
      console.log(`без змін, блоків ${result.diff.unchanged}, хеш ${result.snapshot.contentHash}`);
    } else {
      console.log(`нових ${result.diff.added.length}, зниклих ${result.diff.removed.length}, без змін ${result.diff.unchanged}`);
    }

    for (const block of result.diff.added) {
      console.log(`  + ${block.title ?? ''} ${block.url ?? ''}`);
    }
    for (const hash of result.diff.removed) {
      console.log(`  - блок ${hash}`);
    }
  });

function reportCatalog(stats: { itemsFound: number; itemsNew: number; updated: number; skipped: { name: string; reason: string }[]; errors: string[] }) {
  console.table({
    знайдено: stats.itemsFound,
    нових: stats.itemsNew,
    оновлено: stats.updated,
    'без домену': stats.skipped.length,
    помилок: stats.errors.length,
  });
  for (const skip of stats.skipped.slice(0, 10)) console.log(`  ? ${skip.name}: ${skip.reason}`);
  for (const error of stats.errors.slice(0, 10)) console.log(`  ! ${error}`);
}

program
  .command('bookmarklet')
  .description('код закладки, яка збирає каталог прямо з відкритої сторінки')
  .action(() => {
    const source = readFileSync('tools/collector.js', 'utf8');
    const minified = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

    console.log('Створи закладку в браузері і встав це в поле адреси:\n');
    console.log(`javascript:${encodeURI(minified)}`);
    console.log(
      '\nЯк користуватись: відкрий сторінку каталогу (Clutch, GoodFirms, DesignRush, Sortlist),' +
        '\nдочекайся завантаження і натисни закладку. Компанії підуть у базу, зʼявиться підсумок.' +
        '\nJob Radar має бути запущений: pnpm start',
    );
  });

program
  .command('import:clutch')
  .description('імпорт збережених сторінок каталогу (Clutch, TechBehemoths) або CSV')
  .argument('<files...>', 'шляхи до html або csv')
  .option('--source <name>', 'мітка джерела', 'clutch')
  .action(async (files: string[], opts: { source: string }) => {
    reportCatalog(await importFiles(files, opts.source));
  });

program
  .command('catalog:dou')
  .description('зібрати компанії з каталогу DOU за фільтрами')
  .option('-n, --limit <number>', 'скільки компаній максимум', '40')
  .option('--business <types>', `типи бізнесу через кому, доступні: ${BUSINESS_TYPES.join(', ')}`)
  .option('--domains <list>', `домени через кому, наприклад: ${DOMAINS.slice(0, 2).join(', ')}`)
  .option('--skip-profiles', 'не ходити на сторінки компаній, домен лишиться порожнім')
  .action(async (opts: { limit: string; business?: string; domains?: string; skipProfiles?: boolean }) => {
    reportCatalog(
      await syncDou({
        limit: Number(opts.limit),
        business: opts.business?.split(',').map((value) => value.trim()),
        domains: opts.domains?.split(',').map((value) => value.trim()),
        skipProfiles: opts.skipProfiles,
      }),
    );
  });

program
  .command('source:sync')
  .description('забрати джерело, класифікувати і записати в базу')
  .argument('<id>', 'id джерела')
  .option('--slug <slug>', 'разовий slug ATS')
  .option('-n, --limit <number>', 'обмежити кількість компаній або вакансій')
  .option('--skip-llm', 'без викликів моделі, тільки стоп-слова і ваги')
  .option('--no-detail', 'не довантажувати сторінки коротких вакансій')
  .action(async (id: string, opts: { slug?: string; limit?: string; skipLlm?: boolean; detail?: boolean }) => {
    const result = await syncSource(id, {
      slug: opts.slug,
      limit: opts.limit ? Number(opts.limit) : undefined,
      skipLlm: opts.skipLlm,
      noDetail: opts.detail === false,
    });

    console.table({
      знайдено: result.itemsFound,
      нових: result.created,
      оновлено: result.updated,
      'відсіяно стоп-словами': result.stopped,
      класифіковано: result.classified,
      'на ручний перегляд': result.needsReview,
      довантажено: result.detailed,
      закрито: result.closed,
      помилок: result.errors.length,
    });
    for (const error of result.errors) console.log(`  ! ${error}`);
    console.log(`лишилось викликів моделі сьогодні: ${await remainingBudget()}`);
  });

program
  .command('studios')
  .description('черга студій і агенцій, яким варто написати')
  .option('-n, --limit <number>', 'скільки карток', '20')
  .option('--min <score>', 'мінімальний рахунок')
  .option('--country <code>', 'фільтр за країною')
  .option('-q, --search <text>', 'пошук за назвою, доменом або тегом')
  .option('--all', 'показати і тих, кому вже писали')
  .action(async (opts: { limit: string; min?: string; country?: string; search?: string; all?: boolean }) => {
    const cards = await studioQueue({
      limit: Number(opts.limit),
      minScore: opts.min ? Number(opts.min) : undefined,
      country: opts.country,
      search: opts.search,
      includeContacted: opts.all,
    });

    if (cards.length === 0) {
      console.log('черга студій порожня, спробуй знизити --min або зібрати більше каталогів');
      return;
    }

    console.table(
      cards.map((card) => ({
        score: card.score,
        name: card.name.slice(0, 26),
        domain: card.domain.slice(0, 26),
        size: card.sizeHint ?? '',
        country: card.country ?? '',
        stack: card.techHints.slice(0, 3).join(', '),
        vacancies: card.openVacancies,
        status: card.status,
      })),
    );
    for (const card of cards.slice(0, 5)) {
      console.log(`\n${card.name} (${card.score})`);
      for (const item of card.why.slice(0, 6)) console.log(`  ${item.weight > 0 ? '+' : ''}${item.weight}  ${item.reason}`);
    }
  });

program
  .command('score:explain')
  .description('чому вакансія або компанія має такий рахунок')
  .argument('<what>', 'vacancy | company')
  .argument('<id>', 'id запису')
  .action(async (what: string, id: string) => {
    const db = getDb();
    if (what === 'vacancy') {
      const [row] = await db.select().from(vacancies).where(eq(vacancies.id, Number(id)));
      if (!row) throw new Error('вакансії немає');
      const [owner] = await db.select().from(companiesTable).where(eq(companiesTable.id, row.companyId));
      console.log(`${row.title}\n${row.url}\nлокація: ${row.location ?? 'невідома'}\n`);
      console.log(
        explain(
          scoreVacancy({
            text: row.rawText ?? '',
            companyDomain: owner?.domain,
            companySizeHint: owner?.sizeHint,
            title: row.title,
            location: row.location,
            remote: row.remote,
            salaryMin: row.salaryMin,
            salaryMax: row.salaryMax,
            seniority: row.seniority,
            englishLevelRequired: row.englishLevelRequired,
            llmRelevance: row.llmRelevance,
          }),
        ),
      );
      console.log(`\nу базі записано: ${row.score}`);
      return;
    }

    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, Number(id)));
    if (!company) throw new Error('компанії немає');
    const breakdown = scoreCompany({ company });
    console.log(`${company.name} ${company.domain}\nрахунок: ${breakdown.score}`);
    for (const item of [...breakdown.positives, ...breakdown.negatives]) {
      console.log(`  ${item.weight > 0 ? '+' : ''}${item.weight}  ${item.reason}`);
    }
  });

program
  .command('score:recalc')
  .description('перерахувати рахунки після зміни config/scoring.json')
  .action(async () => {
    const stats = await recalcScores();
    console.table(stats);
  });

program
  .command('queue')
  .description('черга на сьогодні')
  .option('-n, --limit <number>', 'скільки карток')
  .action(async (opts: { limit?: string }) => {
    const rows = await queue(opts.limit ? Number(opts.limit) : undefined);
    if (rows.length === 0) {
      console.log('черга порожня');
      return;
    }

    console.table(
      rows.map((row) => ({
        score: row.score,
        company: row.company,
        title: (row.title ?? '').slice(0, 42),
        stack: row.stack.slice(0, 4).join(', '),
        location: (row.location ?? '').slice(0, 24),
        salary: row.salaryMin ? `${row.salaryMin}-${row.salaryMax ?? ''}` : '',
      })),
    );
    for (const row of rows) console.log(`${row.score}  ${row.url}  ${row.why ?? ''}`);
  });

program
  .command('classify:pending')
  .description('догнати класифікацію вакансій, які лежать у базі без неї')
  .option('-n, --limit <number>', 'скільки записів', '20')
  .action(async (opts: { limit: string }) => {
    const stats = await classifyPending(Number(opts.limit));
    console.table(stats);
    console.log(`лишилось викликів моделі сьогодні: ${await remainingBudget()}`);
  });

program
  .command('discover')
  .description('знайти career-сторінки і стек компаній без ATS')
  .option('-n, --limit <number>', 'скільки компаній обійти', '25')
  .option('--domain <domain>', 'конкретна компанія')
  .option('--all', 'без обмеження за цікавістю і стеком')
  .action(async (opts: { limit: string; domain?: string; all?: boolean }) => {
    const stats = await discover({ limit: Number(opts.limit), domain: opts.domain, all: opts.all });
    console.table({
      'кандидатів': stats.itemsFound,
      'обійдено': stats.checked,
      'знайдено ATS': stats.withAts,
      'знайдено html-сторінку': stats.withHtml,
      'без вакансій': stats.none,
      'нових careers_url': stats.itemsNew,
      'помилок': stats.errors.length,
    });
    for (const error of stats.errors.slice(0, 10)) console.log(`  ! ${error}`);
  });

program
  .command('stats')
  .description('статистика: топ технологій, вилки, час життя вакансій, воронка')
  .action(async () => {
    const stats = await fullStats();
    console.log('\nтоп технологій');
    console.table(stats.topTech.slice(0, 15));
    console.log('\nмедіанна вилка за грейдом');
    console.table(stats.salariesBySeniority);
    console.log('\nчас життя вакансій');
    console.table({
      'медіана днів': stats.lifetimes.medianDays ?? 'даних ще немає',
      'закритих': stats.lifetimes.closedCount,
      'підозр на ghost jobs': stats.lifetimes.ghosts.length,
    });
    console.log('\nворонка');
    console.table(stats.funnel);
  });

program
  .command('notify:check')
  .description('перевірити звʼязок з телеграмом і показати доступні chat_id')
  .action(async () => {
    const result = await probe();
    console.log(`бот: ${result.botUsername ? '@' + result.botUsername : 'невідомий'}`);
    console.log(`chat_id у .env: ${result.configuredChatId || 'порожній'}`);
    console.log(`доступність: ${result.reachable ? 'так' : 'ні'}`);
    console.log(result.hint);
    if (result.chats.length > 0) {
      console.log('\nчати, які бачить бот:');
      console.table(result.chats);
    }
  });

program
  .command('notify')
  .description('надіслати сповіщення в телеграм')
  .argument('<kind>', 'digest | highscore | followups | broken | help | status | test')
  .option('--dry', 'показати текст, але не надсилати')
  .action(async (kind: string, opts: { dry?: boolean }) => {
    if (!isConfigured() && !opts.dry) {
      console.error('немає TELEGRAM_BOT_TOKEN або TELEGRAM_CHAT_ID у .env');
      process.exitCode = 1;
      return;
    }

    const sender = opts.dry ? async (text: string) => console.log(text) : undefined;
    const sent = await (async () => {
      switch (kind) {
        case 'digest':
          return notify.digest({ sender });
        case 'highscore':
          return notify.highScore({ sender });
        case 'followups':
          return notify.followUps({ sender });
        case 'broken':
          return notify.broken({ sender });
        case 'test':
          return notify.raw('Job Radar на звʼязку', { sender });
        case 'help':
          return notify.raw(HELP_TEXT, { sender });
        case 'status':
          return statusText().then((text) => notify.raw(text, { sender }));
        default:
          throw new Error(`невідомий тип сповіщення: ${kind}`);
      }
    })();

    console.log(sent ? 'надіслано' : 'нічого надсилати, повідомлення порожнє');
  });

program
  .command('export:sql')
  .description('вивантажити дані локальної бази як INSERT-и для D1')
  .argument('<file>', 'куди писати, наприклад /tmp/data.sql')
  .option('--tables <list>', 'які таблиці, через кому')
  .action(async (file: string, opts: { tables?: string }) => {
    const sqlite = getSqlite();
    // Порядок важливий: спершу компанії, потім усе, що на них посилається.
    const order = [
      'companies',
      'company_state',
      'contacts',
      'vacancies',
      'snapshots',
      'outreach',
      'queue_items',
      'llm_cache',
      'llm_usage',
      'runs',
    ];
    const tables = opts.tables ? opts.tables.split(',').map((name) => name.trim()) : order;

    const quote = (value: unknown): string => {
      if (value === null || value === undefined) return 'null';
      if (typeof value === 'number') return String(value);
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Uint8Array) return `x'${Buffer.from(value).toString('hex')}'`;
      return `'${String(value).replace(/'/g, "''")}'`;
    };

    const lines: string[] = [];
    let total = 0;

    for (const table of tables) {
      const rows = sqlite.prepare(`select * from ${table}`).all() as Record<string, unknown>[];
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]!);

      for (const row of rows) {
        lines.push(
          `insert or ignore into ${table} (${columns.map((c) => `"${c}"`).join(', ')}) values (${columns
            .map((column) => quote(row[column]))
            .join(', ')});`,
        );
      }
      total += rows.length;
      console.log(`${table}: ${rows.length}`);
    }

    writeFileSync(file, lines.join('\n'), 'utf8');
    console.log(`\nзаписано ${total} рядків у ${file}`);
    console.log('далі: pnpm wrangler d1 execute job-radar --remote --file=' + file);
  });

program
  .command('doctor')
  .description('перевірити задеплоєний радар: база, міграції, токен')
  .argument('<url>', 'адреса воркера, наприклад https://job-radar.xxx.workers.dev')
  .option('--token <token>', 'RADAR_TOKEN, якщо заданий')
  .action(async (url: string, opts: { token?: string }) => {
    const base = url.replace(/\/$/, '');
    const headers = opts.token ? { 'x-radar-token': opts.token } : undefined;

    const response = await fetch(`${base}/api/health?deep=1`, { headers });
    const body = (await response.json()) as {
      db?: string;
      tables?: string[];
      missing?: string[];
      hint?: string | null;
      error?: string;
    };

    console.log(`статус: ${response.status}`);
    console.log(
      body.db
        ? `база: ${body.db}`
        : 'база: перевірка недоступна, у проді старий білд без ?deep=1, потрібен передеплой',
    );
    if (body.tables) console.log(`таблиць: ${body.tables.length}`);
    if (body.missing?.length) console.log(`бракує таблиць: ${body.missing.join(', ')}`);
    if (body.hint) console.log(`що робити: ${body.hint}`);
    if (body.error) console.log(`помилка: ${body.error}`);

    const companies = await fetch(`${base}/api/companies`, { headers });
    const data = (await companies.json()) as unknown;
    console.log(
      `/api/companies: ${companies.status}, ${Array.isArray(data) ? `${data.length} записів` : JSON.stringify(data).slice(0, 160)}`,
    );
  });

program
  .command('llm:budget')
  .description('скільки викликів моделі лишилось сьогодні')
  .action(async () => {
    console.log(`${today()}: лишилось ${await remainingBudget()}`);
  });

await program.parseAsync(process.argv);
