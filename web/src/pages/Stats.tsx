import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Box, Group, Paper, Progress, SimpleGrid, Stack, Text } from '@mantine/core';
import {
  CalendarDays,
  ChartColumn,
  Database,
  Filter,
  Globe,
  MapPin,
  Send,
  Shapes,
  Store,
  type LucideIcon,
} from 'lucide-react';
import { MonoLabel, PageHeader, SectionHeader, StatStrip } from '../components/ui';
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

/** A stats card: an icon header and one line on what it counts. */
function StatCard({
  icon,
  title,
  hint,
  color,
  span,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  color?: string;
  span?: boolean;
  children: ReactNode;
}) {
  return (
    <Paper p="md" style={span ? { gridColumn: '1 / -1' } : undefined}>
      <SectionHeader icon={icon} title={title} color={color} />
      <Text size="sm" c="gray.6" mt={-4} mb="md">
        {hint}
      </Text>
      {children}
    </Paper>
  );
}

/** A small figure inside a card: mono caption, number under it. */
function Figure({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <div>
      <MonoLabel>{label}</MonoLabel>
      <Text className="display tabular" fz={20} mt={2} c={color}>
        {value}
      </Text>
    </div>
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
              <Text size="sm" fw={600} className="mono" ml="auto">
                {value}
              </Text>
              <Text size="xs" c="dimmed" w={44} ta="right" className="mono">
                {share === null ? '' : `${share} %`}
              </Text>
            </Group>
            <Progress value={(value / top) * 100} size={6} color="brand" />
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
    <StatCard
      span
      icon={Send}
      title="Sending"
      color="green"
      hint="Positive replies by template and by segment, sent count in brackets."
    >
      <SimpleGrid cols={{ base: 2, md: 3 }} mb="lg">
        <Figure label="drafts" value={`${data.drafts}, ${data.needsAttention} stuck`} />
        <Figure
          label="bounces over 50 letters"
          value={`${Math.round(data.bounceRate * 100)} %`}
          color={data.bounceRate > 0.03 ? 'red' : undefined}
        />
        <Figure
          label="median time to reply"
          value={data.medianReplyHours === null ? 'none yet' : `${data.medianReplyHours.toFixed(1)} h`}
        />
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
    </StatCard>
  );
}

function BucketCard({ icon, title, hint, rows }: { icon: LucideIcon; title: string; hint: string; rows: Bucket[] }) {
  return (
    <StatCard icon={icon} title={title} hint={hint}>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          nothing yet
        </Text>
      ) : (
        <RankBars rows={rows.map((row) => ({ label: row.key, value: row.count }))} labelWidth={140} />
      )}
    </StatCard>
  );
}

export function StatsPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['fullStats'], queryFn: () => api.fullStats() });

  const header = (
    <PageHeader icon={ChartColumn} title="Stats" description="What is in the base: segments, markets, sources, reach." />
  );

  if (error || isLoading || !data) {
    return (
      <>
        {header}
        {error ? (
          <Alert color="red" m="lg" title="Could not read the statistics">
            {error instanceof Error ? error.message : String(error)}
          </Alert>
        ) : (
          <Text size="sm" c="dimmed" p="lg">
            loading
          </Text>
        )}
      </>
    );
  }

  const { reach } = data;

  return (
    <>
      {header}
      <Stack gap="md" p="lg">
        {/* Reach first: a lead with no way to reach it is just a name. */}
        <StatStrip
          items={[
            { label: 'companies', value: reach.total },
            { label: 'with an email', value: reach.withEmail },
            { label: 'named contact', value: reach.withNamedContact },
            { label: 'with a phone', value: reach.withPhone },
            { label: 'hiring devs', value: reach.hiring, color: 'green.7' },
            { label: 'awaiting reply', value: data.funnel.waitingReply ?? 0 },
          ]}
        />

        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md" style={{ alignItems: 'start' }}>
          <StatCard icon={Filter} title="Funnel" color="brand" hint="Each step as a share of the previous one.">
            <Funnel funnel={data.funnel} />
          </StatCard>

          <StatCard icon={CalendarDays} title="New companies per day" hint="Last 30 days.">
            {data.perDay.length === 0 ? (
              <Text size="sm" c="dimmed">
                nothing yet
              </Text>
            ) : (
              <TimeSeries rows={[...data.perDay].reverse()} unit="companies" />
            )}
          </StatCard>

          <BucketCard icon={Shapes} title="Segments" hint="studio, design, startup, smb, ecommerce..." rows={data.byKind} />
          <BucketCard icon={Globe} title="Markets" hint="ua or intl, unknown means no country yet." rows={data.byMarket} />
          <BucketCard icon={Database} title="Sources" hint="Where companies came from; one company can have several." rows={data.bySource} />
          <BucketCard icon={Store} title="Industries" hint="Set by sources that know it, or by the model." rows={data.byIndustry} />
          <BucketCard icon={MapPin} title="Countries" hint="Top 15." rows={data.byCountry} />

          <OutreachPanel />
        </SimpleGrid>
      </Stack>
    </>
  );
}
