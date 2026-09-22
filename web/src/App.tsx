import { lazy, Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Anchor,
  AppShell,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Kbd,
  NavLink,
  PasswordInput,
  Paper,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  BarChart3,
  Building2,
  CircleAlert,
  Inbox,
  FileText,
  MailPlus,
  Palette,
  Play,
  Radar,
  Rocket,
  Radio,
  Send,
  SlidersHorizontal,
} from 'lucide-react';
import { api, setToken } from './lib/api';
import { useRoute } from './lib/useRoute';
import { useHotkeys } from './lib/hotkeys';
import { RunMenu } from './components/RunMenu';
import { QueuePage } from './pages/Queue';
import { CompaniesPage } from './pages/Companies';
import { OutreachPage } from './pages/Outreach';
import { SendingPage } from './pages/Sending';
import { OperationsPage } from './pages/Operations';
import { StudiosPage } from './pages/Studios';
import { StartupsPage } from './pages/Startups';
import { SourcesPage } from './pages/Sources';
import { TemplatesPage } from './pages/Templates';
import { RulesPage } from './pages/Rules';

// Stats pulls in recharts, so it loads as a separate chunk only once opened.
const StatsPage = lazy(() => import('./pages/Stats').then((module) => ({ default: module.StatsPage })));

const TABS = [
  { id: 'queue', label: 'Queue', icon: Inbox, hint: 'ten cards a day, one decision each' },
  { id: 'studios', label: 'Studios', icon: Palette, hint: 'who to write to without a vacancy: everything from the catalogs above the score threshold' },
  { id: 'startups', label: 'Startups', icon: Rocket, hint: 'a cold letter to a startup: whether they hire shows in the number of vacancies found' },
  { id: 'companies', label: 'Companies', icon: Building2, hint: 'the whole database as a directory: search, statuses, history. Not the place to write from' },
  { id: 'sending', label: 'Outbox', icon: MailPlus, hint: 'ready letter drafts, one click each' },
  { id: 'outreach', label: 'Contacts', icon: Send, hint: 'who was written to and who replied' },
  { id: 'stats', label: 'Stats', icon: BarChart3, hint: 'stack, salaries, vacancy lifetime' },
  { id: 'sources', label: 'Sources', icon: Radio, hint: 'adapter status and manual runs' },
  { id: 'templates', label: 'Templates', icon: FileText, hint: 'your letter texts and resumes' },
  { id: 'rules', label: 'Rules', icon: SlidersHorizontal, hint: 'threshold, stop words and term weights' },
  { id: 'operations', label: 'Operations', icon: Play, hint: 'everything that used to live in the CLI: collection, processing, checks' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Two-pane pages manage their own scrolling, the rest scroll as a whole. */
const FULL_HEIGHT: TabId[] = ['queue', 'studios', 'startups', 'templates'];

function TokenGate() {
  const [value, setValue] = useState('');
  const save = () => {
    setToken(value.trim());
    window.location.reload();
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Paper p="xl" w={400} shadow="sm">
        <Group gap="xs" mb="lg">
          <ThemeIcon variant="light" size="md">
            <Radar size={16} />
          </ThemeIcon>
          <Title order={4}>Job Radar</Title>
        </Group>

        <PasswordInput
          data-autofocus
          label="Access token"
          description="The same value as the RADAR_TOKEN secret on the worker. Stored locally in the browser."
          placeholder="RADAR_TOKEN"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && value.trim() && save()}
        />

        <Button fullWidth mt="lg" disabled={!value.trim()} onClick={save}>
          Sign in
        </Button>
      </Paper>
    </div>
  );
}

/**
 * A status row in the sidebar. The value is truncated with the full text in a tooltip:
 * email addresses can be long, and untruncated they pushed the column apart and ran
 * into the next word.
 */
function StatusRow({
  label,
  value,
  hint,
  tone = 'plain',
  action,
}: {
  label: string;
  value?: string;
  hint?: string;
  tone?: 'plain' | 'ok' | 'warn';
  action?: { label: string; href: string };
}) {
  const color = tone === 'warn' ? 'yellow.8' : undefined;

  return (
    <Group justify="space-between" gap="xs" wrap="nowrap">
      <Group gap={6} wrap="nowrap">
        {tone !== 'plain' && (
          <Box
            w={6}
            h={6}
            style={{
              borderRadius: 999,
              background: `var(--mantine-color-${tone === 'ok' ? 'teal' : 'yellow'}-6)`,
              flexShrink: 0,
            }}
          />
        )}
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      </Group>
      <Tooltip label={hint ?? value ?? label} multiline maw={260} withArrow>
        <Text size="xs" className="tabular" c={color} truncate maw={130} ta="right">
          {action ? <Anchor href={action.href} size="xs" c={color}>{action.label}</Anchor> : value}
        </Text>
      </Tooltip>
    </Group>
  );
}

export function App() {
  /*
   * The section lives in the address, not in state. That makes going to a specific
   * company an ordinary link `#/companies/acme.com` from anywhere rather than a prop
   * through the whole tree, and the back button works as it should.
   */
  const { segments, go } = useRoute();
  const tab: TabId = (TABS.find((item) => item.id === segments[0])?.id ?? 'queue') as TabId;
  const setTab = (id: TabId) => go([id]);

  const { data: stats, error: statsError } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.stats(),
    refetchInterval: 30_000,
    retry: false,
  });
  const { data: waiting } = useQuery({
    queryKey: ['followups'],
    queryFn: () => api.outreach(7),
    refetchInterval: 60_000,
  });
  // The same keys as on the pages, so the navigation counters come from the cache.
  const { data: queue } = useQuery({ queryKey: ['queue'], queryFn: () => api.queue() });
  const { data: sources } = useQuery({ queryKey: ['sources'], queryFn: () => api.sources() });
  // Mail is either connected or not. A silent third state would mean letters just
  // stopped going out, and the owner would find out a week later.
  const { data: gmail } = useQuery({
    queryKey: ['gmail-status'],
    queryFn: () => api.gmailStatus(),
    refetchInterval: 120_000,
    retry: false,
  });

  // Digits switch sections: hands stay on the keyboard while working the queue.
  useHotkeys(
    useMemo(() => Object.fromEntries(TABS.map((item, index) => [String(index + 1), () => setTab(item.id)])), []),
  );

  // A deployed instance shows nothing without a token, so ask for it straight away.
  if (statsError instanceof Error && (statsError as Error & { status?: number }).status === 401) {
    return <TokenGate />;
  }

  const pending = queue?.cards.filter((card) => !card.decision).length ?? 0;
  const overdue = waiting?.length ?? 0;
  const broken =
    sources?.filter((row) => row.lastRun?.status === 'warn' || row.lastRun?.status === 'error').length ?? 0;

  const counters: Partial<Record<TabId, { value: number; color: string }>> = {
    queue: pending > 0 ? { value: pending, color: 'brand' } : undefined,
    outreach: overdue > 0 ? { value: overdue, color: 'yellow' } : undefined,
    sources: broken > 0 ? { value: broken, color: 'red' } : undefined,
  };

  const active = TABS.find((item) => item.id === tab)!;
  const fullHeight = FULL_HEIGHT.includes(tab);

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 232, breakpoint: 0 }}
      padding={0}
      styles={{ main: { height: '100dvh', display: 'flex', flexDirection: 'column' } }}
    >
      {/* The logo sits in the header above the navigation, otherwise the top left
          corner shows the page name instead of the application name. */}
      <AppShell.Header>
        <Group h="100%" gap={0} wrap="nowrap">
          <Group
            w={232}
            h="100%"
            px="lg"
            gap="xs"
            wrap="nowrap"
            style={{ borderRight: '1px solid var(--mantine-color-gray-2)' }}
          >
            <ThemeIcon variant="light" size="md">
              <Radar size={16} />
            </ThemeIcon>
            <Text fw={600}>Job Radar</Text>
          </Group>

          <Group h="100%" px="lg" gap="lg" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <Tooltip label={active.hint} position="bottom-start">
              <Title order={3} style={{ whiteSpace: 'nowrap' }}>
                {active.label}
              </Title>
            </Tooltip>

            <Group gap="xl" ml="auto" wrap="nowrap" visibleFrom="md">
              {stats && (
                <>
                  <HeaderStat label="open vacancies" value={stats.vacancies.open} />
                  <HeaderStat label="above threshold" value={stats.vacancies.aboveThreshold} />
                  <HeaderStat label="contacted" value={stats.funnel.contacted ?? 0} />
                  {overdue > 0 && <HeaderStat label="no reply 7+ days" value={overdue} color="yellow.8" />}
                </>
              )}
            </Group>

            <RunMenu />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar>
        <Stack gap={2} p="xs" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {TABS.map((item) => {
            const counter = counters[item.id];
            return (
              <NavLink
                key={item.id}
                active={tab === item.id}
                label={item.label}
                variant="light"
                onClick={() => setTab(item.id)}
                leftSection={<item.icon size={16} />}
                rightSection={
                  counter && (
                    <Badge size="sm" color={counter.color} variant={counter.color === 'brand' ? 'filled' : 'light'}>
                      {counter.value}
                    </Badge>
                  )
                }
              />
            );
          })}
        </Stack>

        {stats && (
          <>
            <Divider />
            <Stack gap={6} p="md">
              {/* The digit hint is shown once here rather than as a badge on every row. */}
              <Group gap={6} mb={2}>
                <Kbd size="xs">1</Kbd>
                <Text size="xs" c="dimmed">
                  ..
                </Text>
                <Kbd size="xs">9</Kbd>
                <Text size="xs" c="dimmed">
                  switch sections
                </Text>
              </Group>
              <StatusRow label="score threshold" value={String(stats.threshold)} />
              <StatusRow
                label="model calls"
                value={String(stats.llmBudgetLeft)}
                hint="calls left for today"
              />
              {/*
                Who classifies is visible at a glance: Anthropic bills per token,
                Workers AI uses the quota of an already paid Cloudflare plan.
              */}
              <StatusRow
                label="classifier"
                value={stats.llmProvider === 'workers-ai' ? 'Workers AI' : 'Anthropic'}
                hint={stats.llmModel}
              />
              {/*
                Mail has three states, not two: connected, not connected, and
                connected with a broken sender address. The third is the nastiest,
                because everything looks fine while letters go out with an unreadable From.
              */}
              <StatusRow
                label="mail"
                hint={gmail?.hint ?? gmail?.email ?? 'Gmail for sending'}
                tone={gmail?.connected ? (gmail.emailValid ? 'ok' : 'warn') : 'warn'}
                value={
                  gmail?.connected
                    ? gmail.emailValid
                      ? (gmail.email ?? 'connected')
                      : 'check the address'
                    : undefined
                }
                action={
                  gmail?.connected ? undefined : { label: 'connect', href: api.gmailConnectUrl() }
                }
              />
              {stats.vacancies.needsReview > 0 && (
                <Group gap={6} c="yellow.8">
                  <CircleAlert size={14} />
                  <Text size="xs">for manual review {stats.vacancies.needsReview}</Text>
                </Group>
              )}
            </Stack>
          </>
        )}
      </AppShell.Navbar>

      <AppShell.Main>
        <div className={fullHeight ? 'min-h-0 flex-1' : 'min-h-0 flex-1 overflow-auto'}>
          {tab === 'queue' && <QueuePage />}
          {tab === 'studios' && <StudiosPage />}
          {tab === 'startups' && <StartupsPage />}
          {tab === 'companies' && <CompaniesPage />}
          {tab === 'sending' && <SendingPage />}
          {tab === 'outreach' && <OutreachPage />}
          {tab === 'sources' && <SourcesPage />}
          {tab === 'templates' && <TemplatesPage />}
          {tab === 'rules' && <RulesPage />}
          {tab === 'operations' && <OperationsPage />}
          {tab === 'stats' && (
            <Suspense fallback={<Skeleton h={320} m="lg" />}>
              <StatsPage />
            </Suspense>
          )}
        </div>
      </AppShell.Main>
    </AppShell>
  );
}

function HeaderStat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={500} style={{ letterSpacing: '0.04em' }}>
        {label}
      </Text>
      {/* The value is read from a distance and the label only qualifies it, hence the big size gap. */}
      <Text fz={16} lh={1.3} fw={600} c={color} className="tabular">
        {value}
      </Text>
    </div>
  );
}
