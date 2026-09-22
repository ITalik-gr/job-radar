import { useQuery } from '@tanstack/react-query';
import { Select } from '@mantine/core';
import { api } from '../lib/api';

/**
 * The template list comes from the database, not from an array in the code. The value
 * is the slug, because that is what lands in `outreach.template_used` as a snapshot
 * taken when the letter was sent.
 *
 * Archived ones are hidden: archiving means "out of sight, but not lost".
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
     * The label carries both the name and the language: templates come in uk and en
     * pairs, and without the language the list reads as two identical rows in a row.
     */
    .map((row) => ({ value: row.slug, label: `${row.name}, ${row.language}` }));

  /*
   * There is no "first in the list" choice here any more. The starting template is
   * suggested by the letter block on the same card, and it takes the company kind into
   * account, so its guess is better. While both set the value, whichever effect ran
   * last won, and the suggestion by company kind was silently overwritten by the first
   * row of the list.
   */

  return (
    <Select
      data={options}
      value={value}
      onChange={(next) => next && onChange(next)}
      placeholder={options.length === 0 ? 'no templates' : 'template'}
      disabled={options.length === 0}
      allowDeselect={false}
      w={width}
      aria-label="letter template"
    />
  );
}
