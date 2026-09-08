import { useQuery } from '@tanstack/react-query';
import { Select } from '@mantine/core';
import { api } from '../lib/api';

/**
 * Список шаблонів приходить з бази, а не з масиву в коді. Значення це slug, бо саме
 * він лягає в `outreach.template_used` знімком на момент листа.
 *
 * Архівні не показуються: архів це "прибрати з очей, але не втратити".
 */
export function TemplateSelect({
  kind,
  value,
  onChange,
  width = 240,
}: {
  kind: 'vacancy' | 'studio';
  value: string | null;
  onChange: (slug: string) => void;
  width?: number;
}) {
  const { data } = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });

  const options = (data?.templates ?? [])
    .filter((row) => row.kind === kind && !row.archived)
    /*
     * У підписі і назва, і мова: шаблони ходять парами uk та en, і без мови
     * список читається як два однакові рядки поспіль.
     */
    .map((row) => ({ value: row.slug, label: `${row.name}, ${row.language}` }));

  /*
   * Тут більше немає вибору "перший у списку". Початковий шаблон пропонує блок листа
   * на тій самій картці, і він враховує тип компанії, тобто пропонує розумніше.
   * Поки обидва ставили значення самі, вигравав той, чий ефект спрацював останнім,
   * і підказка за типом компанії мовчки затиралась першим рядком списку.
   */

  return (
    <Select
      data={options}
      value={value}
      onChange={(next) => next && onChange(next)}
      placeholder={options.length === 0 ? 'шаблонів немає' : 'шаблон'}
      disabled={options.length === 0}
      allowDeselect={false}
      w={width}
      aria-label="шаблон листа"
    />
  );
}
