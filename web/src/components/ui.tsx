import type { ReactNode } from 'react';
import { Badge, Box, Group, Paper, SimpleGrid, Text, ThemeIcon, Title, Tooltip } from '@mantine/core';
import {
  Box as BoxIcon,
  Briefcase,
  Building2,
  CalendarClock,
  CircleHelp,
  Gauge,
  Globe,
  Landmark,
  LockOpen,
  Palette,
  PenTool,
  Rocket,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Store,
  TrendingUp,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ListCard } from '../lib/api';

/*
 * The small building blocks of direction B (docs/DESIGN.md). Each is a composition of Mantine
 * parts with the project tokens, not a replacement for a Mantine component.
 */

/** Tiny uppercase monospace meta label. */
export function MonoLabel({ children, c }: { children: ReactNode; c?: string }) {
  return (
    <Text component="span" className="mono-label" c={c} display="block">
      {children}
    </Text>
  );
}

/**
 * The top of a page: a heavy title with its icon over the faint dotted grid, an optional line under
 * it, and the page actions on the right.
 */
export function PageHeader({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Box className="dotted" px="lg" pt="lg" pb="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
      <Group justify="space-between" align="flex-end" wrap="nowrap" gap="md">
        <Box style={{ minWidth: 0 }}>
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={32} color="ink" variant="default" style={{ background: '#fff' }}>
              <Icon size={18} strokeWidth={1.75} />
            </ThemeIcon>
            <Title order={2} style={{ whiteSpace: 'nowrap' }}>
              {title}
            </Title>
          </Group>
          {description && (
            <Text size="sm" c="gray.7" mt={6}>
              {description}
            </Text>
          )}
        </Box>
        {children && (
          <Group gap="xs" wrap="nowrap">
            {children}
          </Group>
        )}
      </Group>
    </Box>
  );
}

/** A section title inside a page or card: a round tinted icon and a heavy title. */
export function SectionHeader({
  icon: Icon,
  title,
  color = 'gray',
  right,
}: {
  icon: LucideIcon;
  title: ReactNode;
  color?: string;
  right?: ReactNode;
}) {
  return (
    <Group justify="space-between" gap="sm" mb="sm" wrap="nowrap">
      <Group gap={10} wrap="nowrap">
        <ThemeIcon size={28} color={color}>
          <Icon size={16} strokeWidth={1.75} />
        </ThemeIcon>
        <Text className="display" fz={16}>
          {title}
        </Text>
      </Group>
      {right}
    </Group>
  );
}

export interface StatItem {
  label: string;
  value: ReactNode;
  hint?: string;
  color?: string;
}

/** The stat strip: a mono caption over a big number, one cell each. */
export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <SimpleGrid cols={{ base: 2, sm: items.length }} spacing="sm">
      {items.map((item) => (
        <Tooltip key={item.label} label={item.hint} disabled={!item.hint} multiline maw={260}>
          <Paper px="md" py="sm">
            <MonoLabel>{item.label}</MonoLabel>
            <Text className="display tabular" fz={28} lh={1.15} mt={4} c={item.color}>
              {item.value}
            </Text>
          </Paper>
        </Tooltip>
      ))}
    </SimpleGrid>
  );
}

/** Segment accents and icons, one per segment, never mixed on one element. */
export const SEGMENTS: Record<string, { label: string; color: string; icon: LucideIcon }> = {
  studio: { label: 'studio', color: '#7c3aed', icon: PenTool },
  design: { label: 'design studio', color: '#db2777', icon: Palette },
  startup: { label: 'startup', color: '#16a34a', icon: Rocket },
  product: { label: 'product', color: '#0d9488', icon: BoxIcon },
  outstaff: { label: 'outstaffing', color: '#475569', icon: Users },
  smb: { label: 'business', color: '#ea580c', icon: Store },
  ecommerce: { label: 'store', color: '#d97706', icon: ShoppingCart },
  public: { label: 'public body', color: '#2563eb', icon: Landmark },
  unknown: { label: 'unknown kind', color: '#737373', icon: CircleHelp },
};

export function SegmentBadge({ kind, size = 'sm' }: { kind: string; size?: 'xs' | 'sm' | 'md' }) {
  const segment = SEGMENTS[kind] ?? { label: kind, color: '#737373', icon: Building2 };
  const Icon = segment.icon;
  return (
    <Badge
      variant="outline"
      size={size}
      color={segment.color}
      leftSection={<Icon size={11} strokeWidth={2} />}
      style={{ flexShrink: 0 }}
    >
      {segment.label}
    </Badge>
  );
}

