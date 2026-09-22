import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Checkbox,
  DataList,
  Divider,
  EmptyState,
  Group,
  Kbd,
  NumberInput,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  Ban,
  Check,
  Clock,
  ExternalLink,
  Mail,
  Palette,
  RefreshCw,
  Sparkles,
  Search,
  MailPlus,
  Send,
  ThumbsDown,
} from 'lucide-react';
import { api, formatDate, type RefreshReport, type StudioCard, type VerdictReport } from '../lib/api';
import { ContactRow } from '../components/ContactRow';
import { useSelection } from '../lib/useRoute';
import { useHotkeys } from '../lib/hotkeys';
import { PaneFooter, PaneHeader, SplitView } from '../components/SplitView';
import { TemplateSelect } from '../components/TemplateSelect';
import { Score } from '../components/Score';
import { LetterBlock } from '../components/LetterBlock';
import { SimilarBlock } from '../components/SimilarBlock';

/** Company kind labels. The same list as in `src/pipeline/company-kind.ts`. */
const KIND_LABELS: Record<string, string> = {
  studio: 'studio',
  design: 'design studio',
  startup: 'startup',
  product: 'product',
  outstaff: 'outstaffing',
  unknown: 'unknown kind',
};

const KIND_COLORS: Record<string, string> = {
  studio: 'brand',
  design: 'grape',
  startup: 'green',
  product: 'gray',
  outstaff: 'yellow',
  unknown: 'gray',
};

/** Stack taken from the studio site. WordPress and Tilda mean they are unlikely to hire front end developers. */
const WEAK_STACK = ['wordpress', 'tilda', 'wix', 'squarespace', 'drupal'];

function Row({ card, active, onSelect }: { card: StudioCard; active: boolean; onSelect: () => void }) {
  return (
    <UnstyledButton
      onClick={onSelect}
      px="md"
      py="sm"
      w="100%"
      style={{
        display: 'block',
        textAlign: 'left',
        borderBottom: '1px solid var(--mantine-color-gray-2)',
        borderLeft: `3px solid ${active ? 'var(--mantine-color-brand-6)' : 'transparent'}`,
        background: active ? 'var(--mantine-color-brand-0)' : undefined,
      }}
    >
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Score value={card.score} size="sm" />
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600} truncate>
              {card.name}
            </Text>
            {card.lastContactedAt && <Clock size={13} color="var(--mantine-color-yellow-7)" />}
          </Group>

          <Text size="xs" c="dimmed" truncate mt={2}>
            {[card.city, card.country].filter(Boolean).join(', ') || card.domain}
          </Text>

          <Group gap={4} mt={6} wrap="nowrap" style={{ overflow: 'hidden' }}>
            {card.openVacancies > 0 && (
              <Badge size="xs" color="green">
                {card.openVacancies} vacancies
              </Badge>
            )}
            {/* The rating shows in the list already: otherwise reputation takes opening cards one by one. */}
            {card.rating !== null && (
              <Badge size="xs" color={card.rating >= 4.5 ? 'green' : card.rating >= 4 ? 'gray' : 'yellow'}>
                {card.rating.toFixed(1)}
                {card.reviewsCount ? ` · ${card.reviewsCount}` : ''}
              </Badge>
            )}
            {card.techHints.slice(0, 3).map((tech) => (
              <Badge key={tech} size="xs" color={WEAK_STACK.includes(tech) ? 'red' : 'brand'}>
                {tech}
              </Badge>
            ))}
          </Group>
        </Box>
      </Group>
    </UnstyledButton>
  );
}

/**
 * Catalogs stuff everything into tags, down to percentage shares and hourly rates.
 * So the first ten are visible by default and the rest expand and collapse again:
 * the "6 more" counter used to be plain text that did nothing.
 */
