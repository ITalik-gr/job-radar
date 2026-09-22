import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { contacts, type Contact } from '../db/schema.js';
import { log } from '../lib/log.js';
import { normalizeEmail } from './outreach.js';

/**
 * Editing a contact by hand.
 *
 * Collection gives back halves. The team page hands over "Anna Koval, CTO" with no
 * address, the contacts page hands over `anna@studio.com` with no name, and some
 * addresses can only be seen with your own eyes: in an image, in a form, behind a
 * script. A person has to put these halves together, and without this file the only
 * way was to add yet another row, turning two halves into three.
 *
 * So this isn't just an UPDATE. If after the edit the address matches another row of
 * the same company, the rows merge into one instead of becoming a duplicate.
 */

export interface ContactPatch {
  name?: string | null;
  role?: string | null;
  email?: string | null;
  /** Manual mark that the address is alive. Resets itself when the address changes. */
  emailValid?: boolean;
}

export interface ContactSaveResult {
  contact: Contact;
  /** How many rows disappeared in the merge. The UI has to say this out loud. */
  merged: number;
}

/** An empty string from the input field means "erase", not "leave alone". */
function trimmed(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const clean = value.trim();
  return clean === '' ? null : clean;
}

export async function updateContact(id: number, patch: ContactPatch): Promise<ContactSaveResult> {
  const db = getDb();
  const [existing] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!existing) throw new Error(`contact ${id} does not exist`);

  const next: Record<string, unknown> = {};

  const name = trimmed(patch.name);
  if (name !== undefined) next.name = name;

  const role = trimmed(patch.role);
  if (role !== undefined) next.role = role;

  let email = existing.email;
  if (patch.email !== undefined) {
    const raw = trimmed(patch.email);

    if (raw === null) {
      email = null;
    } else {
      email = normalizeEmail(raw);
      if (!email) throw new Error(`does not look like an address: ${raw}`);
    }

    next.email = email;

    /*
     * A new address is considered alive. Only a hard bounce makes it dead, and if a
     * person typed the address by hand, they just saw it and checked it.
     */
    if (email !== existing.email) next.emailValid = true;
  }

  if (patch.emailValid !== undefined) next.emailValid = patch.emailValid;

  const resultName = name === undefined ? existing.name : name;

  /*
   * A row with no name and no address leads nowhere: no letter to write, no person to
   * recognize. Erasing both fields means deleting the contact, and that's a separate button.
   */
  if (!resultName && !email) {
    throw new Error('a contact with no name and no address is useless, delete it');
  }

  let merged = 0;

  if (email) {
    /*
     * The same domain, the same company, the same address. The most common case:
     * `hello@studio.com` already sits in a separate row from a past crawl, and the owner
     * just attached that same address to a person they found. The row with a name
     * wins, the rest hands it whatever it's missing and disappears.
     */
    const twins = await db
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.companyId, existing.companyId), eq(contacts.email, email), ne(contacts.id, id)),
      );

    for (const twin of twins) {
      if (next.name === undefined && !existing.name && twin.name) next.name = twin.name;
      if (next.role === undefined && !existing.role && twin.role) next.role = twin.role;
      if (!existing.telegram && twin.telegram) next.telegram = twin.telegram;
      if (!existing.linkedin && twin.linkedin) next.linkedin = twin.linkedin;
      if (!existing.xHandle && twin.xHandle) next.xHandle = twin.xHandle;
      if (!existing.sourceUrl && twin.sourceUrl) next.sourceUrl = twin.sourceUrl;
      await db.delete(contacts).where(eq(contacts.id, twin.id));
      merged += 1;
    }
  }

  const [row] = await db.update(contacts).set(next).where(eq(contacts.id, id)).returning();

  log.info(
    { id, companyId: existing.companyId, email: row!.email, name: row!.name, merged },
    'contact edited',
  );

  return { contact: row!, merged };
}

export interface ContactDeleteResult {
  deleted: boolean;
  companyId: number | null;
}

/**
 * Manual deletion. Needed exactly where collection got it wrong: contacts regularly
 * pick up an investor from a testimonial or a client from a case study, and keeping
 * them next to your actual tech lead means sooner or later writing to the wrong person.
 */
export async function deleteContact(id: number): Promise<ContactDeleteResult> {
  const db = getDb();
  const [existing] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!existing) return { deleted: false, companyId: null };

  await db.delete(contacts).where(eq(contacts.id, id));
  log.info({ id, companyId: existing.companyId, email: existing.email }, 'contact deleted');

  return { deleted: true, companyId: existing.companyId };
}
