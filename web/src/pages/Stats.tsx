import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Card,
  Divider,
  Group,
  Progress,
  ScrollArea,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { RankBars, TimeSeries } from '../components/charts';

/** The owner's stack. Used to show, in the top technologies, what the owner does not know. */
const OWN_STACK = new Set([
  'react',
  'next.js',
  'nextjs',
  'astro',
  'typescript',
  'javascript',
  'node',
  'node.js',
  'nestjs',
  'express',
  'postgresql',
  'postgres',
  'prisma',
  'cloudflare',
  'hono',
  'stripe',
  'supabase',
  'firebase',
  'tailwind',
  'html',
  'css',
]);

/*
 * A real funnel is only the steps where each follows from the one before.
 * The number of companies and open vacancies does not belong in it: that is the size
 * of the database, and on a shared scale it simply flattens the other bars.
 */
const FUNNEL_STEPS: [key: string, label: string][] = [
  ['shown', 'shown in the queue'],
  ['decided', 'decided'],
  ['contacted', 'contacted'],
  ['replied', 'replied'],
  ['positive', 'positive'],
];

function Hero({ value, unit, hint }: { value: string; unit?: string; hint: string }) {
  return (
    <Box>
      <Group gap={6} align="baseline">
        <Text fz={32} fw={600} lh={1.1} className="tabular">
          {value}
        </Text>
        {unit && (
          <Text fz="md" c="dimmed">
            {unit}
          </Text>
        )}
      </Group>
      <Text size="sm" c="dimmed" mt={4}>
        {hint}
      </Text>
    </Box>
  );
}

function CardTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <Box mb="lg">
      <Title order={4}>{title}</Title>
      <Text size="sm" c="dimmed">
        {hint}
      </Text>
    </Box>
  );
}

function Funnel({ funnel }: { funnel: Record<string, number> }) {
  const top = Math.max(1, funnel[FUNNEL_STEPS[0]![0]] ?? 0);

  return (
    <Stack gap="sm">
      {FUNNEL_STEPS.map(([key, label], index) => {
        const value = funnel[key] ?? 0;
        const previous = index === 0 ? null : (funnel[FUNNEL_STEPS[index - 1]![0]] ?? 0);
        const share = previous && previous > 0 ? Math.round((value / previous) * 100) : null;

        return (
          <Box key={key}>
            <Group gap="xs" mb={4}>
              <Text size="sm">{label}</Text>
              <Text size="sm" fw={600} className="tabular" ml="auto">
                {value}
              </Text>
              <Text size="xs" c="dimmed" w={44} ta="right" className="tabular">
                {share === null ? '' : `${share} %`}
              </Text>
            </Group>
            <Progress value={(value / top) * 100} size="sm" />
          </Box>
        );
      })}
    </Stack>
  );
}

/**
 * Sending as a separate block. The key number here is not conversion but the share of
 * validation fallbacks: above 30 percent means a bad prompt, and it shows at once.
 */
function OutreachPanel() {
  const { data } = useQuery({ queryKey: ['outreachStats'], queryFn: () => api.outreachStats() });
  if (!data) return null;

  const fallback = Math.round(data.fallbackShare * 100);

  return (
    <Card withBorder p="md" style={{ gridColumn: '1 / -1' }}>
      <Text fw={600} mb="xs">
        Sending
      </Text>
      <SimpleGrid cols={{ base: 2, md: 4 }} mb="sm">
        <Box>
          <Text size="xs" c="dimmed">drafts</Text>
          <Text fw={600} className="tabular">{data.drafts}, {data.needsAttention} need attention</Text>
        </Box>
        <Box>
          <Text size="xs" c="dimmed">validation fallbacks</Text>
          <Text fw={600} className="tabular" c={fallback > 30 ? 'red' : undefined}>{fallback} percent</Text>
        </Box>
        <Box>
          <Text size="xs" c="dimmed">bounces over 50 letters</Text>
          <Text fw={600} className="tabular" c={data.bounceRate > 0.03 ? 'red' : undefined}>
            {Math.round(data.bounceRate * 100)} percent
          </Text>
        </Box>
        <Box>
          <Text size="xs" c="dimmed">median time to reply</Text>
          <Text fw={600} className="tabular">
            {data.medianReplyHours === null ? 'none yet' : `${data.medianReplyHours.toFixed(1)} h`}
          </Text>
        </Box>
      </SimpleGrid>

      <Text size="sm" mb={4}>
        AI versus template: {data.ai.sent} against {data.static.sent} sent, positive{' '}
        {data.ai.positive} against {data.static.positive}
      </Text>

      {data.byTemplate.length > 0 && (
        <RankBars
          rows={data.byTemplate.map((row) => ({
            label: `${row.template} (${row.sent})`,
            value: row.positive,
          }))}
          labelWidth={180}
        />
      )}

      {data.fallbacks.length > 0 && (
        <Text size="xs" c="dimmed" mt="xs">
          fallback reasons: {data.fallbacks.map((item) => `${item.reason} ${item.count}`).join(', ')}
        </Text>
      )}
    </Card>
  );
}