function TagList({ tags, limit = 10 }: { tags: string[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
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

function Detail({ card, onAct }: { card: StudioCard; onAct: (body: Record<string, unknown>) => void }) {
  const [template, setTemplate] = useState<string | null>(null);

  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [contactName, setContactName] = useState('');

  const addContact = useMutation({
    mutationFn: () =>
      api.addContact(card.companyId, { email: email.trim(), name: contactName.trim() || undefined }),
    onSuccess: (result) => {
      setEmail('');
      setContactName('');
      void client.invalidateQueries({ queryKey: ['studios'] });
      notifications.show({
        color: 'green',
        title: card.name,
        message: result.created ? `contact ${result.email} added` : `${result.email} was already a contact`,
      });
    },
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'not added', message: error.message }),
  });

  /*
   * Crawling one company site on demand. The general pass runs in batches and picks
   * companies by priority, so the specific studio the owner is looking at right now
   * could wait days for it. Here it is crawled at once.
   */
  const [report, setReport] = useState<RefreshReport | null>(null);

  /*
   * A full review of one company: back to the site, careers page, stack, contacts.
   * Nightly passes do the same on a schedule and in batches, so the specific studio the
   * owner is looking at now could wait its turn for days.
   */
  const refresh = useMutation({
    mutationFn: () => api.refreshCompany(card.companyId),
    onSuccess: (result) => {
      setReport(result);
      void client.invalidateQueries({ queryKey: ['studios'] });
      notifications.show({
        color: result.contactsAdded > 0 || result.techAdded.length > 0 ? 'green' : 'yellow',
        title: card.name,
        message: !result.reachable
          ? 'the site did not open for the server. It is queued for the extension: popup, "Crawl in background"'
          : result.clientRendered && result.emails.length === 0
            ? 'the site renders its content with script. It is queued for the extension: popup, "Crawl in background"'
            : `pages ${result.pagesFetched}, contacts +${result.contactsAdded}, stack +${result.techAdded.length}`,
      });
    },
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'failed', message: error.message }),
  });

  /*
   * The model's verdict: which template to open with and what to hook onto.
   *
   * Advice, not a decision. The chosen template goes straight into the select below, but
   * it can be changed there with one click, and that is the whole point: sending was
   * deterministic and stays that way.
   */
  const [verdict, setVerdict] = useState<VerdictReport | null>(null);

  const askVerdict = useMutation({
    mutationFn: () => api.companyVerdict(card.companyId),
    onSuccess: (result) => {
      setVerdict(result);
      if (result.verdict?.template_slug) setTemplate(result.verdict.template_slug);
      notifications.show({
        color: result.verdict ? 'green' : 'yellow',
        title: card.name,
        message:
          result.error ??
          (result.verdict?.skip
            ? `advises not to write: ${result.verdict.skip_reason ?? 'no reason given'}`
            : `template ${result.verdict?.template_slug}, confidence ${result.verdict?.confidence}`),
      });
    },
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'failed', message: error.message }),
  });

  const toDrafts = useMutation({
    mutationFn: () => api.draftForCompany(card.companyId, null, template),
    onSuccess: (result) =>
      notifications.show({
        color: result.id && !result.reason ? 'green' : 'yellow',
        title: card.name,
        message: result.reason ?? 'draft is on the Outbox page',
      }),
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'failed', message: error.message }),
  });

  useHotkeys(
    useMemo(
      () => ({
        d: () => toDrafts.mutate(),
        k: () => refresh.mutate(),
        v: () => askVerdict.mutate(),
        i: () => onAct({ action: 'interesting' }),
        n: () => onAct({ action: 'not_interesting' }),
        e: () => onAct({ action: 'contacted', templateUsed: template }),
        b: () => onAct({ action: 'blacklist' }),
        s: () => onAct({ action: 'snooze', days: 60 }),
      }),
      [onAct, template, toDrafts, refresh, askVerdict],
    ),
  );

  const weak = card.techHints.filter((tech) => WEAK_STACK.includes(tech));

  return (
    <>
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box p="lg" maw={860}>
          <Group gap="sm" mb="xs">
            <Text size="sm" c="dimmed">
              {card.domain}
            </Text>
            <Badge color={KIND_COLORS[card.kind] ?? 'gray'}>{KIND_LABELS[card.kind] ?? card.kind}</Badge>
            {card.sizeHint && <Badge color="gray">{card.sizeHint}</Badge>}
            {/*
              Rating and reviews sit next to the name on purpose: they are the quickest answer
              to "is anyone there to read the letter", and it should not take opening the card.
            */}
            {card.rating !== null && (
              <Badge color={card.rating >= 4.5 ? 'green' : card.rating >= 4 ? 'gray' : 'yellow'}>
                {card.rating.toFixed(1)}
                {card.reviewsCount !== null && ` · ${card.reviewsCount} reviews`}
              </Badge>
            )}
            {card.rating === null && card.reviewsCount !== null && (
              <Badge color="gray">{card.reviewsCount} reviews</Badge>
            )}
            {card.lastContactedAt && (
              <Badge color="yellow" leftSection={<Clock size={11} />}>
                contacted {formatDate(card.lastContactedAt)}
              </Badge>
            )}
          </Group>

          <Title order={2}>{card.name}</Title>

          {card.description && (
            <Text mt="sm" c="dimmed">
              {card.description}
            </Text>
          )}

          {/*
            A dead site shows up right away, before the owner starts writing.
            The year comes from the footer copyright, the date from the latest post.
          */}
          {(() => {
            const yearsBehind = card.copyrightYear ? new Date().getFullYear() - card.copyrightYear : 0;
            const silentDays = card.lastPostAt
              ? Math.round((Date.now() - card.lastPostAt) / 86_400_000)
              : 0;
            if (yearsBehind < 2 && silentDays < 540) return null;

            return (
              <Alert color="yellow" mt="md" icon={<Clock size={16} />} title="The site looks abandoned">
                {yearsBehind >= 2 && `Copyright ${card.copyrightYear}. `}
                {silentDays >= 540 && `Last post ${silentDays} days ago. `}
                Studios like this rarely answer letters.
              </Alert>
            );
          })()}

          {weak.length > 0 && (
            <Alert color="yellow" mt="md" title="Weak site stack">
              The site shows {weak.join(', ')}. A studio like this rarely hires a React developer, and the
              letter will most likely go nowhere.
            </Alert>
          )}

          <Group mt="md" gap="sm">
            <Button
              component="a"
              href={`https://${card.domain}`}
              target="_blank"
              rel="noreferrer"
              variant="light"
              leftSection={<ExternalLink size={14} />}
            >
              {card.kind === 'startup' ? 'Startup site' : 'Studio site'}
            </Button>
            {card.careersUrl && (
              <Button component="a" href={card.careersUrl} target="_blank" rel="noreferrer" variant="subtle">
                Careers page
              </Button>
            )}
            {card.sourceUrl && (
              <Button component="a" href={card.sourceUrl} target="_blank" rel="noreferrer" variant="subtle">
                Catalog profile
              </Button>
            )}
          </Group>

          <Divider my="lg" />

          <DataList labelWidth={132} gap="sm">
            <DataList.Item>
              <DataList.ItemLabel>score</DataList.ItemLabel>
              <DataList.ItemValue>
                <Score value={card.score} />
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>location</DataList.ItemLabel>
              <DataList.ItemValue>
                {[card.city, card.country].filter(Boolean).join(', ') || <Text c="dimmed">not stated</Text>}
              </DataList.ItemValue>
            </DataList.Item>

            {(card.hourlyRate || card.minProject || card.foundedYear) && (
              <DataList.Item>
                <DataList.ItemLabel>catalog</DataList.ItemLabel>
                <DataList.ItemValue>
                  <Group gap={6}>
                    {card.hourlyRate && <Badge color="gray">rate {card.hourlyRate}</Badge>}
                    {card.minProject && <Badge color="gray">projects from {card.minProject}</Badge>}
                    {card.foundedYear && <Badge color="gray">since {card.foundedYear}</Badge>}
                  </Group>
                </DataList.ItemValue>
              </DataList.Item>
            )}

            <DataList.Item>
              <DataList.ItemLabel>stack from the site</DataList.ItemLabel>
              <DataList.ItemValue>
                {card.techHints.length === 0 ? (
                  <Text c="dimmed">not detected</Text>
                ) : (
                  <Group gap={6}>
                    {card.techHints.map((tech) => (
                      <Badge key={tech} color={WEAK_STACK.includes(tech) ? 'red' : 'brand'}>
                        {tech}
                      </Badge>
                    ))}
                  </Group>
                )}
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>catalog tags</DataList.ItemLabel>
              <DataList.ItemValue>
                {card.tags.length === 0 ? (
                  <Text c="dimmed">none</Text>
                ) : (
                  <TagList tags={card.tags} />
                )}
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>sources</DataList.ItemLabel>
              <DataList.ItemValue>{card.sources.join(', ') || <Text c="dimmed">unknown</Text>}</DataList.ItemValue>
            </DataList.Item>

            {/*
              The "Other" block: everything the catalog showed beyond the known fields. The set
              differs per catalog, so these are plain label and value pairs, no columns.
            */}
            {Object.entries(card.extra ?? {}).map(([label, value]) => (
              <DataList.Item key={label}>
                <DataList.ItemLabel>{label.toLowerCase()}</DataList.ItemLabel>
                <DataList.ItemValue>{value}</DataList.ItemValue>
              </DataList.Item>
            ))}
          </DataList>

          {/* Named contacts are worth more than hello@, so they get their own block above the score breakdown. */}
          <Text size="xs" tt="uppercase" fw={500} c="dimmed" mt="lg" mb="xs" style={{ letterSpacing: '0.04em' }}>
            contacts
          </Text>
          {card.contacts.length === 0 ? (
            <Text c="dimmed" size="sm">
              no named contacts. The address on a site is almost always hello@ or info@, and a manager reads it.
              The "Refresh from site" button below crawls this company's site right now.
            </Text>
          ) : (
            <Stack gap={6}>
              {card.contacts.map((contact) => (
                <ContactRow key={contact.id} companyId={card.companyId} contact={contact} />
              ))}
            </Stack>
          )}

          {/*
            Report of the last review. Shown as is, with details: the button is how the
            search gets checked, and a bare "updated" says nothing about whether the site
            opened at all or where the stack came from.
          */}
          {report && (
            <Alert mt="md" color={report.reachable ? 'gray' : 'yellow'} p="xs">
              <Stack gap={4}>
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
          )}

          {/*
            An address found by eye. The parser does not get everything: an address can sit in
            an image, a form, behind a script. Seen, typed, and it is here and in the draft at once.
          */}
          <Group gap="xs" mt="sm" align="end">
            <TextInput
              size="xs"
              w={240}
              label="add an address by hand"
              placeholder="hello@company.com"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              onKeyDown={(event) => event.key === 'Enter' && email.trim() && addContact.mutate()}
            />
            <TextInput
              size="xs"
              w={160}
              label="name, if known"
              placeholder="optional"
              value={contactName}
              onChange={(event) => setContactName(event.currentTarget.value)}
            />
            <Button
              size="xs"
              variant="default"
              disabled={!email.trim()}
              loading={addContact.isPending}
              onClick={() => addContact.mutate()}
            >
              Add
            </Button>
          </Group>

          {/*
            The company verdict. The button stands apart on purpose: it is the only thing on
            the card that costs money, and a person should press it deliberately rather than
            have it fire on opening every studio.
          */}
          <Group gap="xs" mt="lg" align="center">
            <Button
              size="xs"
              variant="light"
              leftSection={<Sparkles size={14} />}
              rightSection={<Kbd size="xs">v</Kbd>}
              loading={askVerdict.isPending}
              onClick={() => askVerdict.mutate()}
            >
              What to write here
            </Button>
            {verdict?.source === 'cache' && (
              <Text size="xs" c="dimmed">
                from cache, the model was not called
              </Text>
            )}
          </Group>

          {verdict && (
            <Alert
              mt="xs"
              p="xs"
              color={verdict.verdict ? (verdict.verdict.skip ? 'yellow' : 'gray') : 'yellow'}
            >
              <Stack gap={6}>
                {/* An empty verdict always explains itself, rule 3 of CLAUDE.md. */}
                {verdict.error && <Text size="xs">{verdict.error}</Text>}

                {verdict.verdict && (
                  <>
                    <Group gap="xs">
                      <Badge color={verdict.verdict.skip ? 'yellow' : 'green'} size="sm">
                        {verdict.verdict.skip ? 'do not write' : (verdict.verdict.template_slug ?? 'no template')}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        confidence {verdict.verdict.confidence}, language {verdict.verdict.language}
                      </Text>
                    </Group>

                    {verdict.verdict.skip
                      ? verdict.verdict.skip_reason && <Text size="xs">{verdict.verdict.skip_reason}</Text>
                      : <Text size="xs">{verdict.verdict.angle}</Text>}

                    <Text size="xs" c="dimmed">
                      {verdict.verdict.why}
                    </Text>

                    {verdict.verdict.contact && (
                      <Text size="xs" c="dimmed">
                        write to: {verdict.verdict.contact}
                      </Text>
                    )}

                    {verdict.verdict.risks.length > 0 && (
                      <Text size="xs" c="dimmed">
                        risks: {verdict.verdict.risks.join('; ')}
                      </Text>
                    )}
                  </>
                )}

                {/*
                  The deterministic choice is always shown alongside. Without it there is no
                  telling whether the model saw something or repeated what the code computes anyway.
                */}
                <Text size="xs" c="dimmed">
                  without the model it would be {verdict.fallbackSlug ?? 'no template'} ({verdict.fallbackTarget})
                </Text>
              </Stack>
            </Alert>
          )}

          <SimilarBlock companyId={card.companyId} />

          <LetterBlock
            company={card.name}
            domain={card.domain}
            kind={card.kind}
            stack={card.techHints}
            contactName={card.contacts.find((contact) => contact.name)?.name ?? null}
            city={card.city}
            country={card.country}
            slug={template}
            onSlug={setTemplate}
            contactEmail={
              card.contacts.find((contact) => contact.name && contact.email)?.email ??
              card.contacts.find((contact) => contact.email)?.email ??
              null
            }
            templateKind="studio"
          />

          <Text size="xs" tt="uppercase" fw={500} c="dimmed" mt="lg" mb="xs" style={{ letterSpacing: '0.04em' }}>
            where the score comes from
          </Text>
          <Stack gap={4}>
            {card.why.map((item) => (
              <Group key={item.reason} gap="sm" wrap="nowrap">
                <Text
                  w={38}
                  ta="right"
                  fw={600}
                  className="tabular"
                  c={item.weight > 0 ? 'green.8' : 'red.8'}
                >
                  {item.weight > 0 ? '+' : ''}
                  {item.weight}
                </Text>
                <Text c="dimmed">{item.reason}</Text>
              </Group>
            ))}
          </Stack>
        </Box>
      </ScrollArea>

      <PaneFooter>
        <Tooltip label="status interesting: the studio stays in this list and shows up in the Companies filter. No letter is sent">
          <Button
            color="green"
            leftSection={<Check size={15} />}
            rightSection={<Kbd size="xs">i</Kbd>}
            onClick={() => onAct({ action: 'interesting' })}
          >
            Interesting
          </Button>
        </Tooltip>
        <Tooltip label="status rejected by me: the studio leaves the list for good but stays in the database">
          <Button
            variant="default"
            leftSection={<ThumbsDown size={15} />}
            rightSection={<Kbd size="xs">n</Kbd>}
            onClick={() => onAct({ action: 'not_interesting' })}
          >
            Not interesting
          </Button>
        </Tooltip>

        <Tooltip label="never show this company again">
          <Button
            color="red"
            variant="light"
            leftSection={<Ban size={15} />}
            rightSection={<Kbd size="xs">b</Kbd>}
            onClick={() => onAct({ action: 'blacklist' })}
          >
            Block
          </Button>
        </Tooltip>
        <Tooltip label="remove from the list for 60 days">
          <Button
            variant="default"
            leftSection={<Clock size={15} />}
            rightSection={<Kbd size="xs">s</Kbd>}
            onClick={() => onAct({ action: 'snooze', days: 60 })}
          >
            Snooze
          </Button>
        </Tooltip>

        <Group gap="xs" ml="auto" wrap="nowrap">
          {/*
            The main path for studios and startups: the letter is built by the same code as
            the nightly preparation and lands on the Outbox page. The "Contacted" button next
            to it stays as a log for letters written by hand elsewhere.
          */}
          <Tooltip label="build a letter draft. If there is no address, crawls the company site first">
            <Button
              variant="light"
              leftSection={<MailPlus size={15} />}
              rightSection={<Kbd size="xs">d</Kbd>}
              loading={toDrafts.isPending}
              onClick={() => toDrafts.mutate()}
            >
              To outbox
            </Button>
          </Tooltip>
          <Tooltip label="visit the site again: careers page, stack, email, contacts, signs of life">
            <Button
              variant="default"
              leftSection={<RefreshCw size={15} />}
              rightSection={<Kbd size="xs">k</Kbd>}
              loading={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              Refresh from site
            </Button>
          </Tooltip>
          <TemplateSelect kind="studio" value={template} onChange={setTemplate} width={240} />
          <Tooltip label="mark the letter as already sent. The record goes to Contacts, a follow-up reminder comes in 7 days">
            <Button
              leftSection={<Send size={15} />}
              rightSection={<Kbd size="xs">e</Kbd>}
              disabled={!template}
              onClick={() =>
              onAct({
                action: 'contacted',
                templateUsed: template,
                // A contact snapshot: a year later Contacts must still show who exactly was written to.
                contactName: card.contacts.find((contact) => contact.name)?.name ?? null,
                contactEmail:
                  card.contacts.find((contact) => contact.name && contact.email)?.email ??
                  card.contacts.find((contact) => contact.email)?.email ??
                  null,
              })
            }
            >
              Contacted
            </Button>
          </Tooltip>
        </Group>
      </PaneFooter>
    </>
  );
}

