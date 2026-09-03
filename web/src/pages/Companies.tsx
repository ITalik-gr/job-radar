import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Card,
  DataList,
  Divider,
  Drawer,
  EmptyState,
  Group,
  Indicator,
  Paper,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Building2, ExternalLink, Mail, Search } from 'lucide-react';
import { api, formatDate, type CompanyRow } from '../lib/api';
import { Score } from '../components/Score';

const STATUSES = [
  'new',
  'interesting',
  'contacted',
  'replied',
  'rejected_by_me',
  'rejected_by_them',
  'blacklist',
  'snoozed',
];

const STATUS_LABELS: Record<string, string> = {
  new: 'нова',
  interesting: 'цікава',
  contacted: 'написали',
  replied: 'відповіли',
  rejected_by_me: 'відкинув сам',
  rejected_by_them: 'відмовили',
  blacklist: 'блокліст',
  snoozed: 'відкладена',
};

const ATS_KINDS = ['greenhouse', 'lever', 'ashby', 'html', 'rss', 'none', 'unknown'];

const STATUS_OPTIONS = STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] ?? status }));

function statusColor(status: string | null): string {
  if (status === 'blacklist' || status === 'rejected_by_them') return 'red';
  if (status === 'replied') return 'green';
  if (status === 'contacted') return 'yellow';
  if (status === 'interesting') return 'brand';
  return 'gray';
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text size="xs" tt="uppercase" fw={500} c="dimmed" style={{ letterSpacing: '0.04em' }}>
      {children}
    </Text>
  );
}

/**
 * Деталі відкриваються шухлядою збоку, а не модалкою по центру: таблиця лишається
 * на місці, і видно, який саме рядок відкритий. Так легше проходити список підряд.
 */
