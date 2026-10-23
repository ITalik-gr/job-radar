import { Badge, Tooltip } from '@mantine/core';

/**
 * The score reads as a number: the owner compares values between cards, so the
 * digit is always there and the colour only hints at the zone around the threshold.
 */
export function Score({ value, size = 'md' }: { value: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const score = value ?? 0;
  const color = score >= 12 ? 'green' : score >= 6 ? 'brand' : score <= -50 ? 'red' : 'gray';

  return (
    <Tooltip label="sum of the scoring weights, the breakdown is on the company page">
      <Badge
        color={color}
        size={size}
        className="mono"
        style={{ minWidth: 48, fontWeight: 500, flexShrink: 0 }}
      >
        {score.toFixed(1)}
      </Badge>
    </Tooltip>
  );
}