export function StatsPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['fullStats'], queryFn: () => api.fullStats() });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Could not read the statistics">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  if (isLoading || !data) {
    return (
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md" p="lg">
        {Array.from({ length: 4 }, (_, position) => (
          <Skeleton key={position} h={280} />
        ))}
      </SimpleGrid>
    );
  }

  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md" p="lg" style={{ alignItems: 'start' }}>
      <Card>
        <CardTitle title="Funnel" hint="each step as a share of the previous one" />
        <Group gap="xl" mb="lg">
          <Hero value={String(data.funnel.companies ?? 0)} hint="companies in the database" />
          <Hero value={String(data.funnel.vacanciesOpen ?? 0)} hint="open vacancies" />
          <Hero value={String(data.funnel.waitingReply ?? 0)} hint="awaiting reply" />
        </Group>
        <Divider mb="lg" />
        <Funnel funnel={data.funnel} />
      </Card>

      <Card>
        <CardTitle title="New vacancies per day" hint="how many new blocks the diff brought each day" />
        {data.perDay.length === 0 ? (
          <Text c="dimmed">nothing yet</Text>
        ) : (
          <TimeSeries rows={[...data.perDay].reverse()} unit="items" />
        )}
      </Card>

      <Card>
        <CardTitle title="Top technologies" hint="over 90 days, in classified vacancies" />
        {data.topTech.length === 0 ? (
          <Text c="dimmed">no data yet, classification is needed</Text>
        ) : (
          <>
            {/* The legend is required: colour means something here, it is not decoration. */}
            <Group gap="lg" mb="md">
              <Group gap={6}>
                <Box w={10} h={10} bg="#2a78d6" style={{ borderRadius: 2 }} />
                <Text size="sm" c="dimmed">
                  in my stack
                </Text>
              </Group>
              <Group gap={6}>
                <Box w={10} h={10} bg="#b7d3f6" style={{ borderRadius: 2 }} />
                <Text size="sm" c="dimmed">
                  gap
                </Text>
              </Group>
            </Group>
            <RankBars
              rows={data.topTech.slice(0, 15).map((row) => ({ label: row.tech, value: row.count }))}
              highlight={(row) => OWN_STACK.has(row.label)}
            />
          </>
        )}
      </Card>

      <Card>
        <CardTitle title="Vacancy lifetime" hint="time between first and last sighting" />
        <Group gap="xl">
          <Hero
            value={data.lifetimes.medianDays?.toFixed(1) ?? 'none'}
            unit={data.lifetimes.medianDays !== null ? 'days' : undefined}
            hint={`median over ${data.lifetimes.closedCount} closed`}
          />
          <Hero value={String(data.lifetimes.ghosts.length)} hint="suspected ghost jobs, over 120 days" />
        </Group>

        {data.lifetimes.ghosts.length > 0 && (
          <>
            <Divider my="lg" />
            <ScrollArea.Autosize mah={200}>
              <Stack gap={6}>
                {data.lifetimes.ghosts.map((ghost) => (
                  <Group key={ghost.id} gap="sm" wrap="nowrap">
                    <Badge color="yellow" leftSection={<TriangleAlert size={11} />}>
                      {ghost.days}d
                    </Badge>
                    <Anchor
                      href={ghost.url}
                      target="_blank"
                      rel="noreferrer"
                      size="sm"
                      truncate
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      {ghost.company}: {ghost.title}
                    </Anchor>
                  </Group>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          </>
        )}
      </Card>

      <Card>
        <CardTitle title="Median salary by seniority" hint="only vacancies with a salary range" />
        {data.salariesBySeniority.length === 0 ? (
          <Text c="dimmed">no salary ranges in vacancies yet</Text>
        ) : (
          <RankBars
            rows={data.salariesBySeniority.map((row) => ({
              label: `${row.group} (${row.count})`,
              value: row.median ?? 0,
            }))}
            labelWidth={116}
          />
        )}
      </Card>

      <Card>
        <CardTitle title="Median salary by country" hint="only vacancies with a salary range" />
        {data.salariesByCountry.length === 0 ? (
          <Text c="dimmed">no salary ranges in vacancies yet</Text>
        ) : (
          <RankBars
            rows={data.salariesByCountry.map((row) => ({
              label: `${row.group} (${row.count})`,
              value: row.median ?? 0,
            }))}
            labelWidth={116}
          />
        )}
      </Card>

      <OutreachPanel />
    </SimpleGrid>
  );
}
