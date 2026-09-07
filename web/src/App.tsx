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

// Статистика тягне recharts, тому вантажиться окремим чанком лише коли її відкрили.
const StatsPage = lazy(() => import('./pages/Stats').then((module) => ({ default: module.StatsPage })));

const TABS = [
  { id: 'queue', label: 'Черга', icon: Inbox, hint: 'десять карток на день, по одному рішенню на кожну' },
  { id: 'studios', label: 'Студії', icon: Palette, hint: 'кому писати без вакансії: усе з каталогів, що пройшло поріг рахунку' },
  { id: 'startups', label: 'Стартапи', icon: Rocket, hint: 'холодний лист стартапу: чи наймають видно з кількості знайдених вакансій' },
  { id: 'companies', label: 'Компанії', icon: Building2, hint: 'уся база як довідник: пошук, статуси, історія. Писати звідси не треба' },
  { id: 'sending', label: 'До відправки', icon: MailPlus, hint: 'готові чернетки листів, по одному натисканню на кожен' },
  { id: 'outreach', label: 'Контакти', icon: Send, hint: 'кому писали і хто відповів' },
  { id: 'stats', label: 'Статистика', icon: BarChart3, hint: 'стек, вилки, час життя вакансій' },
  { id: 'sources', label: 'Джерела', icon: Radio, hint: 'стан адаптерів і ручний запуск' },
  { id: 'templates', label: 'Шаблони', icon: FileText, hint: 'твої тексти листів і резюме' },
  { id: 'rules', label: 'Правила', icon: SlidersHorizontal, hint: 'поріг, стоп-слова і ваги термінів' },
  { id: 'operations', label: 'Операції', icon: Play, hint: 'усе, що раніше жило в CLI: збір, обробка, перевірки' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Сторінки з двома панелями керують скролом самі, решта скролиться цілком. */
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
          label="Токен доступу"
          description="Той самий, що заданий секретом RADAR_TOKEN у воркері. Зберігається локально в браузері."
          placeholder="RADAR_TOKEN"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && value.trim() && save()}
        />

        <Button fullWidth mt="lg" disabled={!value.trim()} onClick={save}>
          Увійти
        </Button>
      </Paper>
    </div>
  );
}

/**
 * Рядок стану в бічній колонці. Значення обрізається, повний текст у підказці:
 * пошта буває довгою, і без обрізання вона розсовувала колонку і лізла в друге
 * слово, як на скріні з адресою.
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
  const [tab, setTab] = useState<TabId>('queue');

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
  // Ті самі ключі, що й на сторінках, тому лічильники в навігації беруться з кешу.
  const { data: queue } = useQuery({ queryKey: ['queue'], queryFn: () => api.queue() });
  const { data: sources } = useQuery({ queryKey: ['sources'], queryFn: () => api.sources() });
  // Пошта або підключена, або ні. Мовчазний третій стан означав би, що листи
  // просто перестали йти, а власник дізнається про це через тиждень.
  const { data: gmail } = useQuery({
    queryKey: ['gmail-status'],
    queryFn: () => api.gmailStatus(),
    refetchInterval: 120_000,
    retry: false,
  });

  // Цифри 1..6 перемикають розділи: руки лишаються на клавіатурі під час розбору черги.
  useHotkeys(
    useMemo(() => Object.fromEntries(TABS.map((item, index) => [String(index + 1), () => setTab(item.id)])), []),
  );

  // Задеплоєна версія без токена не покаже нічого, тому питаємо його одразу.
  if (statsError instanceof Error && /токен/i.test(statsError.message)) return <TokenGate />;

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
      {/* Логотип живе в шапці над навігацією, інакше в лівому верхньому куті
          виявляється назва сторінки, а не назва застосунку. */}
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
                  <HeaderStat label="відкритих вакансій" value={stats.vacancies.open} />
                  <HeaderStat label="вище порогу" value={stats.vacancies.aboveThreshold} />
                  <HeaderStat label="написано" value={stats.funnel.contacted ?? 0} />
                  {overdue > 0 && <HeaderStat label="без відповіді 7+ дн" value={overdue} color="yellow.8" />}
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
              {/* Підказку про цифри показуємо один раз тут, а не бейджем у кожному рядку. */}
              <Group gap={6} mb={2}>
                <Kbd size="xs">1</Kbd>
                <Text size="xs" c="dimmed">
                  ..
                </Text>
                <Kbd size="xs">9</Kbd>
                <Text size="xs" c="dimmed">
                  перемикають розділи
                </Text>
              </Group>
              <StatusRow label="поріг рахунку" value={String(stats.threshold)} />
              <StatusRow
                label="виклики моделі"
                value={String(stats.llmBudgetLeft)}
                hint="скільки викликів лишилось сьогодні"
              />
              {/*
                Хто класифікує, видно одразу: Anthropic це рахунок за токени,
                Workers AI це квота вже оплаченого плану Cloudflare.
              */}
              <StatusRow
                label="класифікує"
                value={stats.llmProvider === 'workers-ai' ? 'Workers AI' : 'Anthropic'}
                hint={stats.llmModel}
              />
              {/*
                Пошта має три стани, а не два: підключена, не підключена і
                підключена з поламаною адресою відправника. Третій найпідліший,
                бо все виглядає робочим, а лист іде з нечитабельним From.
              */}
              <StatusRow
                label="пошта"
                hint={gmail?.hint ?? gmail?.email ?? 'Gmail для розсилки'}
                tone={gmail?.connected ? (gmail.emailValid ? 'ok' : 'warn') : 'warn'}
                value={
                  gmail?.connected
                    ? gmail.emailValid
                      ? (gmail.email ?? 'підключена')
                      : 'перевір адресу'
                    : undefined
                }
                action={
                  gmail?.connected ? undefined : { label: 'підключити', href: api.gmailConnectUrl() }
                }
              />
              {stats.vacancies.needsReview > 0 && (
                <Group gap={6} c="yellow.8">
                  <CircleAlert size={14} />
                  <Text size="xs">на ручний перегляд {stats.vacancies.needsReview}</Text>
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
      {/* Значення читається з відстані, підпис лише уточнює, тому різниця в розмірі велика. */}
      <Text fz={16} lh={1.3} fw={600} c={color} className="tabular">
        {value}
      </Text>
    </div>
  );
}
