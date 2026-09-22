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
import { refreshDetails, syncSource } from '../pipeline/sync.js';
import { queue } from '../pipeline/ingest.js';
import { callModelWith, remainingBudget, today } from '../pipeline/classify.js';
import { classifyPending } from '../pipeline/reclassify.js';
import { upsertCompany } from '../pipeline/companies.js';
import { importCsvFile } from './commands.js';
import { importFiles, syncCatalog, syncDou } from '../pipeline/catalogs.js';
import { BUSINESS_TYPES, DOMAINS } from '../sources/catalogs/dou.js';
import { discover } from '../pipeline/discover.js';
import { enrich } from '../pipeline/enrich.js';
import { backfillKinds } from '../pipeline/company-kind.js';
import { backfillCatalogFields } from '../pipeline/backfill-catalog.js';
import { topUpQueue, getQueue, todayKey } from '../pipeline/queue.js';
import { toCsv } from '../lib/csv.js';
import { embedCompanies, similarCompanies } from '../pipeline/similar.js';
import { studioPage } from '../pipeline/studios.js';
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
import {
  listDrafts,
  prepareDrafts,
  seedOutreachTemplates,
} from '../pipeline/outreach.js';
import { gmailStatus } from '../lib/gmail.js';
import { deliver, mailer } from '../lib/mailer.js';
import { sendDraft } from '../pipeline/send.js';
import { sendCounters } from '../pipeline/send-guards.js';
import { checkReplies } from '../pipeline/replies.js';
import { prepareFollowups } from '../pipeline/followups.js';
import { outreachStats } from '../pipeline/outreach-stats.js';
import '../lib/gmail-store.node.js';
import { authorize } from './gmail-auth.js';

watchRules();

const program = new Command();

program.name('radar').description('Job Radar CLI').version('0.1.0');

program
  .command('db:migrate')
  .description('apply migrations')
  .action(() => {
    runMigrations();
    log.info({ db: config.dbPath }, 'migrations applied');
  });

program
  .command('db:stats')
  .description('how much of what is in the database')
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
  .description('list registered sources')
  .action(() => {
    const all = listSources();
    if (all.length === 0) {
      console.log('no sources registered yet');
      return;
    }
    console.table(all.map((s) => ({ id: s.id, kind: s.kind, browser: Boolean(s.needsBrowser) })));
  });

program
  .command('runs:last')
  .description('recent adapter runs')
  .option('-n, --limit <number>', 'how many rows', '20')
  .action(async (opts: { limit: string }) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(runs)
      .orderBy(desc(runs.startedAt))
      .limit(Number(opts.limit));
    if (rows.length === 0) {
      console.log('no runs yet');
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
  .description('add a company by hand')
  .argument('<domain>', 'domain, for example vercel.com')
  .option('-n, --name <name>', 'name, defaults to the domain')
  .option('--ats <kind>', 'greenhouse | lever | ashby | html | rss | none')
  .option('--slug <slug>', 'ATS board slug')
  .option('--careers-url <url>', 'careers page')
  .option('--country <country>', 'country')
  .option('--city <city>', 'city')
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
    console.log(created ? 'created' : 'updated', `#${company.id}`, company.domain, `[${company.careersKind}${company.careersSlug ? ':' + company.careersSlug : ''}]`);
  });

program
  .command('import:csv')
  .description('import companies from CSV: name,domain,country,note[,ats,slug,careers_url]')
  .argument('<files...>', 'file paths')
  .action(async (files: string[]) => {
    for (const file of files) {
      const report = await importCsvFile(file);
      console.log(`${file}: created ${report.created}, updated ${report.updated}, skipped ${report.skipped.length}`);
      for (const skip of report.skipped) console.log(`  line ${skip.line}: ${skip.reason}`);
    }
  });

