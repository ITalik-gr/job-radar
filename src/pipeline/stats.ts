import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { funnel } from './actions.js';

/**
 * The picture of the lead base: what is in it, where it came from, how much of it can actually
 * be written to. Deliberately plain counts, CLAUDE.md section 12: no analytics beyond what the
 * pages need.
 */

export interface Bucket {
  key: string;
  count: number;
}

async function buckets(column: string, limit = 30): Promise<Bucket[]> {
  const rows = await getDb().all<{ key: string | null; count: number }>(
    sql.raw(
      `select coalesce(${column}, 'unknown') as key, count(*) as count
       from companies group by 1 order by 2 desc limit ${limit}`,
    ),
  );
  return rows.map((row) => ({ key: row.key ?? 'unknown', count: row.count }));
}

/** Companies per source. `sources` is a JSON array, so it is unpacked with json_each. */
export async function bySource(): Promise<Bucket[]> {
  return getDb().all<Bucket>(
    sql`select value as key, count(*) as count
      from companies, json_each(companies.sources)
      group by 1 order by 2 desc`,
  );
}

export interface Reach {
  total: number;
  withEmail: number;
  withNamedContact: number;
  withPhone: number;
  hiring: number;
}

/** How many companies can be written to at all. A lead with no way to reach it is just a name. */
export async function reach(): Promise<Reach> {
  const [row] = await getDb().all<Reach>(
    sql`select
      count(*) as total,
      sum(case when exists (select 1 from contacts c where c.company_id = companies.id and c.email is not null and c.email_valid = 1) then 1 else 0 end) as withEmail,
      sum(case when exists (select 1 from contacts c where c.company_id = companies.id and c.name is not null and c.email is not null) then 1 else 0 end) as withNamedContact,
      sum(case when phone is not null then 1 else 0 end) as withPhone,
      sum(case when hiring_devs = 1 then 1 else 0 end) as hiring
    from companies`,
  );
  return {
    total: row?.total ?? 0,
    withEmail: row?.withEmail ?? 0,
    withNamedContact: row?.withNamedContact ?? 0,
    withPhone: row?.withPhone ?? 0,
    hiring: row?.hiring ?? 0,
  };
}

export interface DayCount {
  day: string;
  count: number;
}

/** New companies by day. */
export async function perDay(days = 30): Promise<DayCount[]> {
  const since = Date.now() - days * 86_400_000;
  return getDb().all<DayCount>(
    sql`select date(first_seen / 1000, 'unixepoch') as day, count(*) as count
      from companies where first_seen >= ${since}
      group by 1 order by 1 desc`,
  );
}

export async function fullStats() {
  return {
    byKind: await buckets('kind'),
    byMarket: await buckets('market'),
    byCountry: await buckets('country', 15),
    byIndustry: await buckets('industry', 20),
    bySource: await bySource(),
    reach: await reach(),
    perDay: await perDay(),
    funnel: await funnel(),
  };
}
