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

/** Стек власника. Потрібен, щоб у топі технологій було видно, чого він не знає. */
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
 * Справжня воронка це лише ті кроки, де кожен випливає з попереднього.
 * Кількість компаній і відкритих вакансій до неї не належать: це розмір бази,
 * і на спільній шкалі вони просто розчавлюють решту стовпчиків.
 */
const FUNNEL_STEPS: [key: string, label: string][] = [
  ['shown', 'показано у черзі'],
  ['decided', 'розібрано'],
  ['contacted', 'написано'],
  ['replied', 'відповіли'],
  ['positive', 'позитивних'],
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

export function StatsPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['fullStats'], queryFn: () => api.fullStats() });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Не вдалось прочитати статистику">
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
        <CardTitle title="Воронка" hint="кожен крок як частка від попереднього" />
        <Group gap="xl" mb="lg">
          <Hero value={String(data.funnel.companies ?? 0)} hint="компаній у базі" />
          <Hero value={String(data.funnel.vacanciesOpen ?? 0)} hint="відкритих вакансій" />
          <Hero value={String(data.funnel.waitingReply ?? 0)} hint="чекають відповіді" />
        </Group>
        <Divider mb="lg" />
        <Funnel funnel={data.funnel} />
      </Card>

      <Card>
        <CardTitle title="Нові вакансії по днях" hint="скільки нових блоків приносив діф щодня" />
        {data.perDay.length === 0 ? (
          <Text c="dimmed">поки що порожньо</Text>
        ) : (
          <TimeSeries rows={[...data.perDay].reverse()} unit="шт" />
        )}
      </Card>

      <Card>
        <CardTitle title="Топ технологій" hint="за 90 днів, у класифікованих вакансіях" />
        {data.topTech.length === 0 ? (
          <Text c="dimmed">даних ще немає, потрібна класифікація</Text>
        ) : (
          <>
            {/* Легенда обовʼязкова: колір тут щось означає, а не просто прикрашає. */}
            <Group gap="lg" mb="md">
              <Group gap={6}>
                <Box w={10} h={10} bg="#2a78d6" style={{ borderRadius: 2 }} />
                <Text size="sm" c="dimmed">
                  у моєму стеку
                </Text>
              </Group>
              <Group gap={6}>
                <Box w={10} h={10} bg="#b7d3f6" style={{ borderRadius: 2 }} />
                <Text size="sm" c="dimmed">
                  прогалина
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
        <CardTitle title="Час життя вакансій" hint="різниця між першою і останньою зустріччю" />
        <Group gap="xl">
          <Hero
            value={data.lifetimes.medianDays?.toFixed(1) ?? 'немає'}
            unit={data.lifetimes.medianDays !== null ? 'дн' : undefined}
            hint={`медіана по ${data.lifetimes.closedCount} закритих`}
          />
          <Hero value={String(data.lifetimes.ghosts.length)} hint="підозр на ghost job, понад 120 днів" />
        </Group>

        {data.lifetimes.ghosts.length > 0 && (
          <>
            <Divider my="lg" />
            <ScrollArea.Autosize mah={200}>
              <Stack gap={6}>
                {data.lifetimes.ghosts.map((ghost) => (
                  <Group key={ghost.id} gap="sm" wrap="nowrap">
                    <Badge color="yellow" leftSection={<TriangleAlert size={11} />}>
                      {ghost.days} дн
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
        <CardTitle title="Медіанна вилка за грейдом" hint="лише вакансії, де вилка вказана" />
        {data.salariesBySeniority.length === 0 ? (
          <Text c="dimmed">вилок у вакансіях ще немає</Text>
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
        <CardTitle title="Медіанна вилка за країною" hint="лише вакансії, де вилка вказана" />
        {data.salariesByCountry.length === 0 ? (
          <Text c="dimmed">вилок у вакансіях ще немає</Text>
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
    </SimpleGrid>
  );
}