program
  .command('source:run')
  .description('run an adapter and show what it found')
  .argument('<id>', 'source id, see sources:list')
  .option('--slug <slug>', 'one-off ATS slug, not stored')
  .option('-n, --limit <number>', 'how many companies to visit')
  .option('--full', 'show the full text of the first vacancy')
  .action(async (id: string, opts: { slug?: string; limit?: string; full?: boolean }) => {
    const result = await crawlSource(id, {
      slug: opts.slug,
      limit: opts.limit ? Number(opts.limit) : undefined,
    });

    if (result.vacancies.length === 0) {
      console.log('zero records, see the WARN in the log above');
      return;
    }

    console.table(
      result.vacancies.slice(0, 30).map((v) => ({
        company: v.companyName ?? '',
        title: (v.title ?? '').slice(0, 48),
        location: (v.location ?? '').slice(0, 28),
        remote: v.remote === null ? '?' : v.remote ? 'yes' : 'no',
        chars: v.rawText.length,
      })),
    );
    console.log(`total ${result.vacancies.length}, errors ${result.errors.length}`);

    if (opts.full && result.vacancies[0]) {
      console.log('\n--- first vacancy ---\n');
      console.log(result.vacancies[0].url);
      console.log(result.vacancies[0].rawText.slice(0, 1500));
    }
  });

program
  .command('page:normalize')
  .description('show what is left of a page after normalization')
  .argument('<target>', 'file path or URL')
  .action(async (target: string) => {
    const html = /^https?:\/\//.test(target)
      ? (await fetchText(target)).body
      : readFileSync(target, 'utf8');
    const page = normalizePage(html);

    console.log(`hash ${page.contentHash}, blocks ${page.blocks.length}\n`);
    console.table(
      page.blocks.map((b) => ({
        hash: b.hash,
        title: (b.title ?? '').slice(0, 44),
        url: (b.url ?? '').slice(0, 52),
      })),
    );
    console.log('\n--- normalized text ---\n');
    console.log(page.text);
  });

program
  .command('page:check')
  .description('snapshot a company careers page and show the diff against the previous one')
  .argument('<domain>', 'company domain from the database')
  .argument('[url]', 'page, defaults to the company careers_url')
  .action(async (domain: string, url?: string) => {
    const db = getDb();
    const [company] = await db.select().from(companies).where(eq(companies.domain, domain));
    if (!company) {
      console.error(`company ${domain} is not in the database, add it with companies:add`);
      process.exitCode = 1;
      return;
    }

    const target = url ?? company.careersUrl;
    if (!target) {
      console.error(`${domain} has no careers_url, pass the URL as the second argument`);
      process.exitCode = 1;
      return;
    }

    const { body } = await fetchText(target);
    const result = await saveSnapshot(company.id, target, body);

    if (result.first) {
      console.log(`first snapshot, blocks ${result.diff.added.length}, hash ${result.snapshot.contentHash}`);
    } else if (!result.diff.changed) {
      console.log(`unchanged, blocks ${result.diff.unchanged}, hash ${result.snapshot.contentHash}`);
    } else {
      console.log(`new ${result.diff.added.length}, gone ${result.diff.removed.length}, unchanged ${result.diff.unchanged}`);
    }

    for (const block of result.diff.added) {
      console.log(`  + ${block.title ?? ''} ${block.url ?? ''}`);
    }
    for (const hash of result.diff.removed) {
      console.log(`  - block ${hash}`);
    }
  });

function reportCatalog(stats: { itemsFound: number; itemsNew: number; updated: number; skipped: { name: string; reason: string }[]; errors: string[] }) {
  console.table({
    found: stats.itemsFound,
    new: stats.itemsNew,
    updated: stats.updated,
    'no domain': stats.skipped.length,
    errors: stats.errors.length,
  });
  for (const skip of stats.skipped.slice(0, 10)) console.log(`  ? ${skip.name}: ${skip.reason}`);
  for (const error of stats.errors.slice(0, 10)) console.log(`  ! ${error}`);
}

