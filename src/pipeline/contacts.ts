import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { contacts, type Contact } from '../db/schema.js';
import { log } from '../lib/log.js';
import { normalizeEmail } from './outreach.js';

/**
 * Правка контакту руками.
 *
 * Збір дає половинки. Сторінка команди віддає "Anna Koval, CTO" без адреси,
 * сторінка контактів віддає `anna@studio.com` без імені, а бувають адреси, які
 * видно тільки очима: в картинці, у формі, під скриптом. Зводити ці половинки
 * докупи мусить людина, і без цього файла єдиним способом було завести ще один
 * рядок, тобто зробити з двох половинок три.
 *
 * Тому тут не просто UPDATE. Якщо після правки адреса збігається з іншим рядком
 * тієї ж компанії, рядки зливаються в один, а не стають дублікатом.
 */

export interface ContactPatch {
  name?: string | null;
  role?: string | null;
  email?: string | null;
  /** Ручна позначка, що адреса жива. Скидається сама, коли адресу міняють. */
  emailValid?: boolean;
}

export interface ContactSaveResult {
  contact: Contact;
  /** Скільки рядків зникло при злитті. Інтерфейс має сказати про це вголос. */
  merged: number;
}

/** Порожній рядок з поля вводу означає "стерти", а не "не чіпати". */
function trimmed(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const clean = value.trim();
  return clean === '' ? null : clean;
}

export async function updateContact(id: number, patch: ContactPatch): Promise<ContactSaveResult> {
  const db = getDb();
  const [existing] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!existing) throw new Error(`контакту ${id} немає`);

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
      if (!email) throw new Error(`адреса не схожа на адресу: ${raw}`);
    }

    next.email = email;

    /*
     * Нова адреса вважається живою. Мертвою її робить лише hard bounce, а якщо
     * людина вписала адресу руками, вона її щойно бачила і перевірила.
     */
    if (email !== existing.email) next.emailValid = true;
  }

  if (patch.emailValid !== undefined) next.emailValid = patch.emailValid;

  const resultName = name === undefined ? existing.name : name;

  /*
   * Рядок без імені і без адреси нікуди не веде: ні листа написати, ні впізнати
   * людину. Стерти обидва поля означає видалити контакт, і це окрема кнопка.
   */
  if (!resultName && !email) {
    throw new Error('контакт без імені і без адреси ні на що не годиться, видали його');
  }

  let merged = 0;

  if (email) {
    /*
     * Той самий домен, та сама компанія, та сама адреса. Найчастіший випадок:
     * `hello@studio.com` уже лежить окремим рядком з минулого обходу, а власник
     * щойно приписав цю ж адресу знайденій людині. Виграє рядок з іменем, решта
     * віддає йому те, чого в нього немає, і зникає.
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
    'контакт відредаговано',
  );

  return { contact: row!, merged };
}

export interface ContactDeleteResult {
  deleted: boolean;
  companyId: number | null;
}

/**
 * Видалення руками. Потрібне рівно там, де збір помилився: у контакти регулярно
 * потрапляє інвестор з відгуку або клієнт з кейсу, і тримати його поруч зі своїм
 * техлідом означає рано чи пізно написати не туди.
 */
export async function deleteContact(id: number): Promise<ContactDeleteResult> {
  const db = getDb();
  const [existing] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!existing) return { deleted: false, companyId: null };

  await db.delete(contacts).where(eq(contacts.id, id));
  log.info({ id, companyId: existing.companyId, email: existing.email }, 'контакт видалено');

  return { deleted: true, companyId: existing.companyId };
}
