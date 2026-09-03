import { Badge, Tooltip } from '@mantine/core';

/**
 * Рахунок читається як число: власнику треба порівнювати значення між картками,
 * тому цифра завжди на місці, а колір лише підказує зону відносно порогу.
 */
export function Score({ value, size = 'md' }: { value: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const score = value ?? 0;
  const color = score >= 12 ? 'green' : score >= 6 ? 'brand' : score <= -50 ? 'red' : 'gray';

  return (
    <Tooltip label="сума ваг зі скорингу плюс думка моделі, поділена на 20">
      <Badge color={color} size={size} radius="sm" className="tabular" style={{ minWidth: 44 }}>
        {score.toFixed(1)}
      </Badge>
    </Tooltip>
  );
}