program
  .command('bookmarklet')
  .description('bookmarklet code that collects a catalog straight from the open page')
  .action(() => {
    const source = readFileSync('tools/collector.js', 'utf8');
    const minified = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

    console.log('Create a browser bookmark and paste this into its address field:\n');
    console.log(`javascript:${encodeURI(minified)}`);
    console.log(
      '\nHow to use: open a catalog page (Clutch, GoodFirms, DesignRush, Sortlist),' +
        '\nwait for it to load and click the bookmark. Companies go into the database and a summary appears.' +
        '\nJob Radar has to be running: pnpm start',
    );
  });

program
  .command('import:clutch')
  .description('import saved catalog pages (Clutch, TechBehemoths) or CSV')
  .argument('<files...>', 'paths to html or csv')
  .option('--source <name>', 'source label', 'clutch')
  .action(async (files: string[], opts: { source: string }) => {
    reportCatalog(await importFiles(files, opts.source));
  });

program
  .command('catalog:run')
  .description('run a company catalog by id, e.g. awwwards')
  .argument('<id>', 'catalog id')
  .action(async (id: string) => {
    const stats = await syncCatalog(id);
    console.table({
      found: stats.itemsFound,
      new: stats.itemsNew,
      updated: stats.updated,
      skipped: stats.skipped,
      errors: stats.errors.length,
    });
    for (const error of stats.errors.slice(0, 10)) console.log(`  ! ${error}`);
  });

program
  .command('catalog:dou')
  .description('collect companies from the DOU catalog by filters')
  .option('-n, --limit <number>', 'maximum number of companies', '40')
  .option('--business <types>', `comma separated business types, available: ${BUSINESS_TYPES.join(', ')}`)
  .option('--domains <list>', `comma separated domains, for example: ${DOMAINS.slice(0, 2).join(', ')}`)
  .option('--skip-profiles', 'do not visit company pages, the domain stays empty')
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
  .description('fetch a source, classify and store it')
  .argument('<id>', 'source id')
  .option('--slug <slug>', 'one-off ATS slug')
  .option('-n, --limit <number>', 'limit the number of companies or vacancies')
  .option('--skip-llm', 'no model calls, only stop words and weights')
  .option('--no-detail', 'do not fetch pages of short vacancies')
  .action(async (id: string, opts: { slug?: string; limit?: string; skipLlm?: boolean; detail?: boolean }) => {
    const result = await syncSource(id, {
      slug: opts.slug,
      limit: opts.limit ? Number(opts.limit) : undefined,
      skipLlm: opts.skipLlm,
      noDetail: opts.detail === false,
    });

    console.table({
      found: result.itemsFound,
      new: result.created,
      updated: result.updated,
      'filtered by stop words': result.stopped,
      classified: result.classified,
      'for manual review': result.needsReview,
      'details fetched': result.detailed,
      closed: result.closed,
      errors: result.errors.length,
    });
    for (const error of result.errors) console.log(`  ! ${error}`);
    console.log(`model calls left today: ${await remainingBudget()}`);
  });

