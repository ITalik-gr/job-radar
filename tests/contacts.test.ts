import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { contacts, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { deleteContact, updateContact } from '../src/pipeline/contacts.js';

/**
 * Editing contacts by hand. The point of the check is that crawling brings in halves:
 * a name with a role but no address, and an address with no name. Merging the halves
 * must not create a third row, otherwise the database fills with junk and there is
 * no one to write the letter to.
 */

let company: Company;

async function contact(values: { name?: string | null; role?: string | null; email?: string | null }) {
  const [row] = await getDb()
    .insert(contacts)
    .values({ companyId: company.id, ...values })
    .returning();
  return row!;
}

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  company = (await upsertCompany({ name: 'Acme', domain: 'acme-contacts.com', source: 'test' })).company;
});

describe('editing a contact', () => {
  it('adds an email to a person who only had a name', async () => {
    const row = await contact({ name: 'Anna Koval', role: 'CTO' });
    const { contact: saved, merged } = await updateContact(row.id, { email: ' Anna@Acme-Contacts.com ' });

    expect(saved.email).toBe('anna@acme-contacts.com');
    expect(saved.name).toBe('Anna Koval');
    expect(merged).toBe(0);
  });

  it('adds a name to an address that did not have one', async () => {
    const row = await contact({ email: 'ihor@acme-contacts.com' });
    const { contact: saved } = await updateContact(row.id, { name: 'Ihor Bondar', role: 'Tech Lead' });

    expect(saved.name).toBe('Ihor Bondar');
    expect(saved.role).toBe('Tech Lead');
  });

  /*
   * The most common editing case: a general mailbox already sits in its own row from
   * a past crawl, and the owner attaches that same address to a person who was found.
   * There must not be two rows with the same address, otherwise the letter would go out twice.
   */
  it('merges rows when the address matches an existing one', async () => {
    const db = getDb();
    const plain = await contact({ email: 'office@acme-contacts.com', role: 'Office' });
    const person = await contact({ name: 'Olena Marchuk' });

    const { contact: saved, merged } = await updateContact(person.id, {
      email: 'office@acme-contacts.com',
    });

    expect(merged).toBe(1);
    expect(saved.name).toBe('Olena Marchuk');
    // The role came from the row that disappeared: the person did not have their own.
    expect(saved.role).toBe('Office');
    expect(await db.select().from(contacts).where(eq(contacts.id, plain.id))).toHaveLength(0);
  });

  it('a new address is treated as live even if the old one was dead', async () => {
    const row = await contact({ name: 'Petro', email: 'dead@acme-contacts.com' });
    await getDb().update(contacts).set({ emailValid: false }).where(eq(contacts.id, row.id));

    const { contact: saved } = await updateContact(row.id, { email: 'petro@acme-contacts.com' });
    expect(saved.emailValid).toBe(true);
  });

  it('an empty field clears the value instead of keeping the old one', async () => {
    const row = await contact({ name: 'Temp', role: 'Manager', email: 'temp@acme-contacts.com' });
    const { contact: saved } = await updateContact(row.id, { role: '  ' });
    expect(saved.role).toBeNull();
  });

  it('a malformed address is not saved', async () => {
    const row = await contact({ name: 'Broken' });
    await expect(updateContact(row.id, { email: 'not an email' })).rejects.toThrow(/address/);
  });

  /*
   * A row with no name and no address leads nowhere. Clearing both fields is a deletion,
   * and it is done through a separate button, not as a side effect of editing.
   */
  it('does not allow leaving a contact without a name and without an address', async () => {
    const row = await contact({ name: 'Ghost', email: 'ghost@acme-contacts.com' });
    await expect(updateContact(row.id, { name: '', email: '' })).rejects.toThrow(/delete/);
  });

  it('deletes a contact', async () => {
    const row = await contact({ name: 'Investor', role: 'Former CEO of GitHub' });
    expect(await deleteContact(row.id)).toEqual({ deleted: true, companyId: company.id });
    expect(await deleteContact(row.id)).toEqual({ deleted: false, companyId: null });
  });
});
