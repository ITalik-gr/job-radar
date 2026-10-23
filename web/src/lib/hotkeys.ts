import { useEffect } from 'react';

/**
 * Hotkeys for working through the lead list. The owner goes over a dozen cards a day,
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
      // Enter on a focused button or link is that control's own click, not a list shortcut.
      if (event.key === 'Enter' && (tag === 'BUTTON' || tag === 'A')) return;
      // Inside an open drawer or modal the page shortcuts stay quiet.
      if (target?.closest('[role="dialog"]')) return;

      const handler = map[event.key.toLowerCase()];
      if (!handler) return;
      event.preventDefault();
      handler();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [map, enabled]);
}
