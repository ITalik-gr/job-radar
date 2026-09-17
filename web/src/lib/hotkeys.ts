import { useEffect } from 'react';

/**
 * Hotkeys for working through the queue. The owner goes over ten cards a day,
 * and with a mouse that takes three times longer than one hand on the keyboard.
 * They fire only when focus is outside an input and no modifier is held.
 */
export function useHotkeys(map: Record<string, (() => void) | undefined>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

      const handler = map[event.key.toLowerCase()];
      if (!handler) return;
      event.preventDefault();
      handler();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [map, enabled]);
}
