import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/*
 * Один колір на всі графіки. Двох серій в одній системі координат тут ніде немає,
 * тому категорійна палета не потрібна, а синій #2a78d6 проходить контраст на білому.
 * Значення підписані прямо на марках, підказка при наведенні лишається для тих
 * випадків, коли підпис або назва обрізались.
 */
const SERIES = '#2a78d6';
const SERIES_DIM = '#b7d3f6';
const GRID = 'var(--mantine-color-gray-2)';
const AXIS = 'var(--mantine-color-gray-4)';

const tick = { fontSize: 12, fill: 'var(--mantine-color-dimmed)' } as const;

function Hint({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: { value?: number | string }[];
  label?: string | number;
  unit?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: 'var(--mantine-color-body)',
        border: '1px solid var(--mantine-color-gray-3)',
        borderRadius: 'var(--mantine-radius-md)',
        boxShadow: 'var(--mantine-shadow-md)',
        padding: '6px 10px',
        fontSize: 13,
      }}
    >
      <div style={{ color: 'var(--mantine-color-dimmed)' }}>{label}</div>
      <div style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {payload[0]?.value}
        {unit ? ` ${unit}` : ''}
      </div>
    </div>
  );
}

/** Рейтинг: горизонтальні смужки, бо назви технологій і країн не влазять під вертикальні. */
export function RankBars({
  rows,
  unit,
  labelWidth = 104,
  highlight,
}: {
  rows: { label: string; value: number }[];
  unit?: string;
  labelWidth?: number;
  highlight?: (row: { label: string; value: number }) => boolean;
}) {
  // Місце під підпис справа рахуємо з найдовшого значення, інакше шестизначні вилки обрізає.
  const longest = rows.reduce((max, row) => Math.max(max, String(row.value).length), 1);
  const right = 16 + longest * 7.5 + (unit ? unit.length * 7 : 0);

  return (
    <ResponsiveContainer width="100%" height={Math.max(96, rows.length * 26 + 8)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right, bottom: 0, left: 0 }} barCategoryGap={3}>
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={labelWidth}
          tick={tick}
          tickLine={false}
          axisLine={{ stroke: AXIS }}
          interval={0}
        />
        <Tooltip content={<Hint unit={unit} />} cursor={{ fill: 'var(--mantine-color-gray-1)' }} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false}>
          {rows.map((row) => (
            <Cell key={row.label} fill={highlight && !highlight(row) ? SERIES_DIM : SERIES} />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            offset={8}
            style={{
              fontSize: 12,
              fill: 'var(--mantine-color-text)',
              fontVariantNumeric: 'tabular-nums',
            }}
            formatter={(value: unknown) => `${value ?? ''}${unit ? ` ${unit}` : ''}`}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Зміна в часі: заливка під лінією, підказка з вертикальним хрестиком. */
export function TimeSeries({ rows, unit }: { rows: { day: string; count: number }[]; unit?: string }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="jr-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES} stopOpacity={0.18} />
            <stop offset="100%" stopColor={SERIES} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="day" tick={tick} tickLine={false} axisLine={{ stroke: AXIS }} minTickGap={28} />
        <YAxis tick={tick} tickLine={false} axisLine={false} width={38} allowDecimals={false} />
        <Tooltip content={<Hint unit={unit} />} cursor={{ stroke: AXIS, strokeWidth: 1 }} />
        <Area
          type="monotone"
          dataKey="count"
          stroke={SERIES}
          strokeWidth={2}
          fill="url(#jr-area)"
          dot={false}
          activeDot={{ r: 4, fill: SERIES, stroke: 'var(--mantine-color-body)', strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
