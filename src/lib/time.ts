import { config } from '../config.js';

/** The calendar day in the owner's time zone as YYYY-MM-DD. */
export function localDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

interface LocalClock {
  hour: number;
  /** 0 is Sunday, as in Date.getDay. */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localClock(date: Date): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date);

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const weekday = WEEKDAYS.indexOf(parts.find((part) => part.type === 'weekday')?.value ?? 'Mon');
  // Intl returns 24 instead of 0 at midnight, and without this the night check silently breaks.
  return { hour: hour === 24 ? 0 : hour, weekday };
}
