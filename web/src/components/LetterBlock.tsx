import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Code,
  CopyButton,
  Group,
  Select,
  Text,
  Tooltip,
} from '@mantine/core';
import { Check, Copy, Mail, TriangleAlert } from 'lucide-react';
import { mailtoLink, renderLetter } from '../../../src/lib/letter';
import { api } from '../lib/api';

/**
 * A letter ready to send: the owner's template with the values filled in, a copy button
 * and an open-mail button.
 *
 * Why: the database had hundreds of studios and zero letters sent. The "Contacted"
 * button exists, but the letter itself has to be put together somewhere, with the name
 * filled in and the niche right. That is the friction.
 *
 * Nobody makes up text here: values are substituted into a template the owner wrote.
 */
export function LetterBlock({
  company,
  domain,
  kind,
  stack,
  contactName,
  contactEmail,
  vacancyTitle,
  city,
  country,
  templateKind,
  slug: chosen,
  onSlug,
}: {
  company: string;
  domain: string;
  kind?: string | null;
  stack?: string[];
  contactName?: string | null;
  contactEmail?: string | null;
  vacancyTitle?: string | null;
  city?: string | null;
  country?: string | null;
  templateKind: 'vacancy' | 'studio';
  /**
   * The template choice, shared with the card. Without it the block had its own choice,
   * and one question got two answers: the preview showed one text while the send queue
   * and the "Contacted" record got another. Empty means the block picks on its own.
   */
  slug?: string | null;
  onSlug?: (slug: string) => void;
}) {
  const { data } = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });
  const [own, setOwn] = useState<string | null>(null);
  const slug = chosen !== undefined ? chosen : own;
  const setSlug = (next: string) => (onSlug ? onSlug(next) : setOwn(next));

  const options = (data?.templates ?? []).filter((row) => row.kind === templateKind && !row.archived);

  /*
   * By default the template made for this company's kind is taken, and only if there is
   * none, a universal one. A design studio and a startup get very different letters, and
   * picking by hand every time is the same friction that keeps letters unwritten.
   */
  const suggested = options.find((row) => row.forKind && row.forKind === kind) ?? options[0] ?? null;
  const selected = options.find((row) => row.slug === slug) ?? suggested;

  /*
   * The block's suggestion beats "first in the list": it accounts for the company kind.
   * So as soon as the block picks a template itself, the card learns about it, and the
   * select below shows the same thing as the preview.
   */
  useEffect(() => {
    if (onSlug && selected && selected.slug !== slug) onSlug(selected.slug);
  }, [onSlug, selected, slug]);

  /*
   * The same context for subject and body, with the first paragraph inside. The preview
   * must show exactly what goes into the mail, otherwise it is not a preview but another text.
   */
  const context = useMemo(
    () => ({
      company,
      domain,
      kind,
      stack,
      contactName,
      vacancyTitle,
      city,
      country,
      intro: selected?.intro ?? '',
    }),
    [company, domain, kind, stack, contactName, vacancyTitle, city, country, selected],
  );

  const rendered = useMemo(
    () => (selected ? renderLetter(selected.body, context) : null),
    [selected, context],
  );

  const subject = useMemo(
    () => (selected?.subject ? renderLetter(selected.subject, context).text : ''),
    [selected, context],
  );

  if (options.length === 0) {
    return (
      <Alert color="gray" mt="lg">
        No templates for this kind yet. Create one on the Templates page: you write the
        text, the radar only fills in the company name, the contact name and the stack.
      </Alert>
    );
  }

  const link = mailtoLink(contactEmail ?? null, subject, rendered?.text ?? '');
  const empty = !selected?.body.trim();

  return (
    <Box mt="lg">
      <Group gap="sm" mb="xs">
        <Text size="xs" tt="uppercase" fw={500} c="dimmed" style={{ letterSpacing: '0.04em' }}>
          letter
        </Text>
        <Select
          size="xs"
          data={options.map((row) => ({
            value: row.slug,
            label: row.forKind === kind ? `${row.name} (for this kind)` : row.name,
          }))}
          value={selected?.slug ?? null}
          onChange={(value) => value && setSlug(value)}
          allowDeselect={false}
          w={190}
          aria-label="letter template"
        />

        <CopyButton value={rendered?.text ?? ''}>
          {({ copied, copy }) => (
            <Button
              size="xs"
              variant={copied ? 'light' : 'default'}
              color={copied ? 'green' : undefined}
              leftSection={copied ? <Check size={14} /> : <Copy size={14} />}
              onClick={copy}
              disabled={empty}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>

        <Tooltip label={link ? `send to ${contactEmail}` : 'no email for this company yet'}>
          <Button
            size="xs"
            component="a"
            href={link ?? undefined}
            disabled={!link || empty}
            leftSection={<Mail size={14} />}
          >
            Open mail
          </Button>
        </Tooltip>
      </Group>

      {empty ? (
        <Alert color="yellow" icon={<TriangleAlert size={16} />}>
          The template "{selected?.name}" has no text. Write it on the Templates page.
        </Alert>
      ) : (
        <>
          {rendered && rendered.missing.length > 0 && (
            <Alert color="yellow" mb="xs" icon={<TriangleAlert size={16} />}>
              No values for: {rendered.missing.join(', ')}. The letter is blank in their
              place, so read it through before sending.
            </Alert>
          )}
          {rendered && rendered.unknown.length > 0 && (
            <Alert color="red" mb="xs" icon={<TriangleAlert size={16} />}>
              Unknown placeholders: {rendered.unknown.join(', ')}. Most likely a typo in
              the template.
            </Alert>
          )}
          {subject && (
            <Text size="sm" c="dimmed" mb={6}>
              Subject: {subject}
            </Text>
          )}
          <Code block className="raw-text" style={{ maxHeight: 320, overflowY: 'auto' }}>
            {rendered?.text}
          </Code>
        </>
      )}
    </Box>
  );
}
