import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Play, Square } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Operations: what the CLI does, but with buttons.
 *
 * Half the work used to live only in the terminal and did not exist in production at
 * all: the laptop with the repository is not always at hand, while the radar lives on
 * the worker. Here every button is one POST, and the response is shown as is, without
 * retelling it in other words.
 *
 * Deliberately missing: migrations, file imports, database export and connecting mail.
 * Those are either one-off tasks or need files on disk, which a browser button cannot do.
 */

type Field = { name: string; label: string; kind: 'number' | 'select'; def: number | string; options?: string[] };

interface Operation {
  id: string;
  label: string;
  hint: string;
  path: string;
  /** Long operations warn about themselves: the worker has a per-request time limit. */
  slow?: boolean;
  fields?: Field[];
  /**
   * The operation runs in batches: one request processes `size` records, repeated until
   * the requested count is reached or the server runs out of candidates. Otherwise a
   * hundred companies in one request do not finish in time, and the worker kills it with
   * a 503 having done nothing.
   */
  batch?: { field: string; size: number };
  /** A pass over the Getro networks: one network is one request. */
  networks?: boolean;
}

interface OperationGroup {
  title: string;
  note: string;
  items: Operation[];
}

const GROUPS: OperationGroup[] = [
  {
    title: 'Collection',
    note: 'where companies and vacancies come from',
    items: [
      {
        id: 'catalog-yc',
        label: 'YC catalog',
        hint: 'startups hiring right now. Gives no vacancies, gives entry points for discovery',
        path: '/catalogs/yc/run',
        slow: true,
      },
      {
        id: 'hn-hiring',
        label: 'HN: Who is hiring',
        hint: 'the monthly Hacker News thread: a couple of hundred startups with a direct founder contact',
        path: '/sources/hn%3Ahiring/run',
        slow: true,
      },
      {
        id: 'getro',
        label: 'Accelerator boards',
        hint: 'Techstars, Accel, Underscore and the other Getro networks',
        path: '/sources/getro/run',
        slow: true,
        networks: true,
      },
      {
        id: 'catalog-dou',
        label: 'DOU catalog',
        hint: 'companies from jobs.dou.ua by filters',
        path: '/catalogs/dou/run',
        slow: true,
        fields: [{ name: 'limit', label: 'how many', kind: 'number', def: 40 }],
      },
      {
        id: 'catalog-awwwards',
        label: 'Awwwards catalog',
        hint: 'design studios from the awards directory',
        path: '/catalogs/awwwards/run',
        slow: true,
      },
      {
        id: 'discover',
        label: 'Find career pages',
        hint: 'crawls companies without an ATS: /careers, /jobs, the footer. Once found, never searched again',
        path: '/discover',
        slow: true,
        batch: { field: 'limit', size: 5 },
        fields: [{ name: 'limit', label: 'companies', kind: 'number', def: 40 }],
      },
      {
        id: 'enrich',
        label: 'Collect contacts and stack',
        hint: '/team and /about pages: names, roles, email, signs the site is alive',
        path: '/enrich',
        slow: true,
        batch: { field: 'limit', size: 5 },
        fields: [{ name: 'limit', label: 'companies', kind: 'number', def: 25 }],
      },
    ],
  },
  {
    title: 'Processing',
    note: 'what to do with what is already collected',
    items: [
      {
        id: 'classify',
        label: 'Catch up on classification',
        hint: 'vacancies without a model opinion, highest score first. Spends the daily budget',
        path: '/classify/pending',
        slow: true,
        fields: [{ name: 'limit', label: 'vacancies', kind: 'number', def: 50 }],
      },
      {
        id: 'recalc',
        label: 'Rescore',
        hint: 'after changing the rules. No model calls, plain arithmetic',
        path: '/score/recalc',
      },
      {
        id: 'top-up',
        label: 'Top up the queue',
        hint: 'add cards to today\'s slice up to the daily limit',
        path: '/queue/top-up',
      },
      {
        id: 'kinds',
        label: 'Assign company kinds',
        hint: 'studio, design, startup, product, outstaff. From tags and description',
        path: '/maintenance/kinds',
      },
      {
        id: 'backfill',
        label: 'Split catalog fields',
        hint: 'hourly rate, minimum project and founding year from tags into columns',
        path: '/maintenance/backfill-catalog',
      },
      {
        id: 'fix-detail',
        label: 'Re-read vacancy descriptions',
        hint: 'for Next.js boards where the site menu was stored instead of the description',
        path: '/maintenance/fix-detail',
        slow: true,
        fields: [
          { name: 'limit', label: 'pages', kind: 'number', def: 25 },
          { name: 'source', label: 'source', kind: 'select', def: 'getro', options: ['getro', 'djinni', 'dou:vacancies'] },
        ],
      },
      {
        id: 'embed',
        label: 'Compute vectors',
        hint: 'for finding similar companies, through Workers AI',
        path: '/embed',
        slow: true,
        fields: [{ name: 'limit', label: 'companies', kind: 'number', def: 50 }],
      },
    ],
  },
  {
    title: 'Sending',
    note: 'letters are prepared here and sent from the Outbox page',
    items: [
      {
        id: 'outreach-seed',
        label: 'Seed sending templates',
        hint: 'adds missing skeletons: four cases in two languages',
        path: '/outreach/seed',
      },
      {
        id: 'templates-seed',
        label: 'Seed starter templates',
        hint: 'the ones the list started with. Deleted ones do not come back on their own',
        path: '/templates/seed',
      },
      {
        id: 'outreach-prepare',
        label: 'Prepare drafts',
        hint: 'picks template, language and contact. Sends nothing',
        path: '/outreach/prepare',
        slow: true,
        fields: [{ name: 'limit', label: 'companies', kind: 'number', def: 20 }],
      },
      {
        id: 'outreach-followups',
        label: 'Prepare follow-ups',
        hint: 'who is due a second letter: 7-9 days without a reply, same thread',
        path: '/outreach/followups',
      },
      {
        id: 'outreach-replies',
        label: 'Check replies',
        hint: 'walks the threads: replies, auto-replies, bounces. Cron does this hourly',
        path: '/outreach/replies',
        slow: true,
      },
    ],
  },
  {
    title: 'Checks',
    note: 'when something goes quiet, start here',
    items: [
      {
        id: 'llm-ping',
        label: 'Check the model',
        hint: 'a live call: key, provider, AI Gateway. Costs a few tokens',
        path: '/llm/ping',
      },
      {
        id: 'gmail-test',
        label: 'Test letter to yourself',
        hint: 'the subject has Cyrillic on purpose, that is where encoding breaks',
        path: '/gmail/test',
      },
      {
        id: 'notify-digest',
        label: 'Telegram: digest',
        hint: 'the same message that arrives at 10:00',
        path: '/notify/digest',
      },
      {
        id: 'notify-outreach',
        label: 'Telegram: sending',
        hint: 'how many drafts are ready and how many follow-ups are due',
        path: '/notify/outreach',
      },
      {
        id: 'notify-broken',
        label: 'Telegram: broken sources',
        hint: 'adapters that returned zero or an error',
        path: '/notify/broken',
      },
    ],
  },
];

