import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { App } from './App';
import { cssVariables, theme } from './theme';
import './index.css';

const client = new QueryClient({
  /*
   * Data stays fresh for a minute: moving between pages and back to a list renders from the cache
   * at once instead of fetching it again. Writes invalidate what they change.
   */
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 60_000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} cssVariablesResolver={cssVariables} defaultColorScheme="light" forceColorScheme="light">
      <QueryClientProvider client={client}>
        <Notifications position="bottom-right" limit={3} autoClose={3500} />
        <App />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
