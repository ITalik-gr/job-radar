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
 * Правка контактів руками. Сенс перевірки в тому, що збір приносить половинки:
 * імʼя з посадою без адреси і адресу без імені. Зведення половинок докупи не має
 * створювати третій рядок, інакше в базі росте сміття, а лист писати нема кому.
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

describe('правка контакту', () => {
  it('дописує пошту людині, у якої було тільки імʼя', async () => {
    const row = await contact({ name: 'Anna Koval', role: 'CTO' });
    const { contact: saved, merged } = await updateContact(row.id, { email: ' Anna@Acme-Contacts.com ' });

    expect(saved.email).toBe('anna@acme-contacts.com');
    expect(saved.name).toBe('Anna Koval');
    expect(merged).toBe(0);
  });

  it('дописує імʼя до адреси, у якої його не було', async () => {
    const row = await contact({ email: 'ihor@acme-contacts.com' });
    const { contact: saved } = await updateContact(row.id, { name: 'Ihor Bondar', role: 'Tech Lead' });

    expect(saved.name).toBe('Ihor Bondar');
    expect(saved.role).toBe('Tech Lead');
  });

  /*
   * Найчастіший випадок правки: загальна скринька вже лежить окремим рядком з
   * минулого обходу, і власник приписує ту саму адресу знайденій людині. Двох
   * рядків з однією адресою бути не має, інакше лист піде двічі.
   */
  it('зливає рядки, коли адреса збіглася з наявною', async () => {
    const db = getDb();
    const plain = await contact({ email: 'office@acme-contacts.com', role: 'Office' });
    const person = await contact({ name: 'Olena Marchuk' });

    const { contact: saved, merged } = await updateContact(person.id, {
      email: 'office@acme-contacts.com',
    });

    expect(merged).toBe(1);
    expect(saved.name).toBe('Olena Marchuk');
    // Роль дісталась від рядка, який зник: своєї в людини не було.
    expect(saved.role).toBe('Office');
    expect(await db.select().from(contacts).where(eq(contacts.id, plain.id))).toHaveLength(0);
  });

  it('нова адреса вважається живою, навіть якщо стара була мертвою', async () => {
    const row = await contact({ name: 'Petro', email: 'dead@acme-contacts.com' });
    await getDb().update(contacts).set({ emailValid: false }).where(eq(contacts.id, row.id));

    const { contact: saved } = await updateContact(row.id, { email: 'petro@acme-contacts.com' });
    expect(saved.emailValid).toBe(true);
  });

  it('порожнє поле стирає значення, а не лишає старе', async () => {
    const row = await contact({ name: 'Temp', role: 'Manager', email: 'temp@acme-contacts.com' });
    const { contact: saved } = await updateContact(row.id, { role: '  ' });
    expect(saved.role).toBeNull();
  });

  it('крива адреса не зберігається', async () => {
    const row = await contact({ name: 'Broken' });
    await expect(updateContact(row.id, { email: 'не пошта' })).rejects.toThrow(/адреса/);
  });

  /*
   * Рядок без імені і без адреси нікуди не веде. Стерти обидва поля це видалення,
   * і робиться воно окремою кнопкою, а не як побічний ефект правки.
   */
  it('не дає лишити контакт без імені і без адреси', async () => {
    const row = await contact({ name: 'Ghost', email: 'ghost@acme-contacts.com' });
    await expect(updateContact(row.id, { name: '', email: '' })).rejects.toThrow(/видали/);
  });

  it('видаляє контакт', async () => {
    const row = await contact({ name: 'Investor', role: 'Former CEO of GitHub' });
    expect(await deleteContact(row.id)).toEqual({ deleted: true, companyId: company.id });
    expect(await deleteContact(row.id)).toEqual({ deleted: false, companyId: null });
  });
});