program
  .command('studios')
  .description('queue of studios and agencies worth writing to')
  .option('-n, --limit <number>', 'how many cards', '20')
  .option('--min <score>', 'minimum score')
  .option('--country <code>', 'filter by country')
  .option('-q, --search <text>', 'search by name, domain or tag')
  .option('--all', 'include those already contacted')
  .action(async (opts: { limit: string; min?: string; country?: string; search?: string; all?: boolean }) => {
    const cards = await studioQueue({
      limit: Number(opts.limit),
      minScore: opts.min ? Number(opts.min) : undefined,
      country: opts.country,
      search: opts.search,
      includeContacted: opts.all,
    });

    if (cards.length === 0) {
      console.log('the studio queue is empty, try lowering --min or collecting more catalogs');
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
  .description('why a vacancy or a company has its score')
  .argument('<what>', 'vacancy | company')
  .argument('<id>', 'record id')
  .action(async (what: string, id: string) => {
    const db = getDb();
    if (what === 'vacancy') {
      const [row] = await db.select().from(vacancies).where(eq(vacancies.id, Number(id)));
      if (!row) throw new Error('no such vacancy');
      const [owner] = await db.select().from(companiesTable).where(eq(companiesTable.id, row.companyId));
      console.log(`${row.title}\n${row.url}\nlocation: ${row.location ?? 'unknown'}\n`);
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
      console.log(`\nstored in the database: ${row.score}`);
      return;
    }

    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, Number(id)));
    if (!company) throw new Error('no such company');
    const breakdown = scoreCompany({ company });
    console.log(`${company.name} ${company.domain}\nscore: ${breakdown.score}`);
    for (const item of [...breakdown.positives, ...breakdown.negatives]) {
      console.log(`  ${item.weight > 0 ? '+' : ''}${item.weight}  ${item.reason}`);
    }
  });

program
  .command('score:recalc')
  .description('rescore after changing the rules')
  .action(async () => {
    const stats = await recalcScores();
    console.table(stats);
  });

program
  .command('queue')
  .description("today's queue")
  .option('-n, --limit <number>', 'how many cards')
  .action(async (opts: { limit?: string }) => {
    const rows = await queue(opts.limit ? Number(opts.limit) : undefined);
    if (rows.length === 0) {
      console.log('the queue is empty');
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
  .description('catch up on classification for vacancies stored without it')
  .option('-n, --limit <number>', 'how many records', '20')
  .action(async (opts: { limit: string }) => {
    const stats = await classifyPending(Number(opts.limit));
    console.table(stats);
    console.log(`model calls left today: ${await remainingBudget()}`);
  });

program
  .command('discover')
  .description('find careers pages and the stack of companies without an ATS')
  .option('-n, --limit <number>', 'how many companies to visit', '25')
  .option('--domain <domain>', 'a specific company')
  .option('--all', 'no limit by interest and stack')
  .action(async (opts: { limit: string; domain?: string; all?: boolean }) => {
    const stats = await discover({ limit: Number(opts.limit), domain: opts.domain, all: opts.all });
    console.table({
      candidates: stats.itemsFound,
      checked: stats.checked,
      'ATS found': stats.withAts,
      'html page found': stats.withHtml,
      'no vacancies': stats.none,
      'new careers_url': stats.itemsNew,
      errors: stats.errors.length,
    });
    for (const error of stats.errors.slice(0, 10)) console.log(`  ! ${error}`);
  });

program
  .command('enrich')
  .description('collect contacts and signs of life from company sites')
  .option('-n, --limit <number>', 'how many companies to visit', '25')
  .option('--domain <domain>', 'a specific company')
  .option('--all', 'including those that already have contacts')
  .action(async (opts: { limit: string; domain?: string; all?: boolean }) => {
    const stats = await enrich({ limit: Number(opts.limit), domain: opts.domain, all: opts.all });
    console.table({
      'companies checked': stats.checked,
      'pages fetched': stats.pagesFetched,
      'with named contacts': stats.withPeople,
      'with any email': stats.withEmail,
      'contacts added': stats.contactsAdded,
      errors: stats.errors.length,
    });
    for (const error of stats.errors.slice(0, 10)) console.log(`  ! ${error}`);
  });

program
  .command('export:csv')
  .description('export the queue or studios to CSV for manual work in a spreadsheet')
  .argument('<what>', 'queue or studios')
  .option('-o, --out <file>', 'where to write, stdout by default')
  .option('--named', 'only studios with a named contact')
  .action(async (what: string, opts: { out?: string; named?: boolean }) => {
    let csv = '';

    if (what === 'queue') {
      const cards = await getQueue(todayKey());
      csv = toCsv(
        cards.map((card) => ({
          company: card.company,
          domain: card.domain,
          vacancy: card.title,
          score: card.score,
          seniority: card.seniority,
          location: card.location,
          salary: [card.salaryMin, card.salaryMax].filter(Boolean).join(' - '),
          stack: card.stack.join(' '),
          url: card.url,
          decision: card.decision ?? '',
        })),
      );
    } else if (what === 'studios') {
      const page = await studioPage({ limit: 1000, withNamedContact: opts.named });
      csv = toCsv(
        page.cards.map((card) => ({
          company: card.name,
          domain: card.domain,
          kind: card.kind,
          score: card.score,
          location: [card.city, card.country].filter(Boolean).join(', '),
          contact: card.contacts.find((contact) => contact.name)?.name ?? '',
          role: card.contacts.find((contact) => contact.name)?.role ?? '',
          email:
            card.contacts.find((contact) => contact.name && contact.email)?.email ??
            card.contacts.find((contact) => contact.email)?.email ??
            '',
          vacancies: card.openVacancies,
        })),
      );
    } else {
      throw new Error(`unknown export type: ${what}. Available: queue, studios`);
    }

    if (!csv) {
      console.log('nothing to export');
      return;
    }

    if (opts.out) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(opts.out, csv, 'utf8');
      console.log(`written to ${opts.out}`);
    } else {
      process.stdout.write(csv);
    }
  });

program
  .command('queue:top-up')
  .description("top up today's slice to the daily limit")
  .action(async () => {
    const result = await topUpQueue();
    console.log(`added ${result.added}, the slice now has ${result.total}`);
  });

program
  .command('embed')
  .description('compute company vectors through Workers AI, for finding similar ones')
  .option('-n, --limit <number>', 'how many companies to process', '200')
  .action(async (opts: { limit: string }) => {
    const stats = await embedCompanies(Number(opts.limit));
    console.table({
      'without vectors': stats.itemsFound,
      computed: stats.itemsNew,
      errors: stats.errors.length,
    });
    for (const error of stats.errors.slice(0, 5)) console.log(`  ! ${error}`);
  });

program
  .command('similar')
  .description('similar companies by description')
  .argument('<id>', 'company id')
  .action(async (id: string) => {
    const rows = await similarCompanies(Number(id));
    if (rows.length === 0) {
      console.log('nothing similar found, or the company has no vector yet');
      return;
    }
    console.table(rows);
  });

program
  .command('kinds')
  .description('assign company kinds: studio, design, startup, product, outstaff')
  .option('--force', 'recompute even where a kind is already set')
  .action(async (opts: { force?: boolean }) => {
    console.table(await backfillKinds(Boolean(opts.force)));
  });

program
  .command('backfill:catalog')
  .description('split hourly rate, minimum project and founding year from tags into columns')
  .action(async () => {
    console.table(await backfillCatalogFields());
  });

program
  .command('stats')
  .description('stats: top technologies, salaries, vacancy lifetime, funnel')
  .action(async () => {
    const stats = await fullStats();
    console.log('\ntop technologies');
    console.table(stats.topTech.slice(0, 15));
    console.log('\nmedian salary by seniority');
    console.table(stats.salariesBySeniority);
    console.log('\nvacancy lifetime');
    console.table({
      'median days': stats.lifetimes.medianDays ?? 'no data yet',
      closed: stats.lifetimes.closedCount,
      'suspected ghost jobs': stats.lifetimes.ghosts.length,
    });
    console.log('\nfunnel');
    console.table(stats.funnel);
  });

program
  .command('notify:check')
  .description('check the Telegram connection and show available chat_id values')
  .action(async () => {
    const result = await probe();
    console.log(`bot: ${result.botUsername ? '@' + result.botUsername : 'unknown'}`);
    console.log(`chat_id in .env: ${result.configuredChatId || 'empty'}`);
    console.log(`reachable: ${result.reachable ? 'yes' : 'no'}`);
    console.log(result.hint);
    if (result.chats.length > 0) {
      console.log('\nchats the bot can see:');
      console.table(result.chats);
    }
  });

program
  .command('notify')
  .description('send a Telegram notification')
  .argument('<kind>', 'summary | digest | highscore | followups | broken | help | status | test')
  .option('--dry', 'show the text without sending')
  .action(async (kind: string, opts: { dry?: boolean }) => {
    if (!isConfigured() && !opts.dry) {
      console.error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing from .env');
      process.exitCode = 1;
      return;
    }

    const sender = opts.dry ? async (text: string) => console.log(text) : undefined;
    const sent = await (async () => {
      switch (kind) {
        case 'summary':
          return notify.summary({ sender });
        case 'digest':
          return notify.digest({ sender });
        case 'highscore':
          return notify.highScore({ sender });
        case 'followups':
          return notify.followUps({ sender });
        case 'broken':
          return notify.broken({ sender });
        case 'test':
          return notify.raw('Job Radar is online', { sender });
        case 'help':
          return notify.raw(HELP_TEXT, { sender });
        case 'status':
          return statusText().then((text) => notify.raw(text, { sender }));
        default:
          throw new Error(`unknown notification type: ${kind}`);
      }
    })();

    console.log(sent ? 'sent' : 'nothing to send, the message is empty');
  });

program
  .command('export:sql')
  .description('export the local database as INSERT statements for D1')
  .argument('<file>', 'where to write, for example /tmp/data.sql')
  .option('--tables <list>', 'which tables, comma separated')
  .action(async (file: string, opts: { tables?: string }) => {
    const sqlite = getSqlite();
    // Order matters: companies first, then everything that references them.
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
    console.log(`\nwrote ${total} rows to ${file}`);
    console.log('next: pnpm wrangler d1 execute job-radar --remote --file=' + file);
  });

program
  .command('doctor')
  .description('check a deployed radar: database, migrations, token')
  .argument('<url>', 'worker address, for example https://job-radar.xxx.workers.dev')
  .option('--token <token>', 'RADAR_TOKEN, if set')
  .action(async (url: string, opts: { token?: string }) => {
    const base = url.replace(/\/$/, '');
    const headers = opts.token ? { 'x-radar-token': opts.token } : undefined;

    const response = await fetch(`${base}/api/health?deep=1`, { headers });
    const body = (await response.json()) as {
      db?: string;
      tables?: string[];
      missing?: string[];
      columns?: string | null;
      hint?: string | null;
      error?: string;
    };

    console.log(`status: ${response.status}`);
    console.log(
      body.db
        ? `database: ${body.db}`
        : 'database: check unavailable, production runs an old build without ?deep=1, redeploy it',
    );
    if (body.tables) console.log(`tables: ${body.tables.length}`);
    if (body.missing?.length) console.log(`missing tables: ${body.missing.join(', ')}`);
    // A migration with new columns leaves the table list unchanged, hence the separate probe.
    if (body.columns) console.log(`missing columns: ${body.columns}`);
    if (body.hint) console.log(`what to do: ${body.hint}`);
    if (body.error) console.log(`error: ${body.error}`);

    const companies = await fetch(`${base}/api/companies`, { headers });
    const data = (await companies.json()) as unknown;
    console.log(
      `/api/companies: ${companies.status}, ${Array.isArray(data) ? `${data.length} records` : JSON.stringify(data).slice(0, 160)}`,
    );
  });

program
  .command('fix:detail')
  .description('re-read vacancies that stored the site menu instead of a description')
  .option('--limit <n>', 'how many pages to open per pass', '50')
  .option('--source <id>', 'source whose vacancies to re-read', 'getro')
  .action(async (options: { limit: string; source: string }) => {
    const report = await refreshDetails({ limit: Number(options.limit), source: options.source });
    console.log(
      `checked ${report.checked}, fixed ${report.fixed}, unchanged ${report.unchanged}, still no description ${report.stillEmpty}`,
    );
    if (report.fixed > 0) console.log('next: pnpm cli classify:pending to reclassify');
  });

program
  .command('llm:ping')
  .description('live model call: checks the key, the gateway and the provider')
  .action(async () => {
    console.log(`provider: ${config.llm.provider}, model: ${config.llm.activeModel}`);
    console.log(`gateway: ${config.llm.baseUrl || 'direct call, no AI Gateway'}`);
    console.log(
      `gateway authentication: ${config.cloudflare.gatewayToken ? 'token set' : 'no token'}`,
    );

    try {
      const raw = await callModelWith('Reply with one word.', 'say ok');
      console.log(`reply: ${raw.text.trim().slice(0, 40)}`);
      console.log(`tokens: ${raw.inputTokens} in, ${raw.outputTokens} out`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`error: ${message}`);
      if (message.includes('401')) {
        console.log(
          'what to do: either turn off authentication in the gateway Settings, or create a token with the AI Gateway Run permission and put it into AI_GATEWAY_TOKEN',
        );
      }
      process.exitCode = 1;
    }
  });

program
  .command('llm:budget')
  .description('how many model calls are left today')
  .action(async () => {
    console.log(`${today()}: ${await remainingBudget()} left`);
  });

program
  .command('outreach:seed')
  .description('add the missing starter sending templates')
  .action(async () => {
    const added = await seedOutreachTemplates();
    console.log(added === 0 ? 'all sending templates are already in place' : `templates added: ${added}`);
  });

program
  .command('outreach:prepare')
  .description('prepare letter drafts')
  .option('--limit <n>', 'how many companies to take', '20')
  .option('--dry-run', 'show them and write nothing to the database')
  .option('--ai', 'the model writes the first paragraph, with validation and fallback')
  .action(async (options: { limit: string; dryRun?: boolean; ai?: boolean }) => {
    const report = await prepareDrafts({
      limit: Number(options.limit),
      dryRun: Boolean(options.dryRun),
      ai: Boolean(options.ai),
    });

    for (const draft of report.drafts) {
      console.log('─'.repeat(70));
      console.log(
        `${draft.companyId} ${draft.contactEmail ?? 'no address'} | ${draft.templateSlug} | ${draft.language}`,
      );
      console.log(`subject: ${draft.subject || '(empty)'}`);
      console.log(draft.body.trim() || '(empty body)');
      if (draft.aiUsed) console.log('intro: model');
      else if (draft.aiFallbackReason) console.log(`intro: fell back to the template, ${draft.aiFallbackReason}`);
      if (draft.error) console.log(`! ${draft.error}`);
    }

    console.log('─'.repeat(70));
    for (const skip of report.skipped) console.log(`skipped ${skip.company}: ${skip.reason}`);
    console.log(
      `candidates ${report.candidates}, drafts ${options.dryRun ? report.drafts.length : report.created}, need attention ${report.needsAttention}`,
    );
  });

program
  .command('outreach:send')
  .description('send one draft by id')
  .argument('<id>', 'draft id from outreach:drafts')
  .action(async (id: string) => {
    const outcome = await sendDraft(Number(id));
    if (outcome.sent) {
      console.log(`sent, threadId ${outcome.threadId}`);
      return;
    }
    console.log('not sent:');
    for (const blocker of outcome.blockers) console.log(`  ${blocker.code}: ${blocker.message}`);
  });

program
  .command('outreach:limits')
  .description('how many letters are allowed today')
  .action(async () => {
    const counters = await sendCounters();
    console.log(`day ${counters.day}: ${counters.sentToday} of ${counters.limit}`);
    console.log(`sending window: ${counters.windowOpen ? 'open' : 'closed'}`);
    if (counters.nextAllowedAt) {
      console.log(`next letter no earlier than ${new Date(counters.nextAllowedAt).toLocaleTimeString()}`);
    }
    console.log(`bounces: ${Math.round(counters.bounceRate * 100)} percent`);
  });

program
  .command('outreach:replies')
  .description('check replies and bounces on sent letters')
  .action(async () => {
    const report = await checkReplies({ ownEmail: config.gmail.fromEmail });
    console.log(
      `checked ${report.checked}, replies ${report.replies}, bounces ${report.bounces}`,
    );
    for (const error of report.errors) console.log(`  error ${error}`);
  });

program
  .command('outreach:followups')
  .description('prepare follow-up drafts for those due a second letter')
  .action(async () => {
    const report = await prepareFollowups();
    console.log(`due ${report.due}, drafts ${report.created}`);
    for (const skip of report.skipped) console.log(`  skipped ${skip.company}: ${skip.reason}`);
  });

program
  .command('outreach:stats')
  .description('template conversion, validation fallbacks, bounces')
  .action(async () => {
    const stats = await outreachStats();
    console.table(stats.byTemplate);
    console.log(`AI: ${stats.ai.sent} sent, ${stats.ai.positive} positive`);
    console.log(`template: ${stats.static.sent} sent, ${stats.static.positive} positive`);
    console.log(`validation fallbacks: ${Math.round(stats.fallbackShare * 100)} percent`);
    for (const item of stats.fallbacks) console.log(`  ${item.reason}: ${item.count}`);
    console.log(`bounces: ${Math.round(stats.bounceRate * 100)} percent`);
    console.log(
      `median time to reply: ${stats.medianReplyHours === null ? 'none yet' : `${stats.medianReplyHours.toFixed(1)} h`}`,
    );
  });

program
  .command('outreach:drafts')
  .description('what is in the drafts right now')
  .action(async () => {
    const rows = await listDrafts();
    if (rows.length === 0) {
      console.log('no drafts, prepare them with: pnpm cli outreach:prepare');
      return;
    }
    console.table(
      rows.map((row) => ({
        id: row.id,
        company: row.company,
        to: row.contactEmail ?? '',
        template: row.templateUsed ?? '',
        language: row.language ?? '',
        problem: row.error ?? '',
      })),
    );
  });

program
  .command('auth:gmail')
  .description('connect Gmail through OAuth')
  .action(async () => {
    const token = await authorize();
    console.log(`connected: ${token.email ?? 'unknown account'}`);
    console.log(`token saved: ${config.gmail.tokenPath}`);
  });

program
  .command('gmail:status')
  .description('mail connection status')
  .action(() => {
    const status = gmailStatus();
    console.log(`configured: ${status.configured ? 'yes' : 'no'}`);
    console.log(`connected: ${status.connected ? (status.email ?? 'yes') : 'no'}`);
    if (status.scopes.length > 0) console.log(`scopes: ${status.scopes.join(' ')}`);
    if (status.hint) console.log(`what to do: ${status.hint}`);
  });

program
  .command('gmail:test')
  .description('send a test letter to yourself')
  .argument('[email]', 'recipient, defaults to your own address')
  .action(async (email?: string) => {
    const to = email ?? config.gmail.fromEmail;
    if (!to) throw new Error('no address: set GMAIL_FROM_EMAIL in .env');

    // Non-ASCII in the subject on purpose, a Cyrillic word included: that is where encoding breaks.
    const result = await deliver({
      to,
      subject: 'Job Radar: encoding check, тест, café',
      body: [
        'This is a technical letter from Job Radar.',
        '',
        'If the subject and this line read without garbled characters, the encoding is right.',
        '',
        '',
      ].join('\n'),
    });

    console.log(`sent to ${to} through ${mailer().id}`);
    console.log(`messageId: ${result.messageId}`);
    console.log(`threadId: ${result.threadId}`);
    console.log(`Message-Id: ${result.rfcMessageId ?? 'not returned'}`);
  });

await program.parseAsync(process.argv);
