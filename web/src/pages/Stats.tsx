import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Card,
  Divider,
  Group,
  Progress,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { api, type Bucket } from '../lib/api';
import { RankBars, TimeSeries } from '../components/charts';

/*
 * A real funnel is only the steps where each follows from the one before. The size of the
 * base does not belong in it: on a shared scale it simply flattens the other bars.
 */
const FUNNEL_STEPS: [key: string, label: string][] = [
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

/** Sending as a separate block: which template and which segment actually answer. */
function OutreachPanel() {
  const { data } = useQuery({ queryKey: ['outreachStats'], queryFn: () => api.outreachStats() });
  if (!data) return null;

  return (
    <Card style={{ gridColumn: '1 / -1' }}>
      <CardTitle title="Sending" hint="positive replies by template and by segment, sent count in brackets" />
      <SimpleGrid cols={{ base: 2, md: 3 }} mb="lg">
        <Box>
          <Text size="xs" c="dimmed">drafts</Text>
          <Text fw={600} className="tabular">{data.drafts}, {data.needsAttention} need attention</Text>
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

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {data.byTemplate.length > 0 && (
          <RankBars
            rows={data.byTemplate.map((row) => ({ label: `${row.key} (${row.sent})`, value: row.positive }))}
            labelWidth={180}
          />
        )}
        {data.byKind.length > 0 && (
          <RankBars
            rows={data.byKind.map((row) => ({ label: `${row.key} (${row.sent})`, value: row.positive }))}
            labelWidth={140}
          />
        )}
      </SimpleGrid>
    </Card>
  );
}

function BucketCard({ title, hint, rows }: { title: string; hint: string; rows: Bucket[] }) {
  return (
    <Card>
      <CardTitle title={title} hint={hint} />
      {rows.length === 0 ? (
        <Text c="dimmed">nothing yet</Text>
      ) : (
        <RankBars rows={rows.map((row) => ({ label: row.key, value: row.count }))} labelWidth={140} />
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

  const { reach } = data;

  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md" p="lg" style={{ alignItems: 'start' }}>
      <Card>
        <CardTitle title="Reach" hint="a lead with no way to reach it is just a name" />
        <Group gap="xl" mb="lg">
          <Hero value={String(reach.total)} hint="companies" />
          <Hero value={String(reach.withEmail)} hint="with an email" />
          <Hero value={String(reach.withNamedContact)} hint="with a named contact" />
        </Group>
        <Group gap="xl">
          <Hero value={String(reach.withPhone)} hint="with a phone" />
          <Hero value={String(reach.hiring)} hint="hiring developers" />
        </Group>
      </Card>

      <Card>
        <CardTitle title="Funnel" hint="each step as a share of the previous one" />
        <Group gap="xl" mb="lg">
          <Hero value={String(data.funnel.waitingReply ?? 0)} hint="awaiting reply" />
        </Group>
        <Divider mb="lg" />
        <Funnel funnel={data.funnel} />
      </Card>

      <BucketCard title="Segments" hint="studio, design, startup, smb, ecommerce..." rows={data.byKind} />
      <BucketCard title="Markets" hint="ua or intl, unknown means no country yet" rows={data.byMarket} />
      <BucketCard title="Sources" hint="where companies came from; one company can have several" rows={data.bySource} />
      <BucketCard title="Industries" hint="set by sources that know it" rows={data.byIndustry} />
      <BucketCard title="Countries" hint="top 15" rows={data.byCountry} />

      <Card>
        <CardTitle title="New companies per day" hint="last 30 days" />
        {data.perDay.length === 0 ? (
          <Text c="dimmed">nothing yet</Text>
        ) : (
          <TimeSeries rows={[...data.perDay].reverse()} unit="companies" />
        )}
      </Card>

      <OutreachPanel />
    </SimpleGrid>
  );
}
