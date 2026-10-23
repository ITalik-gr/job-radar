import { readSetting, writeSetting } from '../lib/settings-store.js';
import { localDay } from '../lib/time.js';
import { RECONTACT_DAYS } from './outreach.js';
import { rules } from './rules.js';
import { studioPage, type StudioCard } from './studios.js';

/**
 * The daily slice, section 6 of CLAUDE.md: a short list of who to write to today, mixed across
 * segments so a day is not ten studios in a row.
 *
 * The slice is fixed for the day (section 11): cards do not reshuffle under the owner's hands
 * while scores move. A card acted on stays in place marked done. Cards left untouched roll over
 * to the next day first. Empty places are topped up, which moves nothing already shown.
 */

export const QUEUE_KEY = 'daily_queue';

interface StoredSlice {
  day: string;
  ids: number[];
  carried: number;
  /** How many companies could be in a slice when this one was made. */
  eligible?: number;
}

export interface QueueCard extends StudioCard {
  /** Acted on since the slice was made: written to, rejected, snoozed, blacklisted. */
  done: boolean;
}

export interface DailyQueue {
  day: string;
  size: number;
  cards: QueueCard[];
  /** How many cards came over from an earlier day. */
  carried: number;
  /** How many companies could be in a slice right now. */
  eligible: number;
}

const OPEN_STATUSES = ['new', 'interesting'];

/**
 * A company belongs in the queue when it is above the threshold, is not a product company, is not
 * snoozed, has not been handled, and can be reached at all. A company written to more than
 * `RECONTACT_DAYS` ago comes back.
 */
export function isEligible(card: StudioCard, threshold: number, now: number): boolean {
  if (card.score < threshold) return false;
  if (card.kind === 'product') return false;
  if (card.snoozedUntil && card.snoozedUntil > now) return false;

  const open = OPEN_STATUSES.includes(card.status);
  const recontact =
    card.status === 'contacted' &&
    (card.lastContactedAt === null || now - card.lastContactedAt >= RECONTACT_DAYS * 86_400_000);
  if (!open && !recontact) return false;

  const reachable =
    card.contacts.some((contact) => (contact.email && contact.emailValid) || contact.phone) || Boolean(card.phone);
  return reachable;
}

/**
 * Round robin across segments, best first inside each. The segment whose best card scores highest
 * goes first, so a strong studio is not pushed out by the rule of mixing.
 */
export function pickAcrossSegments(cards: StudioCard[], count: number): StudioCard[] {
  if (count <= 0) return [];
  const bySegment = new Map<string, StudioCard[]>();
  for (const card of [...cards].sort((a, b) => b.score - a.score)) {
    const list = bySegment.get(card.kind);
    if (list) list.push(card);
    else bySegment.set(card.kind, [card]);
  }

  const segments = [...bySegment.values()].sort((a, b) => b[0]!.score - a[0]!.score);
  const picked: StudioCard[] = [];
  for (let round = 0; picked.length < count; round += 1) {
    let took = false;
    for (const list of segments) {
      const card = list[round];
      if (!card) continue;
      picked.push(card);
      took = true;
      if (picked.length === count) break;
    }
    if (!took) break;
  }
  return picked;
}

export async function dailyQueue(now = new Date()): Promise<DailyQueue> {
  const day = localDay(now);
  const size = rules().queue.size;
  const threshold = rules().companies.threshold;
  const at = now.getTime();

  const stored = await readSetting<StoredSlice | null>(QUEUE_KEY, null);

  /*
   * Today's slice is already full: score only its own companies. Scoring the whole directory took
   * over a second on D1 for ten cards. The eligible count is the one taken when the slice was made.
   */
  if (stored?.day === day && stored.ids.length >= size && stored.eligible !== undefined) {
    const { cards: own } = await studioPage({ scope: 'all', ids: stored.ids, limit: Number.MAX_SAFE_INTEGER });
    const ownById = new Map(own.map((card) => [card.companyId, card]));
    if (stored.ids.every((id) => ownById.has(id))) {
      return {
        day,
        size,
        cards: stored.ids.map((id) => {
          const card = ownById.get(id)!;
          return { ...card, done: !isEligible(card, threshold, at) };
        }),
        carried: stored.carried ?? 0,
        eligible: stored.eligible,
      };
    }
  }

  // One pass over the directory: done cards need their current status, eligible ones their score.
  const { cards: all } = await studioPage({ scope: 'all', limit: Number.MAX_SAFE_INTEGER });
  const byId = new Map(all.map((card) => [card.companyId, card]));
  const eligible = all.filter((card) => isEligible(card, threshold, at));
  const eligibleIds = new Set(eligible.map((card) => card.companyId));

  let ids: number[];
  let carried = 0;

  if (stored?.day === day) {
    // Today's slice: keep it as is, a company deleted since simply drops out.
    ids = stored.ids.filter((id) => byId.has(id));
    carried = stored.carried ?? 0;
  } else {
    ids = (stored?.ids ?? []).filter((id) => eligibleIds.has(id)).slice(0, size);
    carried = ids.length;
  }

  const taken = new Set(ids);
  const fill = pickAcrossSegments(
    eligible.filter((card) => !taken.has(card.companyId)),
    size - ids.length,
  );
  const next = [...ids, ...fill.map((card) => card.companyId)];

  if (stored?.day !== day || next.length !== stored.ids.length || stored.eligible === undefined) {
    await writeSetting(QUEUE_KEY, { day, ids: next, carried, eligible: eligible.length } satisfies StoredSlice);
  }

  return {
    day,
    size,
    cards: next.map((id) => {
      const card = byId.get(id)!;
      return { ...card, done: !eligibleIds.has(id) };
    }),
    carried,
    eligible: eligible.length,
  };
}