/** Keys that are almost always in a response. Shown in plain words. */
const LABELS: Record<string, string> = {
  itemsFound: 'found',
  itemsNew: 'new',
  created: 'created',
  updated: 'updated',
  seen: 'seen',
  classified: 'classified',
  skipped: 'skipped',
  stopped: 'filtered by stop words',
  needsReview: 'for manual review',
  detailed: 'descriptions loaded',
  emptyDetail: 'pages without description',
  checked: 'checked',
  fixed: 'fixed',
  unchanged: 'unchanged',
  stillEmpty: 'still no description',
  candidates: 'candidates',
  drafts: 'drafts',
  due: 'due',
  replies: 'replies',
  bounces: 'bounces',
  added: 'added',
  total: 'total',
  taken: 'taken',
  sent: 'sent',
  ok: 'working',
  remaining: 'left in the queue',
  batches: 'batches',
};

function Result({ value }: { value: Record<string, unknown> }) {
  const rows = Object.entries(value).filter(
    ([, item]) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
  );

  if (rows.length === 0) return <Code block>{JSON.stringify(value, null, 2).slice(0, 600)}</Code>;

  return (
    <Group gap={6} mt={6}>
      {rows.map(([key, item]) => (
        <Badge key={key} variant="light" color={key === 'error' ? 'red' : 'gray'}>
          {(LABELS[key] ?? key) + ': ' + String(item).slice(0, 80)}
        </Badge>
      ))}
    </Group>
  );
}

