import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Select } from '@mantine/core';
import { api } from '../lib/api';

/**
 * Список шаблонів приходить з бази, а не з масиву в коді. Значення це slug, бо саме
 * він лягає в `outreach.template_used` і мусить лишатись стабільним при перейменуванні.
 *
 * Архівні не показуються: вони лишаються в базі лише щоб історія листування не
 * посилалась у нікуди.
 */
export function TemplateSelect({
  kind,
  value,
  onChange,
  width = 168,
}: {
  kind: 'vacancy' | 'studio';
  value: string | null;
  onChange: (slug: string) => void;
  width?: number;
}) {
  const { data } = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });

  const options = (data?.templates ?? [])
    .filter((row) => row.kind === kind && !row.archived)
    .map((row) => ({ value: row.slug, label: row.name }));

  // Перший шаблон вибирається сам, інакше кнопка "Написав" писала б null у листування.
  const first = options[0]?.value;
  useEffect(() => {
    if (!value && first) onChange(first);
  }, [value, first, onChange]);

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
