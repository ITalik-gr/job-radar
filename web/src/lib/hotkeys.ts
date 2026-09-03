import { useEffect } from 'react';

/**
 * Гарячі клавіші для розбору черги. Власник проходить десять карток щодня,
 * і мишею це виходить утричі довше, ніж однією рукою на клавіатурі.
 * Спрацьовують лише коли фокус не в полі введення і не натиснуто модифікатор.
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
