import { useEffect, useState } from 'react';
import { href, hrefWith, ownsAddress, parse, parseQuery } from './route';

/** Raised after a replace, so every mounted `useRoute` sees it: replaceState raises nothing itself. */
const REPLACED = 'radar:route';

/*
 * The address before the last hash change. A plain link to a company (from a tender, a draft)
 * makes a history entry with no state, and this is how the company page still knows it came
 * from inside the app and that back can be a history back.
 */
let previousHash: string | null = null;
window.addEventListener('hashchange', (event) => {
  previousHash = new URL(event.oldURL).hash || null;
});

export function lastHash(): string | null {
  return previousHash;
}

/** Replaces the address without a history entry, keeping the entry's state (where it came from). */
export function replaceHash(target: string): void {
  window.history.replaceState(window.history.state, '', target);
  window.dispatchEvent(new Event(REPLACED));
}

/**
 * The current address and moving along it. A thin wrapper over `hashchange`: all the
 * parsing lives in `route.ts` so that a test can cover it without a browser.
 */
export function useRoute(): {
  segments: string[];
  /** The list state after `?` in the hash. */
  query: Record<string, string>;
  /** Navigation. `replace` adds no history entry: for tidying up the address. */
  go: (segments: string[], replace?: boolean) => void;
  /**
   * Changes the list state in place, without a history entry: typing a filter is not a step the
   * back button should walk through letter by letter.
   */
  setQuery: (patch: Record<string, string | undefined>) => void;
} {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const listen = () => setHash(window.location.hash);
    window.addEventListener('hashchange', listen);
    // pushState and history.back between two of our own entries raise popstate, not always hashchange.
    window.addEventListener('popstate', listen);
    window.addEventListener(REPLACED, listen);
    return () => {
      window.removeEventListener('hashchange', listen);
      window.removeEventListener('popstate', listen);
      window.removeEventListener(REPLACED, listen);
    };
  }, []);

  const segments = parse(hash);
  const query = parseQuery(hash);

  const go = (next: string[], replace = false) => {
    const target = href(...next);
    if (target === window.location.hash) return;

    if (replace) {
      replaceHash(target);
      return;
    }

    // Assigning the hash raises hashchange by itself, so the listener updates the state.
    window.location.hash = target;
  };

  const setQuery = (patch: Record<string, string | undefined>) => {
    const current = window.location.hash;
    const target = hrefWith(parse(current), { ...parseQuery(current), ...patch });
    if (target === current) return;
    replaceHash(target);
  };

  return { segments, query, go, setQuery };
}

/**
 * The list selection, kept in the address: `#/templates/pitch`.
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

  return [
    selected,
    (key: string | null) => {
      // The address may already belong to another section the owner just switched to.
      if (!ownsAddress(window.location.hash, section)) return;
      go(key ? [section, key] : [section], true);
    },
  ];
}