export interface CompanyListProps {
  /** Empty means everything except product companies. */
  kind?: string;
  emptyTitle?: string;
  emptyHint?: string;
  /** The address section: `#/studios/acme.com` or `#/startups/acme.com`. */
  section?: string;
}

/**
 * Studios and Startups are the same screen over different slices of the database, so the
 * page is parameterised by kind instead of being copied a second time, three hundred lines over.
 */
export function StudiosPage({ kind, emptyTitle, emptyHint, section = 'studios' }: CompanyListProps = {}) {
  const client = useQueryClient();
  const [filters, setFilters] = useState({ q: '', country: '', min: '', all: '', named: '', rating: '' });
  const [filtersOpen, setFiltersOpen] = useState(false);

  /*
   * The open card is a domain in the address, not a position in the list. A position
   * lives only until the next filter: after the search changes the third row is another
   * company, and a link to "the third row" would mean nothing.
   */
  const [domain, select] = useSelection(section);

  /*
   * Search waits until typing stops. Without that every key press is a separate request,
   * and a request here is not cheap: the score is computed over the whole database, and
   * the word "design" would mean six full passes instead of one.
   */
  const [search] = useDebouncedValue(filters.q, 300);
  const query = useMemo(
    () => ({ ...filters, q: search, ...(kind ? { kind } : {}) }),
    [filters, search, kind],
  );

  const { data, error, isLoading } = useQuery({
    queryKey: ['studios', query],
    queryFn: () => api.studios(query),
  });

  const act = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown>; name: string }) =>
      api.companyAction(id, body),
    onSuccess: (_result, { name }) => {
      notifications.show({ color: 'green', title: name, message: 'saved' });
      void client.invalidateQueries({ queryKey: ['studios'] });
      void client.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (mutationError) =>
      notifications.show({ color: 'red', title: 'not saved', message: String(mutationError) }),
  });

  const cards = data?.cards ?? [];

  /*
   * The company from the address may be missing from the current slice: the owner came
   * from a link and a filter hides it, or they just pressed "not interesting" and it left
   * the list. Then the first one opens, and the address follows it.
   */
  const index = Math.max(0, cards.findIndex((card) => card.domain === domain));
  const current = cards[index];

  useEffect(() => {
    if (!current) return;
    if (current.domain !== domain) select(current.domain);
  }, [current, domain, select]);

  const step = (delta: number) => {
    const next = cards[Math.min(Math.max(index + delta, 0), cards.length - 1)];
    if (next) select(next.domain);
  };

  useHotkeys(
    useMemo(
      () => ({
        j: () => step(1),
        arrowdown: () => step(1),
        k: () => step(-1),
        arrowup: () => step(-1),
      }),
      [cards, index],
    ),
    cards.length > 0,
  );

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Could not read the studio list">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  return (
    <SplitView
      listWidth={368}
      list={
        <>
          <PaneHeader>
            <TextInput
              placeholder="name, domain or tag"
              leftSection={<Search size={14} />}
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.currentTarget.value })}
              style={{ flex: 1 }}
            />
            <Button
              variant={filtersOpen ? 'light' : 'subtle'}
              onClick={() => setFiltersOpen((value) => !value)}
              px="sm"
            >
              Filters
            </Button>
          </PaneHeader>

          {filtersOpen && (
            <Stack gap="sm" p="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
              <Group gap="sm" grow>
                <TextInput
                  label="Country"
                  placeholder="UA"
                  value={filters.country}
                  onChange={(event) => setFilters({ ...filters, country: event.currentTarget.value })}
                />
                <NumberInput
                  label="Min score"
                  placeholder={String(data?.threshold ?? 5)}
                  value={filters.min}
                  onChange={(value) => setFilters({ ...filters, min: value === '' ? '' : String(value) })}
                />
              </Group>
              <NumberInput
                label="Min catalog rating"
                description="companies without a rating are hidden"
                placeholder="4.5"
                step={0.1}
                min={0}
                max={5}
                value={filters.rating}
                onChange={(value) => setFilters({ ...filters, rating: value === '' ? '' : String(value) })}
              />
              <Checkbox
                label="show those already contacted"
                checked={filters.all === '1'}
                onChange={(event) => setFilters({ ...filters, all: event.currentTarget.checked ? '1' : '' })}
              />
              {/* The main working filter: a letter to hello@ is read by a manager, not a tech lead. */}
              <Checkbox
                label="only with a named contact"
                checked={filters.named === '1'}
                onChange={(event) =>
                  setFilters({ ...filters, named: event.currentTarget.checked ? '1' : '' })
                }
              />
            </Stack>
          )}

          <Group px="md" py={8} gap="xs" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
            {/* The gap between total and aboveThreshold is the key number here: without it a
                short list reads as broken collection, although the database is full. */}
            <Text size="xs" c="dimmed">
              {data ? `${cards.length} of ${data.total} companies` : 'loading'}
              {data && data.total > data.aboveThreshold && (
                <Tooltip label="the threshold can be changed on the Rules page">
                  <Text span c="dimmed">
                    {' '}
                    · threshold {data.threshold} hid {data.total - data.aboveThreshold}
                  </Text>
                </Tooltip>
              )}
            </Text>
            {/*
              Export through a plain link rather than fetch: the browser saves the file itself
              from the content-disposition header, with no blob juggling.
            */}
            <Anchor
              href={`/api/export/studios${filters.named === '1' ? '?named=1' : ''}`}
              size="xs"
              ml="auto"
              download
            >
              CSV
            </Anchor>
            <Text size="xs" c="dimmed">
              <Kbd size="xs">j</Kbd> <Kbd size="xs">k</Kbd> navigate
            </Text>
          </Group>

          <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            {isLoading &&
              Array.from({ length: 8 }, (_, position) => <Skeleton key={position} h={72} m="md" />)}
            {cards.map((card, position) => (
              <Row
                key={card.companyId}
                card={card}
                active={position === index}
                onSelect={() => select(card.domain)}
              />
            ))}
          </ScrollArea>
        </>
      }
      detail={
        current ? (
          <Detail
            key={current.companyId}
            card={current}
            onAct={(body) => act.mutate({ id: current.companyId, body, name: current.name })}
          />
        ) : (
          <Box p="xl" style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EmptyState
              icon={<Palette size={28} />}
              withIndicatorBackground
              title={isLoading ? 'Loading the catalog' : (emptyTitle ?? 'Nothing matches these filters')}
              description={
                emptyHint ??
                'Lower the minimum score or collect more catalog pages with the browser extension.'
              }
            />
          </Box>
        )
      }
    />
  );
}
