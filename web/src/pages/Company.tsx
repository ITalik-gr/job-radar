import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  DataList,
  EmptyState,
  Grid,
  Group,
  Kbd,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  ArrowLeft,
  Ban,
  Building2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  Gauge,
  History,
  Landmark,
  ListChecks,
  MapPin,
  Phone,
  RefreshCw,
  Send,
  SkipForward,
  Sparkles,
  Star,
  Tags,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import {
  api,
  companyKey,
  formatDate,
  type CompanyDetail,
  type CompanyFit,
  type ListCard,
  type RefreshReport,
  type StudioCard,
  type VerdictReport,
} from '../lib/api';
import { href, parse } from '../lib/route';
import { entryState, leaveCompany, originList, stepCompany, type CompanyEntryState } from '../lib/listMemory';
import { lastHash, replaceHash } from '../lib/useRoute';
import { useRoute } from '../lib/useRoute';
import { useHotkeys } from '../lib/hotkeys';
import { useCardAction, type CardAction } from '../components/LeadList';
import { ContactRow } from '../components/ContactRow';
import { LetterDrawer } from '../components/LetterDrawer';
import { SimilarBlock } from '../components/SimilarBlock';
import { Score } from '../components/Score';
import {
  FIT_SERVICES,
  FIT_STAGES,
  FitBadge,
  fitLevel,
  issueIcon,
  MonoLabel,
  ReasonChip,
  reasons,
  SectionHeader,
  SegmentBadge,
} from '../components/ui';
import { STATUS_OPTIONS, StatusBadge, StatusIcon, renderStatusOption, statusLabel } from '../components/statuses';

/** Where back leads, by the section of the list the page was opened from. */
const ORIGIN_LABELS: Record<string, string> = {
  today: 'Today',
  studios: 'Leads',
  startups: 'Startups',
  companies: 'Companies',
  tenders: 'Tenders',
  sending: 'Outbox',
  outreach: 'Outreach',
};

/** Stack taken from the site. WordPress and Tilda mean a studio is unlikely to need a React developer. */
const WEAK_STACK = ['wordpress', 'tilda', 'wix', 'squarespace', 'drupal'];

/**
 * Catalogs stuff everything into tags, down to percentage shares and hourly rates.
 * So the first ten are visible by default and the rest expand and collapse again.
 */
