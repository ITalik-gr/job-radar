import { useQuery } from '@tanstack/react-query';
import { Anchor, Badge, Box, Group, Text } from '@mantine/core';
import { api } from '../lib/api';

/**
 * Схожі компанії за описом, а не за тегами.
 *
 * Навіщо: коли власник знайшов студію, якій варто написати, найдешевший спосіб
 * знайти ще таких це не перебирати теги руками, а взяти сусідів за змістом опису.
 *
 * Блок мовчить, якщо векторів ще немає: порожній заголовок "Схожі" без списку
 * виглядав би як поломка, хоча просто не запускали розрахунок.
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
        схожі за описом
      </Text>
      <Group gap={6}>
        {data.map((item) => (
          <Badge
            key={item.companyId}
            color="gray"
            style={{ cursor: onSelect ? 'pointer' : 'default' }}
            onClick={() => onSelect?.(item.companyId)}
            title={`близькість ${item.similarity}`}
          >
            {item.name}
          </Badge>
        ))}
      </Group>
      <Text size="xs" c="dimmed" mt={6}>
        Порахувала модель за описом і стеком. Якщо ця студія підійшла, ці теж варті листа.
      </Text>
    </Box>
  );
}
