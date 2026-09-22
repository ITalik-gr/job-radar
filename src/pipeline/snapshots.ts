import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, snapshots, type Snapshot } from '../db/schema.js';
import { config } from '../config.js';
import { log } from '../lib/log.js';
import { diffBlocks, type BlockDiff } from './diff.js';
import { normalizePage, type NormalizedPage } from './normalize.js';

export interface SaveSnapshotResult {
  snapshot: Snapshot;
  page: NormalizedPage;
  diff: BlockDiff;
  /** true when there was no previous snapshot yet. Then "new" blocks are just the first pass. */
  first: boolean;
  /** The page hash changed even though the set of blocks is the same: noise in normalization. */
  noiseOnly: boolean;
}

export async function lastSnapshot(companyId: number, url: string): Promise<Snapshot | undefined> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.companyId, companyId), eq(snapshots.url, url)))
    .orderBy(desc(snapshots.fetchedAt), desc(snapshots.id))
    .limit(1);
  return row;
}

/** Keeps only the last N snapshots per company, older ones are cleaned up. */
export async function pruneSnapshots(companyId: number, keep = config.pipeline.snapshotsPerCompany) {
  const db = getDb();
  const rows = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(eq(snapshots.companyId, companyId))
    .orderBy(desc(snapshots.fetchedAt), desc(snapshots.id));

  const stale = rows.slice(keep).map((row) => row.id);
  if (stale.length > 0) await db.delete(snapshots).where(inArray(snapshots.id, stale));
  return stale.length;
}

export async function saveSnapshot(
  companyId: number,
  url: string,
  html: string,
): Promise<SaveSnapshotResult> {
  const db = getDb();
  const page = normalizePage(html);
  const previous = await lastSnapshot(companyId, url);
  const diff = diffBlocks(previous?.blockHashes ?? [], page.blocks);
  const first = !previous;
  const noiseOnly = Boolean(previous) && previous!.contentHash !== page.contentHash && !diff.changed;

  if (noiseOnly) {
    log.warn(
      { companyId, url },
      'page hash changed but the set of blocks did not: normalization is skipping noise',
    );
  }

  const [snapshot] = await db
    .insert(snapshots)
    .values({
      companyId,
      url,
      contentHash: page.contentHash,
      textNormalized: page.text,
      blockHashes: page.blocks.map((block) => block.hash),
    })
    .returning();

  await pruneSnapshots(companyId);

  if (diff.changed && !first) {
    await db.update(companies).set({ lastChangeAt: Date.now() }).where(eq(companies.id, companyId));
  }
  await db.update(companies).set({ lastChecked: Date.now() }).where(eq(companies.id, companyId));

  return { snapshot: snapshot!, page, diff, first, noiseOnly };
}