function TagList({ tags: raw, limit = 10 }: { tags: string[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  // Two catalogs write the same tag in different case ("B2B", "b2b"): one badge, not two.
  const tags = [...new Map(raw.map((tag) => [tag.toLowerCase(), tag])).values()];
  const hidden = tags.length - limit;
  const visible = expanded ? tags : tags.slice(0, limit);

  return (
    <Group gap={6}>
      {visible.map((tag) => (
        <Badge key={tag} color="gray">
          {tag}
        </Badge>
      ))}
      {hidden > 0 && (
        <Anchor component="button" type="button" size="sm" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'collapse' : `${hidden} more`}
        </Anchor>
      )}
    </Group>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Text size="sm" c="dimmed">
      {children}
    </Text>
  );
}

/** The top bar: back to the list it came from, and next and previous inside that list. */
function TopBar({ companyKey }: { companyKey: string }) {
  const origin = originList();
  const section = origin ? parse(origin.from)[0] : undefined;
  const label = (section && ORIGIN_LABELS[section]) ?? 'Companies';
  const index = origin ? origin.keys.indexOf(companyKey) : -1;
  const total = origin?.keys.length ?? 0;

  return (
    <Group
      h={48}
      px="lg"
      gap="sm"
      justify="space-between"
      wrap="nowrap"
      style={{ borderBottom: '1px solid var(--mantine-color-gray-2)', flexShrink: 0 }}
    >
      <Tooltip label={<Group gap={6}>Back <Kbd>esc</Kbd></Group>}>
        <Button variant="subtle" color="gray" leftSection={<ArrowLeft size={16} />} onClick={() => leaveCompany()}>
          {label}
        </Button>
      </Tooltip>

      {index >= 0 && total > 1 && (
        <Group gap={4} wrap="nowrap">
          <Text size="xs" c="dimmed" className="mono" mr={4}>
            {index + 1} of {total}
          </Text>
          <Tooltip label={<Group gap={6}>Previous <Kbd>k</Kbd></Group>}>
            <Button
              variant="default"
              size="xs"
              px={8}
              aria-label="previous company"
              disabled={index === 0}
              onClick={() => stepCompany(companyKey, -1)}
            >
              <ChevronUp size={16} />
            </Button>
          </Tooltip>
          <Tooltip label={<Group gap={6}>Next <Kbd>j</Kbd></Group>}>
            <Button
              variant="default"
              size="xs"
              px={8}
              aria-label="next company"
              disabled={index === total - 1}
              onClick={() => stepCompany(companyKey, 1)}
            >
              <ChevronDown size={16} />
            </Button>
          </Tooltip>
        </Group>
      )}
    </Group>
  );
}

function AuditBlock({ audit }: { audit: CompanyDetail['audits'][number] | null }) {
  return (
    <Paper p="md">
      <SectionHeader
        icon={Gauge}
        title="Site audit"
        right={audit && <MonoLabel>{formatDate(audit.checkedAt)}</MonoLabel>}
      />
      {!audit ? (
        <Empty>not checked yet. The audit runs every 6 hours in small batches, PageSpeed key required.</Empty>
      ) : (
        <Stack gap="xs">
          <Group gap={6}>
            {audit.perfScore !== null && (
              <Badge color={audit.perfScore >= 80 ? 'green' : audit.perfScore >= 50 ? 'yellow' : 'red'} className="mono">
                speed {audit.perfScore}
              </Badge>
            )}
            {audit.fieldLcpMs !== null && (
              <Badge color={audit.fieldLcpMs <= 2500 ? 'green' : audit.fieldLcpMs <= 4000 ? 'yellow' : 'red'} className="mono">
                real visitors {(audit.fieldLcpMs / 1000).toFixed(1)} s
              </Badge>
            )}
            {audit.lcpMs !== null && (
              <Badge color="gray" className="mono">
                lab {(audit.lcpMs / 1000).toFixed(1)} s
              </Badge>
            )}
            {audit.mobileOk === false && <Badge color="red">no mobile layout</Badge>}
            {audit.https === false && <Badge color="red">no https</Badge>}
            {audit.cms && <Badge color="gray">{audit.cms}</Badge>}
          </Group>
          {audit.issues.length === 0 ? (
            <Empty>no issues found</Empty>
          ) : (
            audit.issues.map((issue) => {
              const Icon = issueIcon(issue);
              return (
                <Group key={issue} gap={8} wrap="nowrap" align="flex-start">
                  <Icon size={15} strokeWidth={1.75} color="var(--mantine-color-red-7)" style={{ marginTop: 3, flexShrink: 0 }} />
                  <Text size="sm">{issue}</Text>
                </Group>
              );
            })
          )}
        </Stack>
      )}
    </Paper>
  );
}

function LeadsBlock({ leads }: { leads: CompanyDetail['leads'] }) {
  return (
    <Paper p="md">
      <SectionHeader icon={Landmark} title="Leads" color="brand" />
      {leads.length === 0 ? (
        <Empty>no open requests or tenders</Empty>
      ) : (
        <Stack gap={6}>
          {leads.map((lead) => (
            <Group key={lead.id} gap="sm" wrap="nowrap">
              <Badge size="sm" color="gray">
                {lead.source}
              </Badge>
              <Anchor href={lead.url} target="_blank" rel="noreferrer" size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
                {lead.title}
              </Anchor>
              {lead.fit !== null && (
                <Tooltip label="tender fit from the model, 0 to 100">
                  <Badge size="sm" color="gray" className="mono" leftSection={<Sparkles size={10} />}>
                    {lead.fit}
                  </Badge>
                </Tooltip>
              )}
              <Text size="xs" c="dimmed" className="mono" style={{ whiteSpace: 'nowrap' }}>
                {lead.deadlineAt ? `until ${formatDate(lead.deadlineAt)}` : formatDate(lead.firstSeen)}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

function HistoryBlock({ outreach }: { outreach: CompanyDetail['outreach'] }) {
  return (
    <Paper p="md">
      <SectionHeader icon={History} title="Letter history" />
      {outreach.length === 0 ? (
        <Empty>no letters yet</Empty>
      ) : (
        <Stack gap={6}>
          {outreach.map((row) => (
            <Group key={row.id} gap="xs" wrap="nowrap">
              <Text size="sm" className="mono" w={92}>
                {formatDate(row.sentAt)}
              </Text>
              <Text size="sm" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
                {row.subject ?? row.channel}
                {row.contactEmail ? `, ${row.contactEmail}` : ''}
              </Text>
              {row.templateUsed && (
                <Badge color="gray" size="sm">
                  {row.templateUsed}
                </Badge>
              )}
              {row.isFollowup && (
                <Badge color="gray" size="sm">
                  follow-up
                </Badge>
              )}
              <Badge size="sm" color={row.replyType === 'positive' ? 'green' : row.replyType ? 'gray' : 'yellow'}>
                {row.replyType ?? (row.status === 'draft' ? 'draft' : 'no reply')}
              </Badge>
            </Group>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

function ScoreBlock({ card }: { card: StudioCard }) {
  return (
    <Paper p="md">
      <SectionHeader icon={ListChecks} title="Where the score comes from" right={<Score value={card.score} />} />
      <Stack gap={4}>
        {card.why.length === 0 && <Empty>no weights matched</Empty>}
        {card.why.map((item) => (
          <Group key={item.reason} gap="sm" wrap="nowrap">
            <Text w={44} ta="right" className="mono" fz={13} c={item.weight > 0 ? 'green.8' : 'red.8'}>
              {item.weight > 0 ? '+' : ''}
              {item.weight}
            </Text>
            <Text size="sm" c="gray.7">
              {item.reason}
            </Text>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}

function ContactsBlock({ card }: { card: StudioCard }) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  /*
   * An address found by eye. The parser does not get everything: an address can sit in an image,
   * a form, behind a script. Seen, typed, and it is here and in the draft at once.
   */
  const add = useMutation({
    mutationFn: () => api.addContact(card.companyId, { email: email.trim(), name: name.trim() || undefined }),
    onSuccess: (result) => {
      setEmail('');
      setName('');
      void client.invalidateQueries({ queryKey: ['company-card'] });
      void client.invalidateQueries({ queryKey: ['company'] });
      void client.invalidateQueries({ queryKey: ['studios'] });
      notifications.show({
        color: 'green',
        title: card.name,
        message: result.created ? `contact ${result.email} added` : `${result.email} was already a contact`,
      });
    },
    onError: (error: Error) => notifications.show({ color: 'red', title: 'not added', message: error.message }),
  });

  return (
    <Paper p="md">
      <SectionHeader icon={UserRound} title="Contacts" />
      {/* Named contacts come first from the server: a letter to hello@ is read by a manager. */}
      {card.contacts.length === 0 ? (
        <Empty>no contacts. Refresh from site crawls this company's site right now.</Empty>
      ) : (
        <Stack gap={6}>
          {card.contacts.map((contact) => (
            <ContactRow key={contact.id} companyId={card.companyId} contact={contact} />
          ))}
        </Stack>
      )}
      {card.phone && (
        <Group gap={6} mt="xs">
          <Phone size={14} color="var(--mantine-color-gray-6)" />
          <Anchor href={`tel:${card.phone}`} size="sm">
            {card.phone}
          </Anchor>
        </Group>
      )}

      <Group gap="xs" mt="md" align="end" wrap="nowrap">
        <TextInput
          size="xs"
          style={{ flex: 1 }}
          label="add an address by hand"
          placeholder="hello@company.com"
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && email.trim() && add.mutate()}
        />
        <TextInput
          size="xs"
          w={120}
          label="name"
          placeholder="optional"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Button size="xs" disabled={!email.trim()} loading={add.isPending} onClick={() => add.mutate()}>
          Add
        </Button>
      </Group>
    </Paper>
  );
}

function DetailsBlock({ card, detail }: { card: StudioCard; detail: CompanyDetail | undefined }) {
  return (
    <Paper p="md">
      <SectionHeader icon={Building2} title="Details" />
      <DataList labelWidth={112} gap="xs">
        <DataList.Item>
          <DataList.ItemLabel>
            <MonoLabel>industry</MonoLabel>
          </DataList.ItemLabel>
          <DataList.ItemValue>{card.industry ?? <Text c="dimmed">unknown</Text>}</DataList.ItemValue>
        </DataList.Item>
        {(card.hourlyRate || card.minProject || card.foundedYear || card.sizeHint) && (
          <DataList.Item>
            <DataList.ItemLabel>
              <MonoLabel>catalog</MonoLabel>
            </DataList.ItemLabel>
            <DataList.ItemValue>
              <Group gap={6}>
                {card.sizeHint && <Badge color="gray">{card.sizeHint}</Badge>}
                {card.hourlyRate && <Badge color="gray">rate {card.hourlyRate}</Badge>}
                {card.minProject && <Badge color="gray">projects from {card.minProject}</Badge>}
                {card.foundedYear && <Badge color="gray">since {card.foundedYear}</Badge>}
              </Group>
            </DataList.ItemValue>
          </DataList.Item>
        )}
        <DataList.Item>
          <DataList.ItemLabel>
            <MonoLabel>stack</MonoLabel>
          </DataList.ItemLabel>
          <DataList.ItemValue>
            {card.techHints.length === 0 ? (
              <Text c="dimmed">not detected</Text>
            ) : (
              <Group gap={6}>
                {card.techHints.map((tech) => (
                  <Badge key={tech} color={WEAK_STACK.includes(tech) ? 'red' : 'gray'}>
                    {tech}
                  </Badge>
                ))}
              </Group>
            )}
          </DataList.ItemValue>
        </DataList.Item>
        <DataList.Item>
          <DataList.ItemLabel>
            <MonoLabel>sources</MonoLabel>
          </DataList.ItemLabel>
          <DataList.ItemValue>
            <Group gap={6}>
              {card.sources.map((source) => (
                <Badge key={source} color="gray">
                  {source}
                </Badge>
              ))}
              {card.sourceUrl && (
                <Anchor href={card.sourceUrl} target="_blank" rel="noreferrer" size="sm">
                  catalog profile
                </Anchor>
              )}
            </Group>
          </DataList.ItemValue>
        </DataList.Item>
        {card.careersUrl && (
          <DataList.Item>
            <DataList.ItemLabel>
              <MonoLabel>careers</MonoLabel>
            </DataList.ItemLabel>
            <DataList.ItemValue>
              <Anchor href={card.careersUrl} target="_blank" rel="noreferrer" size="sm">
                {card.careersKind}
              </Anchor>
            </DataList.ItemValue>
          </DataList.Item>
        )}
        {detail?.company.address && (
          <DataList.Item>
            <DataList.ItemLabel>
              <MonoLabel>address</MonoLabel>
            </DataList.ItemLabel>
            <DataList.ItemValue>{detail.company.address}</DataList.ItemValue>
          </DataList.Item>
        )}
        {/*
          Everything the catalog showed beyond the known fields. The set differs per catalog, so
          these are plain label and value pairs, no columns.
        */}
        {Object.entries(card.extra ?? {}).map(([label, value]) => (
          <DataList.Item key={label}>
            <DataList.ItemLabel>
              <MonoLabel>{label}</MonoLabel>
            </DataList.ItemLabel>
            <DataList.ItemValue>{value}</DataList.ItemValue>
          </DataList.Item>
        ))}
        <DataList.Item>
          <DataList.ItemLabel>
            <MonoLabel>seen</MonoLabel>
          </DataList.ItemLabel>
          <DataList.ItemValue>
            <Text size="sm" className="mono">
              first {formatDate(card.firstSeen)}, checked {formatDate(card.lastChecked) || 'never'}
            </Text>
          </DataList.ItemValue>
        </DataList.Item>
      </DataList>

      {card.tags.length > 0 && (
        <Box mt="md">
          <Group gap={6} mb={6}>
            <Tags size={14} color="var(--mantine-color-gray-6)" />
            <MonoLabel>catalog tags</MonoLabel>
          </Group>
          <TagList tags={card.tags} />
        </Box>
      )}
    </Paper>
  );
}

/** The model's verdict: which template to open with. Advice next to the deterministic choice. */
function VerdictBlock({ verdict }: { verdict: VerdictReport }) {
  return (
    <Alert color={verdict.verdict ? (verdict.verdict.skip ? 'yellow' : 'gray') : 'yellow'} icon={<Sparkles size={16} />} p="sm">
      <Stack gap={6}>
        {/* An empty verdict always explains itself, rule 3 of CLAUDE.md. */}
        {verdict.error && <Text size="sm">{verdict.error}</Text>}
        {verdict.verdict && (
          <>
            <Group gap="xs">
              <Badge color={verdict.verdict.skip ? 'yellow' : 'green'}>
                {verdict.verdict.skip ? 'do not write' : (verdict.verdict.template_slug ?? 'no template')}
              </Badge>
              <Text size="xs" c="dimmed">
                confidence {verdict.verdict.confidence}, language {verdict.verdict.language}
                {verdict.source === 'cache' ? ', from cache' : ''}
              </Text>
            </Group>
            {verdict.verdict.skip
              ? verdict.verdict.skip_reason && <Text size="sm">{verdict.verdict.skip_reason}</Text>
              : <Text size="sm">{verdict.verdict.angle}</Text>}
            <Text size="xs" c="dimmed">
              {verdict.verdict.why}
            </Text>
            {verdict.verdict.risks.length > 0 && (
              <Text size="xs" c="dimmed">
                risks: {verdict.verdict.risks.join('; ')}
              </Text>
            )}
          </>
        )}
        {/*
          The deterministic choice is always shown alongside. Without it there is no telling
          whether the model saw something or repeated what the code computes anyway.
        */}
        <Text size="xs" c="dimmed">
          without the model it would be {verdict.fallbackSlug ?? 'no template'} ({verdict.fallbackTarget})
        </Text>
      </Stack>
    </Alert>
  );
}

function RefreshBlock({ report }: { report: RefreshReport }) {
  return (
    <Alert color={report.reachable ? 'gray' : 'yellow'} icon={<RefreshCw size={16} />} p="sm">
      <Stack gap={2}>
        <Text size="xs">
          pages opened: {report.pagesFetched}
          {!report.reachable && ', the home page did not open for the server'}
          {report.reachable && report.clientRendered && ', the page renders with script'}
          {report.needsBrowser && '. The domain is queued for the extension'}
        </Text>
        <Text size="xs">
          careers page: {report.careersUrl ?? 'not found'}
          {report.careersSlug ? ` (${report.careersKind}: ${report.careersSlug})` : ''}
        </Text>
        <Text size="xs">
          stack: {report.techHints.length} total
          {report.techAdded.length > 0 ? `, new: ${report.techAdded.join(', ')}` : ', nothing new'}
        </Text>
        <Text size="xs">
          email: {report.emails.length > 0 ? report.emails.join(', ') : 'not found'}
          {report.contactsAdded > 0 ? `, added ${report.contactsAdded}` : ''}
          {report.people > 0 ? `, people with names: ${report.people}` : ''}
        </Text>
      </Stack>
    </Alert>
  );
}

/**
 * Would they buy, and what: the model's three picks from fixed lists (config/fit.json). No text
 * of its own, so nothing here can be made up. Asked in small batches every hour, or right here.
 */
function FitBlock({ card }: { card: StudioCard }) {
  const client = useQueryClient();
  const [result, setResult] = useState<CompanyFit | null>(null);
  const ask = useMutation({
    mutationFn: () => api.companyFit(card.companyId),
    onSuccess: (fit) => {
      setResult(fit);
      for (const key of ['company-card', 'studios', 'companies', 'queue']) void client.invalidateQueries({ queryKey: [key] });
    },
    onError: (error: Error) => notifications.show({ color: 'yellow', title: 'Not asked', message: error.message }),
  });

  const fit = result?.fit ?? card.fit;
  const service = result ? result.service : card.fitService;
  const stage = result ? result.stage : card.fitStage;
  const level = fitLevel(fit);
  const top = (probabilities: Record<string, number> | undefined, labels: Record<string, string>) =>
    Object.entries(probabilities ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .filter(([key]) => labels[key])
      .map(([key, value]) => `${labels[key]} ${Math.round(value * 100)}%`)
      .join(', ');

  return (
    <Paper p="md">
      <SectionHeader
        icon={Sparkles}
        title="Would they buy"
        color="brand"
        right={
          <Button size="xs" leftSection={<Sparkles size={13} />} loading={ask.isPending} onClick={() => ask.mutate()}>
            {level ? 'Ask again' : 'Ask the model'}
          </Button>
        }
      />
      {!level ? (
        <Empty>
          not asked yet. The model reads the description, tags, segment and stack, and picks from fixed lists: how likely
          they are to pay an outside developer, which service, what stage.
        </Empty>
      ) : (
        <Stack gap={8}>
          <Group gap={6}>
            <Badge color={level.color} size="lg" leftSection={<Sparkles size={12} />}>
              {level.label}
            </Badge>
            {service && <Badge color="gray" size="lg">{FIT_SERVICES[service] ?? service}</Badge>}
            {stage && <Badge color="gray" size="lg">{FIT_STAGES[stage] ?? stage}</Badge>}
          </Group>
          {result && (
            <Text size="xs" c="dimmed">
              {result.source === 'cache' ? 'from cache, no call spent. ' : ''}
              {top(result.probabilities.service, FIT_SERVICES) && `service: ${top(result.probabilities.service, FIT_SERVICES)}. `}
              {top(result.probabilities.stage, FIT_STAGES) && `stage: ${top(result.probabilities.stage, FIT_STAGES)}.`}
            </Text>
          )}
          {!service && <Text size="xs" c="dimmed">no service picked: the model was not sure enough</Text>}
        </Stack>
      )}
    </Paper>
  );
}

/** A block frame while its data is on the way: the same header, one quiet line, no shifting skeleton. */
function Pending({ icon, title }: { icon: typeof Star; title: string }) {
  return (
    <Paper p="md">
      <SectionHeader icon={icon} title={title} />
      <Empty>loading</Empty>
    </Paper>
  );
}

function CompanyBody({
  card,
  detail,
  verdict,
  report,
}: {
  card: StudioCard;
  detail: CompanyDetail | undefined;
  verdict: VerdictReport | null;
  report: RefreshReport | null;
}) {
  const all = reasons(card);
  const weak = card.techHints.filter((tech) => WEAK_STACK.includes(tech));
  const yearsBehind = card.copyrightYear ? new Date().getFullYear() - card.copyrightYear : 0;
  const silentDays = card.lastPostAt ? Math.round((Date.now() - card.lastPostAt) / 86_400_000) : 0;
  const abandoned = yearsBehind >= 2 || silentDays >= 540;

  return (
    <Grid gap="md" align="flex-start">
      <Grid.Col span={{ base: 12, md: 8 }}>
        <Stack gap="md">
          <FitBlock card={card} />
          <Paper p="md">
            <SectionHeader icon={TriangleAlert} title="Why write" color="red" />
            {all.length === 0 ? (
              <Empty>nothing specific: no audit issue, no tender, no hiring signal</Empty>
            ) : (
              <Group gap={6}>
                {all.map((reason) => (
                  <ReasonChip key={reason.label} reason={reason} maw={560} />
                ))}
              </Group>
            )}
            {(abandoned || weak.length > 0) && (
              <Stack gap={6} mt="sm">
                {abandoned && (
                  <Alert color="yellow" p="xs" icon={<Clock size={16} />}>
                    The site looks abandoned:
                    {yearsBehind >= 2 && ` copyright ${card.copyrightYear}.`}
                    {silentDays >= 540 && ` last post ${silentDays} days ago.`} Companies like this rarely answer.
                  </Alert>
                )}
                {weak.length > 0 && card.kind !== 'smb' && card.kind !== 'ecommerce' && card.kind !== 'public' && (
                  <Alert color="yellow" p="xs" icon={<TriangleAlert size={16} />}>
                    The site shows {weak.join(', ')}. A studio like this rarely needs a React developer.
                  </Alert>
                )}
              </Stack>
            )}
          </Paper>

          {verdict && <VerdictBlock verdict={verdict} />}
          {report && <RefreshBlock report={report} />}

          <ScoreBlock card={card} />
          {detail ? (
            <>
              <AuditBlock audit={detail.audits[0] ?? null} />
              <LeadsBlock leads={detail.leads} />
              <HistoryBlock outreach={detail.outreach} />
            </>
          ) : (
            <>
              <Pending icon={Gauge} title="Site audit" />
              <Pending icon={Landmark} title="Leads" />
              <Pending icon={History} title="Letter history" />
            </>
          )}
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, md: 4 }}>
        <Stack gap="md">
          <ContactsBlock card={card} />
          <DetailsBlock card={card} detail={detail} />
          <SimilarBlock companyId={card.companyId} />
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

/** The row for this key in any list already loaded: Today, Leads, Startups, Companies. */
function cachedRow(client: QueryClient, key: string): ListCard | undefined {
  for (const root of ['queue', 'studios', 'companies']) {
    for (const [, data] of client.getQueriesData<{ cards?: ListCard[] }>({ queryKey: [root] })) {
      const found = data?.cards?.find((row) => companyKey(row) === key);
      if (found) return found;
    }
  }
  return undefined;
}

const ACTIONS: { key: string; label: string; hint: string; icon: typeof Star; body: CardAction; color?: string }[] = [
  { key: 'i', label: 'Interesting', hint: 'kept for later, stays in the lists, no letter is sent', icon: Star, body: { action: 'interesting' } },
  { key: 'n', label: 'Skip', hint: 'rejected by me: leaves the lists for good, stays in the database', icon: SkipForward, body: { action: 'not_interesting' } },
  { key: 's', label: 'Snooze', hint: 'hidden from the lists for 60 days', icon: Clock, body: { action: 'snooze', days: 60 } },
  { key: 'b', label: 'Block', hint: 'never show this company again', icon: Ban, body: { action: 'blacklist' }, color: 'red' },
];

/**
 * The one company view. Today, Leads, Startups, Tenders and Companies all open it, so a company
 * reads the same wherever it was found: why write, where the score comes from, contacts, audit,
 * leads, letter history. The letter is a drawer on top (`#/companies/acme.com/letter`), so
 * browser back closes the drawer first and then returns to the list.
 */
export function CompanyPage({ companyKey }: { companyKey: string }) {
  const client = useQueryClient();
  const { segments } = useRoute();
  const letterOpen = segments[2] === 'letter';

  /*
   * A plain link (from a tender, a draft) makes an entry without a recorded origin. When the
   * previous address was inside the app, it becomes the origin, so back is a history back that
   * lands on that list as it was, not a jump to Companies.
   */
  useEffect(() => {
    if (entryState().from) return;
    const previous = lastHash();
    if (previous && parse(previous)[0] && !(parse(previous)[0] === 'companies' && parse(previous)[1])) {
      window.history.replaceState({ ...entryState(), from: previous } satisfies CompanyEntryState, '');
    }
  }, []);

  const cardQuery = useQuery({
    queryKey: ['company-card', companyKey],
    queryFn: () => api.companyCard(companyKey),
    retry: false,
  });
  const card = cardQuery.data;
  /*
   * The row the page was opened from is already in the list cache, so the header (name, segment,
   * score, actions) shows at once and the full card fills the rest a moment later. The details
   * query starts from the same row instead of waiting for the card.
   */
  const preview = useMemo(() => cachedRow(client, companyKey), [client, companyKey]);
  const head: ListCard | undefined = card ?? preview;
  const detailQuery = useQuery({
    queryKey: ['company', head?.companyId],
    queryFn: () => api.company(head!.companyId),
    enabled: Boolean(head),
  });
  const detail = detailQuery.data;

  const act = useCardAction();

  const setState = useMutation({
    mutationFn: (status: string) => api.setCompanyState(head!.companyId, { status }),
    onSuccess: (_result, status) => {
      notifications.show({ color: 'green', title: 'Status changed', message: statusLabel(status) });
      for (const key of ['company', 'company-card', 'companies', 'studios', 'queue']) {
        void client.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  /*
   * A full review of one company: back to the site, careers page, stack, contacts. Nightly passes
   * do the same in batches, so the company the owner is looking at now could wait days for it.
   */
  const [report, setReport] = useState<RefreshReport | null>(null);
  const refresh = useMutation({
    mutationFn: () => api.refreshCompany(head!.companyId),
    onSuccess: (result) => {
      setReport(result);
      void client.invalidateQueries({ queryKey: ['company-card', companyKey] });
      void client.invalidateQueries({ queryKey: ['company'] });
      notifications.show({
        color: result.contactsAdded > 0 || result.techAdded.length > 0 ? 'green' : 'yellow',
        title: head!.name,
        message: !result.reachable
          ? 'the site did not open for the server. It is queued for the extension: popup, "Crawl in background"'
          : result.clientRendered && result.emails.length === 0
            ? 'the site renders its content with script. It is queued for the extension: popup, "Crawl in background"'
            : `pages ${result.pagesFetched}, contacts +${result.contactsAdded}, stack +${result.techAdded.length}`,
      });
    },
    onError: (error: Error) => notifications.show({ color: 'red', title: 'failed', message: error.message }),
  });

  /*
   * The model's verdict costs a call from the daily cap, so it is a deliberate press, never fired
   * on opening a company.
   */
  const [verdict, setVerdict] = useState<VerdictReport | null>(null);
  const askVerdict = useMutation({
    mutationFn: () => api.companyVerdict(head!.companyId),
    onSuccess: setVerdict,
    onError: (error: Error) => notifications.show({ color: 'red', title: 'failed', message: error.message }),
  });

  const openLetter = () => {
    if (letterOpen) return;
    window.history.pushState({ ...entryState(), letter: true } satisfies CompanyEntryState, '', href('companies', companyKey, 'letter'));
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  const closeLetter = () => {
    if (entryState().letter) window.history.back();
    else replaceHash(href('companies', companyKey));
  };

  useHotkeys(
    useMemo(
      () => ({
        escape: () => leaveCompany(),
        backspace: () => leaveCompany(),
        j: () => stepCompany(companyKey, 1),
        k: () => stepCompany(companyKey, -1),
        l: () => head && openLetter(),
        r: () => head && refresh.mutate(),
        v: () => head && askVerdict.mutate(),
        ...Object.fromEntries(ACTIONS.map((item) => [item.key, () => head && act(head, item.body)])),
      }),
      [head, companyKey, act, refresh, askVerdict, letterOpen],
    ),
    !letterOpen,
  );

  if (cardQuery.error) {
    return (
      <>
        <TopBar companyKey={companyKey} />
        <Box p="lg">
          <EmptyState
            icon={<Building2 size={24} />}
            withIndicatorBackground
            title="No such company"
            description={`Nothing in the database answers to "${companyKey}". ${cardQuery.error instanceof Error ? cardQuery.error.message : ''}`}
          />
        </Box>
      </>
    );
  }

  if (!head) {
    // Opened from a link with nothing cached: the page frame without values, no jumping blocks.
    return (
      <>
        <TopBar companyKey={companyKey} />
        <Box className="dotted" px="lg" pt="lg" pb="md" h={196} style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
          <Title order={1} c="gray.4">
            {companyKey}
          </Title>
        </Box>
      </>
    );
  }

  const status = detail?.state?.status ?? head.status;

  return (
    <>
      <TopBar companyKey={companyKey} />

      <div className="min-h-0 flex-1 overflow-auto">
        <Box className="dotted" px="lg" pt="lg" pb="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
          <Group justify="space-between" align="flex-start" wrap="nowrap" gap="lg">
            <Box style={{ minWidth: 0 }}>
              <Group gap="xs" mb={8}>
                <SegmentBadge kind={head.kind} size="md" />
                <StatusBadge status={status} />
                <FitBadge fit={head.fit} service={head.fitService} />
                {head.rating !== null && (
                  <Badge color={head.rating >= 4.5 ? 'green' : head.rating >= 4 ? 'gray' : 'yellow'} leftSection={<Star size={11} />} className="mono">
                    {head.rating.toFixed(1)}
                    {head.reviewsCount !== null ? ` · ${head.reviewsCount}` : ''}
                  </Badge>
                )}
                {head.lastContactedAt && (
                  <Badge color="yellow" leftSection={<Send size={11} />}>
                    contacted {formatDate(head.lastContactedAt)}
                  </Badge>
                )}
              </Group>
              <Title order={1}>{head.name}</Title>
              <Group gap="md" mt={6}>
                {head.domain ? (
                  <Anchor href={`https://${head.domain}`} target="_blank" rel="noreferrer" size="sm">
                    <Group gap={4} wrap="nowrap">
                      {head.domain}
                      <ExternalLink size={12} />
                    </Group>
                  </Anchor>
                ) : (
                  <Text size="sm" c="dimmed">
                    no site
                  </Text>
                )}
                {(head.city || head.country) && (
                  <Group gap={4} wrap="nowrap">
                    <MapPin size={13} color="var(--mantine-color-gray-6)" />
                    <Text size="sm" c="gray.7">
                      {[head.city, head.country].filter(Boolean).join(', ')}
                    </Text>
                  </Group>
                )}
              </Group>
              {head.description && (
                <Text size="sm" c="gray.7" mt="sm" maw={720} lineClamp={3}>
                  {head.description}
                </Text>
              )}
            </Box>

            <Box ta="right" style={{ flexShrink: 0 }}>
              <MonoLabel>score</MonoLabel>
              <Text className="display tabular" fz={40} lh={1.1}>
                {head.score.toFixed(1)}
              </Text>
            </Box>
          </Group>

          <Group gap="xs" mt="md">
            <Tooltip label={<Group gap={6}>Template preview, send checks, timer <Kbd>l</Kbd></Group>}>
              <Button variant="filled" leftSection={<Send size={15} />} onClick={openLetter}>
                Write a letter
              </Button>
            </Tooltip>
            {ACTIONS.map((item) => (
              <Tooltip key={item.key} label={<Group gap={6}>{item.hint} <Kbd>{item.key}</Kbd></Group>}>
                <Button
                  color={item.color}
                  leftSection={<item.icon size={15} />}
                  onClick={() => act(head, item.body)}
                  styles={item.color ? { root: { color: 'var(--mantine-color-red-7)' } } : undefined}
                >
                  {item.label}
                </Button>
              </Tooltip>
            ))}
            <Tooltip label={<Group gap={6}>Visit the site again: careers page, stack, email, contacts <Kbd>r</Kbd></Group>}>
              <Button leftSection={<RefreshCw size={15} />} loading={refresh.isPending} onClick={() => refresh.mutate()}>
                Refresh from site
              </Button>
            </Tooltip>
            <Tooltip label={<Group gap={6}>Ask the model which template fits, costs one call <Kbd>v</Kbd></Group>}>
              <Button leftSection={<Sparkles size={15} />} loading={askVerdict.isPending} onClick={() => askVerdict.mutate()}>
                Which template
              </Button>
            </Tooltip>
            <Select
              ml="auto"
              w={200}
              data={STATUS_OPTIONS}
              value={status}
              onChange={(next) => next && setState.mutate(next)}
              renderOption={renderStatusOption}
              leftSection={<StatusIcon status={status} />}
              allowDeselect={false}
              maxDropdownHeight={400}
              comboboxProps={{ width: 320, position: 'bottom-end' }}
              aria-label="status"
            />
          </Group>
        </Box>

        <Box p="lg">
          {card ? (
            <CompanyBody card={card} detail={detail} verdict={verdict} report={report} />
          ) : (
            <Text size="sm" c="dimmed">
              loading the company
            </Text>
          )}
        </Box>
      </div>

      {card && <LetterDrawer card={card} opened={letterOpen} onClose={closeLetter} />}
    </>
  );
}
