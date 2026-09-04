import { useMemo, useState } from 'react';
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
 * Готовий до відправки лист: шаблон власника з підставленими значеннями,
 * кнопка скопіювати і кнопка відкрити пошту.
 *
 * Навіщо: у базі сотні студій і нуль надісланих листів. Кнопка "Написав" є, але
 * сам лист треба десь скласти, підставити назву, не переплутати нішу. Це і є тертя.
 *
 * Тексту тут ніхто не вигадує: підстановка значень у шаблон, який написав власник.
 */
export function LetterBlock({
  company,
  domain,
  kind,
  stack,
  contactName,
  contactEmail,
  vacancyTitle,
  templateKind,
}: {
  company: string;
  domain: string;
  kind?: string | null;
  stack?: string[];
  contactName?: string | null;
  contactEmail?: string | null;
  vacancyTitle?: string | null;
  templateKind: 'vacancy' | 'studio';
}) {
  const { data } = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });
  const [slug, setSlug] = useState<string | null>(null);

  const options = (data?.templates ?? []).filter((row) => row.kind === templateKind && !row.archived);

  /*
   * За замовчуванням береться шаблон, заточений під тип цієї компанії, і лише
   * якщо такого немає, універсальний. Дизайн-студії і стартапу пишеться зовсім
   * різне, і вибирати руками щоразу це те саме тертя, через яке листи не пишуться.
   */
  const suggested = options.find((row) => row.forKind && row.forKind === kind) ?? options[0] ?? null;
  const selected = options.find((row) => row.slug === slug) ?? suggested;

  const rendered = useMemo(
    () =>
      selected
        ? renderLetter(selected.body, { company, domain, kind, stack, contactName, vacancyTitle })
        : null,
    [selected, company, domain, kind, stack, contactName, vacancyTitle],
  );

  const subject = useMemo(
    () => (selected?.subject ? renderLetter(selected.subject, { company, domain, kind, stack, contactName, vacancyTitle }).text : ''),
    [selected, company, domain, kind, stack, contactName, vacancyTitle],
  );

  if (options.length === 0) {
    return (
      <Alert color="gray" mt="lg">
        Шаблонів під цей тип ще немає. Створи на сторінці Шаблони: текст пишеш ти,
        радар лише підставляє назву компанії, імʼя контакту і стек.
      </Alert>
    );
  }

  const link = mailtoLink(contactEmail ?? null, subject, rendered?.text ?? '');
  const empty = !selected?.body.trim();

  return (
    <Box mt="lg">
      <Group gap="sm" mb="xs">
        <Text size="xs" tt="uppercase" fw={500} c="dimmed" style={{ letterSpacing: '0.04em' }}>
          лист
        </Text>
        <Select
          size="xs"
          data={options.map((row) => ({
            value: row.slug,
            label: row.forKind === kind ? `${row.name} (під цей тип)` : row.name,
          }))}
          value={selected?.slug ?? null}
          onChange={(value) => value && setSlug(value)}
          allowDeselect={false}
          w={190}
          aria-label="шаблон листа"
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
              {copied ? 'Скопійовано' : 'Скопіювати'}
            </Button>
          )}
        </CopyButton>

        <Tooltip label={link ? `надіслати на ${contactEmail}` : 'пошти цієї компанії ще немає'}>
          <Button
            size="xs"
            component="a"
            href={link ?? undefined}
            disabled={!link || empty}
            leftSection={<Mail size={14} />}
          >
            Відкрити пошту
          </Button>
        </Tooltip>
      </Group>

      {empty ? (
        <Alert color="yellow" icon={<TriangleAlert size={16} />}>
          У шаблона «{selected?.name}» порожній текст. Напиши його на сторінці Шаблони.
        </Alert>
      ) : (
        <>
          {rendered && rendered.missing.length > 0 && (
            <Alert color="yellow" mb="xs" icon={<TriangleAlert size={16} />}>
              Немає значень для: {rendered.missing.join(', ')}. У листі на їх місці порожньо,
              тому перечитай перед відправкою.
            </Alert>
          )}
          {rendered && rendered.unknown.length > 0 && (
            <Alert color="red" mb="xs" icon={<TriangleAlert size={16} />}>
              Невідомі плейсхолдери: {rendered.unknown.join(', ')}. Скоріш за все друкарська
              помилка в шаблоні.
            </Alert>
          )}
          {subject && (
            <Text size="sm" c="dimmed" mb={6}>
              Тема: {subject}
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