type Totals = Record<string, unknown>;

/**
 * Combines the totals of several batches. Numbers add up, everything else comes from the
 * last response: otherwise after ten requests the screen would show only the last five
 * companies, as if the rest of the pass never happened.
 */
function merge(into: Totals, part: Record<string, unknown>): Totals {
  const out: Totals = { ...into };
  for (const [key, value] of Object.entries(part)) {
    if (key === 'remaining' || key === 'next' || key === 'slug') out[key] = value;
    else if (typeof value === 'number') out[key] = ((out[key] as number) ?? 0) + value;
    else if (Array.isArray(value)) out[key] = [...((out[key] as unknown[]) ?? []), ...value];
    else out[key] = value;
  }
  return out;
}

/**
 * In batches up to the requested count. Stops early when the server says there are no
 * candidates left: without that the loop would keep sending empty requests to the end.
 */
async function runInBatches(
  operation: Operation,
  values: Record<string, number | string>,
  report: (text: string) => void,
  stop: { current: boolean },
): Promise<Totals> {
  const field = operation.batch!.field;
  const size = operation.batch!.size;
  const total = Math.max(1, Number(values[field]) || size);

  let done = 0;
  let totals: Totals = { batches: 0 };

  while (done < total && !stop.current) {
    const take = Math.min(size, total - done);
    report(`batch ${(totals.batches as number) + 1}, processed ${done} of ${total}`);

    const data = await api.run(operation.path, { ...values, [field]: take });
    totals = merge(totals, data);
    totals.batches = ((totals.batches as number) ?? 0) + 1;

    const processed = Number(data.checked ?? data.itemsFound ?? take) || 0;
    done += processed;

    // Zero processed means nobody is left to take, and the next batch would be the same.
    if (processed === 0 || Number(data.remaining ?? 0) === 0) break;
  }

  totals.processed = done;
  return totals;
}

/**
 * A pass over the Getro networks: one network is one request. The server provides the
 * cursor, so the order and contents of the list live in one place instead of being
 * duplicated in the front end.
 */
async function runByNetworks(
  operation: Operation,
  report: (text: string) => void,
  stop: { current: boolean },
): Promise<Totals> {
  const { networks } = await api.getroNetworks();
  let totals: Totals = { batches: 0 };

  for (const [index, network] of networks.entries()) {
    if (stop.current) break;
    report(`network ${network}, ${index + 1} of ${networks.length}`);

    const data = await api.run(operation.path, { slug: network });
    totals = merge(totals, data);
    totals.batches = ((totals.batches as number) ?? 0) + 1;
  }

  return totals;
}

