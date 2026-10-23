import { lazy, Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Anchor,
  AppShell,
  Badge,
  Box,
  Button,
  Group,
  Kbd,
  NavLink,
  PasswordInput,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  Building2,
  ChartColumn,
  Database,
  FileText,
  Landmark,
  ListChecks,
  Mails,
  Radar,
  Rocket,
  Send,
  SlidersHorizontal,
  Sun,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { api, setToken } from './lib/api';
import { useRoute } from './lib/useRoute';
import { parse } from './lib/route';
import { entryState } from './lib/listMemory';
import { useHotkeys } from './lib/hotkeys';
import { RunMenu } from './components/RunMenu';
import { MonoLabel } from './components/ui';
import { CompaniesPage } from './pages/Companies';
import { CompanyPage } from './pages/Company';
import { OutreachPage } from './pages/Outreach';
import { SendingPage } from './pages/Sending';
import { OperationsPage } from './pages/Operations';
import { StudiosPage } from './pages/Studios';
import { StartupsPage } from './pages/Startups';
import { SourcesPage } from './pages/Sources';
import { TemplatesPage } from './pages/Templates';
import { RulesPage } from './pages/Rules';
import { TendersPage } from './pages/Tenders';
import { TodayPage } from './pages/Today';

// Stats pulls in recharts, so it loads as a separate chunk only once opened.
const StatsPage = lazy(() => import('./pages/Stats').then((module) => ({ default: module.StatsPage })));

interface Tab {
  id: string;
  label: string;
  icon: LucideIcon;
  hint: string;
  group: 'work' | 'base' | 'setup';
}

const TABS = [
  { id: 'today', label: 'Today', icon: Sun, group: 'work', hint: 'the fixed daily slice: a short list across segments, one company at a time' },
  { id: 'studios', label: 'Leads', icon: ListChecks, group: 'work', hint: 'every company above the score threshold, with filters' },
  { id: 'startups', label: 'Startups', icon: Rocket, group: 'work', hint: 'founders and small startups; the hiring chip shows who needs hands right now' },
  { id: 'tenders', label: 'Tenders', icon: Landmark, group: 'work', hint: 'explicit demand: open Prozorro tenders by deadline and funding news' },
  { id: 'sending', label: 'Outbox', icon: Send, group: 'work', hint: 'ready letter drafts, one click each' },
  { id: 'outreach', label: 'Outreach', icon: Mails, group: 'work', hint: 'who was written to, who replied, follow-ups' },
  { id: 'companies', label: 'Companies', icon: Building2, group: 'base', hint: 'the whole database as a directory: search, statuses, history' },
  { id: 'stats', label: 'Stats', icon: ChartColumn, group: 'base', hint: 'what is in the base: segments, markets, sources, reach' },
  { id: 'templates', label: 'Templates', icon: FileText, group: 'setup', hint: 'your letter texts' },
  { id: 'rules', label: 'Rules', icon: SlidersHorizontal, group: 'setup', hint: 'lead scoring: threshold and weights' },
  { id: 'sources', label: 'Sources', icon: Database, group: 'setup', hint: 'adapter health and manual runs' },
  { id: 'operations', label: 'Operations', icon: Wrench, group: 'setup', hint: 'everything that used to live in the CLI: collection, processing, checks' },
] as const satisfies readonly Tab[];

type TabId = (typeof TABS)[number]['id'];

const GROUPS: { id: Tab['group']; label: string }[] = [
  { id: 'work', label: 'work' },
  { id: 'base', label: 'base' },
  { id: 'setup', label: 'setup' },
];

/** Pages that manage their own scrolling: lists restore their scroll on return. */
const FULL_HEIGHT: TabId[] = ['today', 'studios', 'startups', 'templates', 'companies'];

function TokenGate() {
  const [value, setValue] = useState('');
  const save = () => {
    setToken(value.trim());
    window.location.reload();
  };

  return (
    <div className="dotted flex h-full items-center justify-center p-6">
      <Paper p="xl" w={400}>
        <Group gap="xs" mb="lg">
          <ThemeIcon color="ink" variant="filled" size={30}>
            <Radar size={16} />
          </ThemeIcon>
          <Title order={3}>Lead Radar</Title>
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

        <Button fullWidth mt="lg" variant="filled" disabled={!value.trim()} onClick={save}>
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
              background: `var(--mantine-color-${tone === 'ok' ? 'green' : 'yellow'}-6)`,
              flexShrink: 0,
            }}
          />
        )}
        <MonoLabel>{label}</MonoLabel>
      </Group>
      <Tooltip label={hint ?? value ?? label} multiline maw={260} withArrow>
        <Text size="xs" className="mono" c={color} truncate maw={130} ta="right">
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
  const tab: TabId = (TABS.find((item) => item.id === segments[0])?.id ?? 'today') as TabId;
  const setTab = (id: TabId) => go([id]);

  // `#/companies/acme.com` is the company page, the one company view every list opens.
  const companyKey = segments[0] === 'companies' ? (segments[1] ?? null) : null;

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
  const { data: sources } = useQuery({ queryKey: ['sources'], queryFn: () => api.sources() });
  // Mail is either connected or not. A silent third state would mean letters just
  // stopped going out, and the owner would find out a week later.
  const { data: gmail } = useQuery({
    queryKey: ['gmail-status'],
    queryFn: () => api.gmailStatus(),
    refetchInterval: 120_000,
    retry: false,
  });

  // Digits switch sections: hands stay on the keyboard while working the list.
  useHotkeys(
    useMemo(() => Object.fromEntries(TABS.slice(0, 9).map((item, index) => [String(index + 1), () => setTab(item.id)])), []),
  );

  // A deployed instance shows nothing without a token, so ask for it straight away.
  if (statsError instanceof Error && (statsError as Error & { status?: number }).status === 401) {
    return <TokenGate />;
  }

  const overdue = waiting?.length ?? 0;
  const broken =
    sources?.filter((row) => row.lastRun?.status === 'warn' || row.lastRun?.status === 'error').length ?? 0;

  const counters: Partial<Record<TabId, { value: number; color: string; hint: string }>> = {
    outreach: overdue > 0 ? { value: overdue, color: 'yellow', hint: 'no reply for 7+ days' } : undefined,
    sources: broken > 0 ? { value: broken, color: 'red', hint: 'sources with a warning or an error' } : undefined,
  };

  // On a company page the navigation keeps showing the list it was opened from.
  const origin = companyKey !== null ? parse(entryState().from ?? '')[0] : undefined;
  const current: TabId = (TABS.find((item) => item.id === origin)?.id ?? tab) as TabId;
  const fullHeight = companyKey !== null || FULL_HEIGHT.includes(tab);

  return (
    <AppShell
      navbar={{ width: 232, breakpoint: 0 }}
      padding={0}
      styles={{ main: { height: '100dvh', display: 'flex', flexDirection: 'column' } }}
    >
      <AppShell.Navbar style={{ borderRight: '1px solid var(--mantine-color-gray-2)' }}>
        <Group h={64} px="md" gap={10} wrap="nowrap" style={{ flexShrink: 0 }}>
          <ThemeIcon color="ink" variant="filled" size={30}>
            <Radar size={16} />
          </ThemeIcon>
          <Text className="display" fz={16}>
            Lead Radar
          </Text>
        </Group>

        <Stack gap={14} px="xs" pb="md" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {GROUPS.map((group) => (
            <Stack key={group.id} gap={2}>
              <Box px="sm" pb={4}>
                <MonoLabel>{group.label}</MonoLabel>
              </Box>
              {TABS.filter((item) => item.group === group.id).map((item) => {
                const counter = counters[item.id];
                const index = TABS.findIndex((other) => other.id === item.id);
                return (
                  <Tooltip key={item.id} label={item.hint} position="right" multiline maw={260} openDelay={600}>
                    <NavLink
                      active={current === item.id}
                      label={item.label}
                      variant="light"
                      onClick={() => setTab(item.id)}
                      leftSection={<item.icon size={16} strokeWidth={1.75} />}
                      styles={{
                        root: { borderRadius: 999, height: 34 },
                        label: { fontWeight: current === item.id ? 600 : 500, fontSize: 14 },
                      }}
                      rightSection={
                        counter ? (
                          <Tooltip label={counter.hint}>
                            <Badge size="sm" color={counter.color} className="mono">
                              {counter.value}
                            </Badge>
                          </Tooltip>
                        ) : index < 9 ? (
                          <Text className="mono" fz={11} c="gray.5">
                            {index + 1}
                          </Text>
                        ) : undefined
                      }
                    />
                  </Tooltip>
                );
              })}
            </Stack>
          ))}
        </Stack>

        {stats && (
          <Stack gap={8} p="md" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
            <RunMenu />
            <StatusRow label="model calls" value={String(stats.llmBudgetLeft)} hint="calls left for today" />
            {/*
              Which model provider is visible at a glance: Anthropic bills per token,
              Workers AI uses the quota of an already paid Cloudflare plan.
            */}
            <StatusRow
              label="model"
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
              action={gmail?.connected ? undefined : { label: 'connect', href: api.gmailConnectUrl() }}
            />
            <Group gap={6}>
              <Kbd>1</Kbd>
              <Text size="xs" c="dimmed">
                ..
              </Text>
              <Kbd>9</Kbd>
              <Text size="xs" c="dimmed">
                switch sections
              </Text>
            </Group>
          </Stack>
        )}
      </AppShell.Navbar>

      <AppShell.Main>
        {/* Keyed by section: a new section starts at the top, not at the scroll of the last one. */}
        <div
          key={companyKey === null ? tab : 'company'}
          className={fullHeight ? 'flex min-h-0 flex-1 flex-col' : 'min-h-0 flex-1 overflow-auto'}
        >
          {companyKey !== null ? (
            <CompanyPage key={companyKey} companyKey={companyKey} />
          ) : (
            <>
              {tab === 'today' && <TodayPage />}
              {tab === 'studios' && <StudiosPage />}
              {tab === 'startups' && <StartupsPage />}
              {tab === 'companies' && <CompaniesPage />}
              {tab === 'tenders' && <TendersPage />}
              {tab === 'sending' && <SendingPage />}
              {tab === 'outreach' && <OutreachPage />}
              {tab === 'sources' && <SourcesPage />}
              {tab === 'templates' && <TemplatesPage />}
              {tab === 'rules' && <RulesPage />}
              {tab === 'operations' && <OperationsPage />}
              {tab === 'stats' && (
                <Suspense
                  fallback={
                    <Text size="sm" c="dimmed" p="lg">
                      loading
                    </Text>
                  }
                >
                  <StatsPage />
                </Suspense>
              )}
            </>
          )}
        </div>
      </AppShell.Main>
    </AppShell>
  );
}
