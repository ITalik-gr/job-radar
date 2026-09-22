import { useQuery } from '@tanstack/react-query';
import { Anchor, Badge, Box, Group, Text } from '@mantine/core';
import { api } from '../lib/api';

/**
 * Similar companies by description, not by tags.
 *
 * Why: once the owner has found a studio worth writing to, the cheapest way to
 * find more of them is not sifting through tags by hand but taking the neighbours
 * by the meaning of the description.
 *
 * The block stays silent when there are no vectors yet: an empty "Similar" heading
 * with no list would look like a fault, when in fact nobody ran the calculation.
 */
export function SimilarBlock({ companyId, onSelect }: { companyId: number; onSelect?: (id: number) => void }) {
  const { data } = useQuery({
    queryKey: ['similar', companyId],
    queryFn: () => api.similar(companyId),
  });

  if (!data || data.length === 0) return null;

  return (
    <Box mt="lg">
      <Text size="xs" tt="uppercase" fw={500} c="dimmed" mb="xs" style={{ letterSpacing: '0.04em' }}>
        similar by description
      </Text>
      <Group gap={6}>
        {data.map((item) => (
          <Badge
            key={item.companyId}
            color="gray"
            style={{ cursor: onSelect ? 'pointer' : 'default' }}
            onClick={() => onSelect?.(item.companyId)}
            title={`closeness ${item.similarity}`}
          >
            {item.name}
          </Badge>
        ))}
      </Group>
      <Text size="xs" c="dimmed" mt={6}>
        Computed by the model from the description and the stack. If this studio fits, these are worth a letter too.
      </Text>
    </Box>
  );
}
