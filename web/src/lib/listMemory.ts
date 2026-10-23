import { useEffect, useLayoutEffect, useRef } from 'react';
import { companyHref } from './route';
import { replaceHash } from './useRoute';

/*
 * List first, details on demand (docs/DESIGN.md): a company opens as its own page, and back
 * returns to the exact place. What makes "the exact place":
 *
 * - the list state is in the address (filters, tab), see `useRoute().query`
 * - the company entry remembers the list address it was opened from, in `history.state`, so
 *   back is a plain history back when there is history, and the list address when there is not
 *   (a link from a draft, a bookmark, a reload)
 * - the list's scroll position and the keys of its rows are kept per list address in session
 *   storage, so the list restores its scroll and highlights the row that was opened, and the
 *   company page can walk the same list with J and K
 *
 * Session storage, not local: this is the state of one working session, and a stale scroll from
 * last week would be a surprise, not a convenience.
 */

interface Remembered {
  /** Row keys in list order, for next and previous on the company page. */
  keys: string[];
  /** The last opened row, highlighted and focused on return. */
  opened?: string;
  scrollTop?: number;
}

const PREFIX = 'list:';

function read(list: string): Remembered | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + list);
    return raw ? (JSON.parse(raw) as Remembered) : null;
  } catch {
    return null;
  }
}

function write(list: string, patch: Partial<Remembered>): void {
  try {
    const next = { keys: [], ...read(list), ...patch };
    sessionStorage.setItem(PREFIX + list, JSON.stringify(next));
  } catch {
    // Blocked storage only means back does not restore the scroll.
  }
}

export interface CompanyEntryState {
  /** The list address this company was opened from. */
  from?: string;
  /** The letter drawer entry, so closing it is a history back rather than a new entry. */
  letter?: boolean;
}

export function entryState(): CompanyEntryState {
  return (window.history.state as CompanyEntryState | null) ?? {};
}

/**
 * Opens a company page from a list. The list's scroll container, if given, is saved first.
 * The keys are the rows currently shown, so J and K on the company page walk the same list.
 */
export function openCompany(key: string, keys: string[], scroller?: HTMLElement | null): void {
  const from = window.location.hash || '#/';
  write(from, { keys, opened: key, scrollTop: scroller?.scrollTop ?? 0 });
  window.history.pushState({ from } satisfies CompanyEntryState, '', companyHref(key));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Back from a company page: history back when the entry came from a list, else the fallback list. */
export function leaveCompany(fallback = '#/companies'): void {
  const { from } = entryState();
  if (from) {
    window.history.back();
    return;
  }
  window.location.hash = fallback;
}

/** The list a company page was opened from, with its rows, for next and previous. */
export function originList(): { from: string; keys: string[] } | null {
  const { from } = entryState();
  if (!from) return null;
  return { from, keys: read(from)?.keys ?? [] };
}

/**
 * Moves the company page to a neighbour in its origin list. A replace, not a new entry: walking
 * twenty cards must not make back walk them again. The origin stays in the entry state.
 */
export function stepCompany(current: string, delta: number): void {
  const origin = originList();
  if (!origin) return;
  const index = origin.keys.indexOf(current);
  const next = origin.keys[index + delta];
  if (index < 0 || !next) return;
  write(origin.from, { opened: next });
  replaceHash(companyHref(next));
}

/**
 * The list side: restores the scroll once rows are on screen, and says which row was opened last.
 * Rows render from the TanStack Query cache on return, so `ready` is true on the first render
 * and the restore happens before the browser paints.
 */
export function useListMemory(
  scroller: React.RefObject<HTMLElement | null>,
  ready: boolean,
): { opened: string | null } {
  const list = window.location.hash || '#/';
  const remembered = useRef(read(list));
  const restored = useRef(false);

  useLayoutEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    const top = remembered.current?.scrollTop;
    if (scroller.current && top) scroller.current.scrollTop = top;
  }, [ready, scroller]);

  // The highlighted row gets focus too, so Enter opens it again and J and K continue from it.
  useEffect(() => {
    if (!ready) return;
    const key = remembered.current?.opened;
    if (!key) return;
    const row = scroller.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    row?.focus({ preventScroll: true });
  }, [ready, scroller]);

  return { opened: remembered.current?.opened ?? null };
}