function OperationCard({ operation }: { operation: Operation }) {
  const client = useQueryClient();
  const [values, setValues] = useState<Record<string, number | string>>(
    Object.fromEntries((operation.fields ?? []).map((field) => [field.name, field.def])),
  );
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const [progress, setProgress] = useState<string | null>(null);
  const stop = useRef(false);

  const run = useMutation({
    mutationFn: async () => {
      stop.current = false;

      if (operation.networks) return runByNetworks(operation, setProgress, stop);
      if (operation.batch) return runInBatches(operation, values, setProgress, stop);

      return api.run(operation.path, values);
    },
    onSuccess: (data) => {
      setProgress(null);
      setResult(data);
      notifications.show({ color: 'green', title: operation.label, message: 'done' });
      // After any operation the numbers in the interface are stale, so everything is refetched.
      void client.invalidateQueries();
    },
    onError: (error: Error) => {
      setProgress(null);
      setResult({ error: error.message });
      notifications.show({ color: 'red', title: operation.label, message: error.message });
    },
  });

  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" align="start" wrap="nowrap" gap="sm">
        <div style={{ minWidth: 0 }}>
          <Group gap={6}>
            <Text size="sm" fw={500}>
              {operation.label}
            </Text>
            {operation.slow && (
              <Tooltip label="long operation, the worker has a per-request time limit">
                <Badge size="xs" color="yellow" variant="light">
                  long
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {operation.hint}
          </Text>
        </div>

        <Group gap="xs" wrap="nowrap">
          {(operation.fields ?? []).map((field) =>
            field.kind === 'number' ? (
              <NumberInput
                key={field.name}
                size="xs"
                w={92}
                min={1}
                label={field.label}
                value={values[field.name] as number}
                onChange={(next) => setValues({ ...values, [field.name]: Number(next) || 1 })}
              />
            ) : (
              <Select
                key={field.name}
                size="xs"
                w={130}
                label={field.label}
                data={field.options ?? []}
                value={String(values[field.name])}
                onChange={(next) => next && setValues({ ...values, [field.name]: next })}
                allowDeselect={false}
              />
            ),
          )}
          <Button
            size="xs"
            mt={operation.fields?.length ? 22 : 0}
            leftSection={<Play size={14} />}
            loading={run.isPending}
            onClick={() => run.mutate()}
          >
            Run
          </Button>

          {/* Batches take a while, and stopping them must be possible without closing the tab. */}
          {run.isPending && (operation.batch || operation.networks) && (
            <Button
              size="xs"
              mt={operation.fields?.length ? 22 : 0}
              variant="default"
              leftSection={<Square size={14} />}
              onClick={() => {
                stop.current = true;
                setProgress('stopping after the current batch');
              }}
            >
              Stop
            </Button>
          )}
        </Group>
      </Group>

      {progress && (
        <Text size="xs" c="dimmed" mt={6}>
          {progress}
        </Text>
      )}

      {result && <Result value={result} />}
    </Paper>
  );
}

export function OperationsPage() {
  const { data: gmail } = useQuery({ queryKey: ['gmail-status'], queryFn: () => api.gmailStatus() });

  return (
    <ScrollArea.Autosize mah="calc(100dvh - 60px)">
      <Stack gap="lg" p="lg">
        {gmail && gmail.provider === 'gmail' && !gmail.connected && (
          <Alert color="yellow" title="Mail is not connected">
            Sending operations will run, but there is nothing to send a letter with.
          </Alert>
        )}

        {/*
          A silent difference between providers. Resend can only send: replies land in a
          mailbox the radar cannot access, and "nobody replied" on the Contacts page would
          only mean that nobody looked.
        */}
        {gmail && !gmail.readsReplies && (
          <Alert color="yellow" title={`Sending through ${gmail.provider}, replies are not tracked`}>
            This provider only sends letters. Checking replies and bounces reads the mailbox,
            and there is no access to it here, so replies have to be marked by hand on the
            Contacts page. For replies to be noticed automatically, use MAIL_PROVIDER=gmail.
          </Alert>
        )}

        {gmail && gmail.provider !== 'gmail' && !gmail.providers.find((row) => row.id === gmail.provider)?.connected && (
          <Alert color="red" title={`${gmail.provider} is not configured`}>
            {gmail.providers.find((row) => row.id === gmail.provider)?.hint ?? 'check the environment variables'}
          </Alert>
        )}

        {GROUPS.map((group) => (
          <Stack gap="xs" key={group.title}>
            <div>
              <Text fw={600}>{group.title}</Text>
              <Text size="xs" c="dimmed">
                {group.note}
              </Text>
            </div>
            {group.items.map((operation) => (
              <OperationCard key={operation.id} operation={operation} />
            ))}
          </Stack>
        ))}

        <Text size="xs" c="dimmed">
          Only the commands that need files on disk or one-off setup stay in the
          terminal: migrations, importing CSV and saved pages, exporting the database
          to D1, connecting Gmail.
        </Text>
      </Stack>
    </ScrollArea.Autosize>
  );
}