function Detail({ row, onClose }: { row: CompanyRow; onClose: () => void }) {
  const id = row.id;
  const client = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['company', id], queryFn: () => api.company(id) });

  const setState = useMutation({
    mutationFn: (status: string) => api.setCompanyState(id, { status }),
    onSuccess: (_result, status) => {
      notifications.show({ color: 'green', title: 'Статус змінено', message: STATUS_LABELS[status] ?? status });
      void client.invalidateQueries({ queryKey: ['company', id] });
      void client.invalidateQueries({ queryKey: ['companies'] });
    },
  });

  const open = data?.vacancies.filter((vacancy) => !vacancy.closedAt) ?? [];
  const closed = data?.vacancies.filter((vacancy) => vacancy.closedAt) ?? [];

  return (
    <Drawer
      opened
      onClose={onClose}
      position="right"
      size={620}
      padding="lg"
      title={
        data && (
          <Box>
            <Title order={3}>{data.company.name}</Title>
            <Anchor href={`https://${data.company.domain}`} target="_blank" rel="noreferrer" size="sm">
              {data.company.domain}
            </Anchor>
          </Box>
        )
      }
    >
      {error && (
        <Alert color="red" title="Не вдалось прочитати компанію">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      )}
      {!data && !error && <Skeleton h={280} />}

      {data && (
        <Stack gap="lg">
          <Select
            label="Статус"
            data={STATUS_OPTIONS}
            value={data.state?.status ?? 'new'}
            onChange={(status) => status && setState.mutate(status)}
            allowDeselect={false}
          />

          <DataList labelWidth={128} gap="sm">
            <DataList.Item>
              <DataList.ItemLabel>рахунок</DataList.ItemLabel>
              <DataList.ItemValue>
                {/* Рахунок приходить лише зі списку: деталі його не рахують. */}
                <Score value={row.score} />
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>ats</DataList.ItemLabel>
              <DataList.ItemValue>
                <Group gap="xs">
                  <Text>{data.company.careersKind}</Text>
                  {data.company.careersUrl && (
                    <Anchor href={data.company.careersUrl} target="_blank" rel="noreferrer" size="sm">
                      career-сторінка
                    </Anchor>
                  )}
                </Group>
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>де</DataList.ItemLabel>
              <DataList.ItemValue>
                {[data.company.city, data.company.country].filter(Boolean).join(', ') || (
                  <Text c="dimmed">не вказано</Text>
                )}
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>джерела</DataList.ItemLabel>
              <DataList.ItemValue>
                {data.company.sources.length === 0 ? (
                  <Text c="dimmed">невідомо</Text>
                ) : (
                  <Group gap={6}>
                    {data.company.sources.map((source) => (
                      <Badge key={source} color="gray">
                        {source}
                      </Badge>
                    ))}
                  </Group>
                )}
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>стек із сайту</DataList.ItemLabel>
              <DataList.ItemValue>
                {data.company.techHints.length === 0 ? (
                  <Text c="dimmed">не визначено</Text>
                ) : (
                  <Group gap={6}>
                    {data.company.techHints.map((tech) => (
                      <Badge key={tech}>{tech}</Badge>
                    ))}
                  </Group>
                )}
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>вперше побачили</DataList.ItemLabel>
              <DataList.ItemValue>
                <Text className="tabular">{formatDate(data.company.firstSeen) || 'невідомо'}</Text>
              </DataList.ItemValue>
            </DataList.Item>
          </DataList>

          <Divider />

          <Box>
            <SectionTitle>
              вакансії: {open.length} відкритих, {closed.length} закритих
            </SectionTitle>
            {data.vacancies.length === 0 ? (
              <Text c="dimmed" size="sm" mt="xs">
                жодної не бачили
              </Text>
            ) : (
              <Stack gap={2} mt="xs">
                {data.vacancies.map((vacancy) => (
                  <Group key={vacancy.id} gap="sm" wrap="nowrap">
                    <Score value={vacancy.score} size="sm" />
                    <Tooltip label={vacancy.llmWhy} disabled={!vacancy.llmWhy} multiline w={280}>
                      <Anchor
                        href={vacancy.url}
                        target="_blank"
                        rel="noreferrer"
                        size="sm"
                        style={{ flex: 1, minWidth: 0 }}
                        truncate
                      >
                        {vacancy.title ?? vacancy.url}
                      </Anchor>
                    </Tooltip>
                    <Text size="xs" c="dimmed" className="tabular" style={{ whiteSpace: 'nowrap' }}>
                      {formatDate(vacancy.firstSeen)}
                      {vacancy.closedAt ? ` - ${formatDate(vacancy.closedAt)}` : ' і досі'}
                    </Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Box>

          <Box>
            <SectionTitle>контакти</SectionTitle>
            {data.contacts.length === 0 ? (
              <Text c="dimmed" size="sm" mt="xs">
                немає, спробуй enrichment
              </Text>
            ) : (
              <Stack gap={6} mt="xs">
                {data.contacts.map((contact) => (
                  <Group key={contact.id} gap="xs">
                    <Mail size={14} color="var(--mantine-color-dimmed)" />
                    <Text size="sm" fw={500}>
                      {contact.name ?? 'без імені'}
                    </Text>
                    {contact.role && (
                      <Badge color="gray" size="sm">
                        {contact.role}
                      </Badge>
                    )}
                    {contact.email && (
                      <Anchor href={`mailto:${contact.email}`} size="sm">
                        {contact.email}
                      </Anchor>
                    )}
                  </Group>
                ))}
              </Stack>
            )}
          </Box>

          <Box>
            <SectionTitle>листування</SectionTitle>
            {data.outreach.length === 0 ? (
              <Text c="dimmed" size="sm" mt="xs">
                не писали
              </Text>
            ) : (
              <Stack gap={6} mt="xs">
                {data.outreach.map((row) => (
                  <Group key={row.id} gap="xs">
                    <Text size="sm" className="tabular">
                      {formatDate(row.sentAt)}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {row.channel}
                    </Text>
                    {row.templateUsed && (
                      <Badge color="gray" size="sm">
                        {row.templateUsed}
                      </Badge>
                    )}
                    <Badge size="sm" color={row.replyType === 'positive' ? 'green' : row.replyType ? 'gray' : 'yellow'}>
                      {row.replyType ?? 'без відповіді'}
                    </Badge>
                  </Group>
                ))}
              </Stack>
            )}
          </Box>

          <Box>
            <SectionTitle>знімки сторінок</SectionTitle>
            {data.snapshots.length === 0 ? (
              <Text c="dimmed" size="sm" mt="xs">
                немає
              </Text>
            ) : (
              <Stack gap={4} mt="xs">
                {data.snapshots.map((snapshot) => (
                  <Group key={snapshot.id} gap="sm">
                    <Text size="xs" className="tabular">
                      {formatDate(snapshot.fetchedAt)}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {snapshot.contentHash.slice(0, 12)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      блоків {snapshot.blocks}
                    </Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Box>
        </Stack>
      )}
    </Drawer>
  );
}

export function CompaniesPage() {
  const [filters, setFilters] = useState({ q: '', status: '', ats: '', country: '' });
  const [selected, setSelected] = useState<CompanyRow | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ['companies', filters],
    queryFn: () => api.companies(filters),
  });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Не вдалось прочитати список компаній">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  return (
    <Stack gap="md" p="lg">
      <Paper p="md">
        <Group gap="md">
          <TextInput
            placeholder="назва або домен"
            leftSection={<Search size={14} />}
            value={filters.q}
            onChange={(event) => setFilters({ ...filters, q: event.currentTarget.value })}
            w={280}
          />
          <Select
            placeholder="будь-який статус"
            data={STATUS_OPTIONS}
            value={filters.status || null}
            onChange={(status) => setFilters({ ...filters, status: status ?? '' })}
            clearable
            w={200}
          />
          <Select
            placeholder="будь-який ats"
            data={ATS_KINDS}
            value={filters.ats || null}
            onChange={(ats) => setFilters({ ...filters, ats: ats ?? '' })}
            clearable
            w={180}
          />
          <Text size="sm" c="dimmed" ml="auto">
            компаній {data?.length ?? 0}
          </Text>
        </Group>
      </Paper>

      {selected && <Detail row={selected} onClose={() => setSelected(null)} />}

      {isLoading && <Skeleton h={420} />}

      {data?.length === 0 && (
        <Card>
          <EmptyState
            icon={<Building2 size={28} />}
            withIndicatorBackground
            title="Жодної компанії під ці фільтри"
            description="Скинь пошук або збери каталог розширенням у браузері."
          />
        </Card>
      )}

      {data && data.length > 0 && (
        <Paper style={{ overflow: 'hidden' }}>
          <ScrollArea.Autosize mah="calc(100dvh - 224px)">
            {/* Фіксована розкладка: інакше колонка з назвою розтягується і виштовхує
                статус та лічильники за правий край. */}
            <Table stickyHeader layout="fixed">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={90}>рахунок</Table.Th>
                  <Table.Th>компанія</Table.Th>
                  <Table.Th w={110}>розмір</Table.Th>
                  <Table.Th w={190}>де</Table.Th>
                  <Table.Th w={130}>ats</Table.Th>
                  <Table.Th w={150}>статус</Table.Th>
                  <Table.Th w={110} ta="right">
                    відкритих
                  </Table.Th>
                  <Table.Th w={130} ta="right">
                    перевірено
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.map((row: CompanyRow) => (
                  <Table.Tr
                    key={row.id}
                    onClick={() => setSelected(row)}
                    style={{ cursor: 'pointer' }}
                    bg={selected?.id === row.id ? 'brand.0' : undefined}
                  >
                    <Table.Td>
                      <Score value={row.score} size="sm" />
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                        <Text fw={500} truncate style={{ minWidth: 0 }}>
                          {row.name}
                        </Text>
                        <Anchor
                          href={`https://${row.domain}`}
                          target="_blank"
                          rel="noreferrer"
                          size="xs"
                          c="dimmed"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Group gap={4} wrap="nowrap">
                            {row.domain}
                            <ExternalLink size={11} />
                          </Group>
                        </Anchor>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {row.sizeHint ?? ''}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" truncate>
                        {[row.city, row.country].filter(Boolean).join(', ')}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {row.careersKind === 'unknown' || row.careersKind === 'none' ? (
                        <Text size="sm" c="dimmed">
                          {row.careersKind}
                        </Text>
                      ) : (
                        <Badge>{row.careersKind}</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Indicator color={statusColor(row.status)} size={7} position="middle-start" offset={-2}>
                        <Text size="sm" pl="sm">
                          {STATUS_LABELS[row.status ?? 'new'] ?? row.status}
                        </Text>
                      </Indicator>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" c={row.openVacancies ? undefined : 'dimmed'} className="tabular">
                        {row.openVacancies}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" c="dimmed" className="tabular">
                        {formatDate(row.lastChecked) || 'ніколи'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Paper>
      )}
    </Stack>
  );
}
