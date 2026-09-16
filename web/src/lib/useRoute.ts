import { useEffect, useState } from 'react';
import { href, parse } from './route';

/**
 * Поточна адреса і перехід по ній. Тонка обгортка над `hashchange`: уся логіка
 * розбору живе в `route.ts`, щоб її можна було перевірити тестом без браузера.
 */
export function useRoute(): {
  segments: string[];
  /** Перехід. `replace` не додає запис в історію: для наведення ладу в адресі. */
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

    // Присвоєння хешу саме породжує hashchange, тому стан оновить слухач.
    window.location.hash = target;
  };

  return { segments, go };
}

/**
 * Вибране в списку, що живе в адресі: `#/studios/acme.com`, `#/templates/pitch`.
 *
 * Перехід тут завжди `replace`, і це навмисно. Рух по списку це курсор, а не
 * навігація: стрілками і клавішами j/k через нього проходять десятками, і кожен
 * крок окремим записом в історії означав би, що кнопка "назад" тридцять разів
 * веде на попередню картку замість того, щоб вивести з розділу. Назад має
 * повертати туди, звідки прийшов, а не відмотувати перегляд.
 */
export function useSelection(section: string): [string | null, (key: string | null) => void] {
  const { segments, go } = useRoute();
  const selected = segments[0] === section ? (segments[1] ?? null) : null;

  return [selected, (key: string | null) => go(key ? [section, key] : [section], true)];
}
