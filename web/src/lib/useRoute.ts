import { useEffect, useState } from 'react';
import { href, parse } from './route';

/**
 * The current address and moving along it. A thin wrapper over `hashchange`: all the
 * parsing lives in `route.ts` so that a test can cover it without a browser.
 */
export function useRoute(): {
  segments: string[];
  /** Navigation. `replace` adds no history entry: for tidying up the address. */
  go: (segments: string[], replace?: boolean) => void;
} {
  const [segments, setSegments] = useState(() => parse(window.location.hash));

  useEffect(() => {
    const listen = () => setSegments(parse(window.location.hash));
    window.addEventListener('hashchange', listen);
    return () => window.removeEventListener('hashchange', listen);
  }, []);

  const go = (next: string[], replace = false) => {
    const target = href(...next);
    if (target === window.location.hash) return;

    if (replace) {
      window.history.replaceState(null, '', target);
      setSegments(parse(target));
      return;
    }

    // Assigning the hash raises hashchange by itself, so the listener updates the state.
    window.location.hash = target;
  };

  return { segments, go };
}

/**
 * The list selection, kept in the address: `#/studios/acme.com`, `#/templates/pitch`.
 *
 * Navigation here is always `replace`, deliberately. Moving through a list is a cursor,
 * not navigation: with the arrows and j/k keys people go through dozens of items, and a
 * separate history entry per step would mean the back button leads to the previous card
 * thirty times over instead of leaving the section. Back should return where you came
 * from, not rewind the browsing.
 */
export function useSelection(section: string): [string | null, (key: string | null) => void] {
  const { segments, go } = useRoute();
  const selected = segments[0] === section ? (segments[1] ?? null) : null;

  return [selected, (key: string | null) => go(key ? [section, key] : [section], true)];
}