export interface Reason {
  label: string;
  icon: LucideIcon;
  color: string;
}

/** The icon of one audit issue. Issues are letter-ready phrases in Ukrainian or English. */
export function issueIcon(issue: string): LucideIcon {
  if (/mobile|мобільн/i.test(issue)) return Smartphone;
  if (/https/i.test(issue)) return LockOpen;
  if (/copyright/i.test(issue)) return CalendarClock;
  return Gauge;
}

/**
 * Why write to this company, as chips, most convincing first. Read from the score breakdown,
 * so a chip never claims something the score did not count.
 */
export function reasons(card: Pick<ListCard, 'why' | 'audit' | 'hiring' | 'hiringRoles'>): Reason[] {
  const out: Reason[] = [];
  const positive = card.why.filter((item) => item.weight > 0);

  const tender = positive.find((item) => item.reason.startsWith('open tender'));
  if (tender) out.push({ label: tender.reason.replace(/^open tender: /, 'tender: '), icon: Landmark, color: 'brand' });

  for (const issue of card.audit?.issues ?? []) out.push({ label: issue, icon: issueIcon(issue), color: 'red' });

  if (positive.some((item) => item.reason === 'no site')) out.push({ label: 'no site', icon: Globe, color: 'red' });

  if (card.hiring) {
    out.push({
      label: card.hiringRoles ? `hiring ${card.hiringRoles} developers` : 'hiring developers',
      icon: Briefcase,
      color: 'green',
    });
  }

  const named = positive.find((item) => item.reason.startsWith('named contact'));
  if (named) out.push({ label: named.reason, icon: UserRound, color: 'gray' });

  /*
   * Nothing specific: the strongest plus of the score that says something about the work, so the
   * row still says why it is here. Size, segment and country only say who they are.
   */
  const telling = positive.find((item) => !/^(size |kind: |country |model fit)/.test(item.reason));
  if (out.length === 0 && telling) out.push({ label: telling.reason, icon: TrendingUp, color: 'gray' });

  return out;
}

export function ReasonChip({ reason, maw = 320 }: { reason: Reason; maw?: number }) {
  const Icon = reason.icon;
  return (
    <Tooltip label={reason.label} multiline maw={360} openDelay={500}>
      <Badge
        color={reason.color}
        size="md"
        leftSection={<Icon size={12} strokeWidth={2} />}
        maw={maw}
        styles={{ label: { overflow: 'hidden', textOverflow: 'ellipsis' } }}
      >
        {reason.label}
      </Badge>
    </Tooltip>
  );
}

/*
 * The model's fit read (src/pipeline/fit.ts). Keys come from config/fit.json; these are the short
 * names a row has room for. A key missing here shows as stored.
 */
export const FIT_SERVICES: Record<string, string> = {
  website: 'website',
  mvp: 'MVP',
  ai: 'AI features',
  automation: 'automation',
  optimization: 'optimization',
  white_label: 'white-label',
};

export const FIT_STAGES: Record<string, string> = {
  idea: 'idea stage',
  early: 'early stage',
  growth: 'growth stage',
  established: 'established',
};

export const FIT_LEVELS = [
  { value: 'no', label: 'no', color: 'red', min: 0 },
  { value: 'unlikely', label: 'unlikely', color: 'gray', min: 33 },
  { value: 'possible', label: 'possible', color: 'brand', min: 67 },
  { value: 'likely', label: 'likely', color: 'green', min: 100 },
] as const;

/** The stored 0 to 100 back into its level, the same rounding as the server. */
export function fitLevel(fit: number | null) {
  if (fit === null) return null;
  const index = Math.min(Math.max(Math.round((fit / 100) * 3), 0), 3);
  return FIT_LEVELS[index]!;
}

/** "likely · MVP": would they buy, and what. Nothing at all until the model was asked. */
export function FitBadge({ fit, service, size = 'md' }: { fit: number | null; service?: string | null; size?: 'sm' | 'md' }) {
  const level = fitLevel(fit);
  if (!level) return null;
  const label = service ? `${level.label} · ${FIT_SERVICES[service] ?? service}` : level.label;
  return (
    <Tooltip label="the model's read: would this company pay an outside developer, and for what" multiline maw={280}>
      <Badge color={level.color} size={size} leftSection={<Sparkles size={11} />} style={{ flexShrink: 0 }}>
        {label}
      </Badge>
    </Tooltip>
  );
}
