import { describe, expect, it } from 'vitest';
import { detectKind } from '../src/pipeline/company-kind.js';

const base = { tags: [], sources: [], description: null, sizeHint: null };

describe('тип компанії', () => {
  it('джерело стартапів сильніше за будь-які теги', () => {
    expect(detectKind({ ...base, sources: ['getro'], tags: ['Web Development'] })).toBe('startup');
    expect(detectKind({ ...base, sources: ['yc'] })).toBe('startup');
  });

  it('перевага дизайнерських тегів дає design', () => {
    expect(
      detectKind({ ...base, sources: ['clutch'], tags: ['Web Design', 'UI/UX Design', 'Branding'] }),
    ).toBe('design');
  });

  it('перевага розробницьких тегів дає studio', () => {
    expect(
      detectKind({
        ...base,
        sources: ['clutch'],
        tags: ['Web Development', 'Custom Software Development', 'Web Design'],
      }),
    ).toBe('studio');
  });

  it('рівна кількість тегів це studio, бо розробка ширша', () => {
    expect(detectKind({ ...base, sources: ['clutch'], tags: ['Web Design', 'Web Development'] })).toBe('studio');
  });

  it('аутстаф відділяється, туди писати нема сенсу', () => {
    expect(detectKind({ ...base, sources: ['clutch'], tags: ['IT Staff Augmentation'] })).toBe('outstaff');
  });

  it('один тег аутстафу серед розробницьких не робить компанію аутстафом', () => {
    expect(
      detectKind({
        ...base,
        sources: ['clutch'],
        tags: ['Web Development', 'Custom Software Development', 'IT Staff Augmentation'],
      }),
    ).toBe('studio');
  });

  it('компанія з ATS-джерела без тегів каталогу це продукт', () => {
    expect(detectKind({ ...base, sources: ['greenhouse'] })).toBe('product');
    expect(detectKind({ ...base, sources: ['rss:remotive'] })).toBe('product');
  });

  it('власний ATS без тегів каталогу це продуктова компанія', () => {
    // Vercel і Stripe прийшли з CSV-сіда, за міткою джерела лишались би unknown
    // і показувались би в Студіях, куди їм писати холодний лист марно.
    expect(detectKind({ ...base, sources: ['csv'], careersKind: 'greenhouse' })).toBe('product');
    expect(detectKind({ ...base, sources: ['csv'], careersKind: 'ashby' })).toBe('product');
  });

  it('ATS не перебиває теги каталогу: студія теж може мати greenhouse', () => {
    expect(
      detectKind({ ...base, sources: ['clutch'], tags: ['Web Development'], careersKind: 'greenhouse' }),
    ).toBe('studio');
  });

  it('каталог агенцій без тегів усе одно студія', () => {
    expect(detectKind({ ...base, sources: ['designrush'] })).toBe('studio');
  });

  it('опис підказує, коли тегів і знайомих джерел немає', () => {
    expect(detectKind({ ...base, description: 'We are a web design studio from Kyiv' })).toBe('studio');
  });

  it('порожня картка це unknown, а не вгадування', () => {
    expect(detectKind(base)).toBe('unknown');
  });
});
