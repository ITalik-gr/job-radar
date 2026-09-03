/**
 * Точка реєстрації адаптерів. Порядок реалізації визначений у CLAUDE.md, розділ 4:
 * спочатку ATS з чистим JSON, потім RSS, потім каталоги, потім борди, потім власні
 * career-сторінки. Кожен адаптер додається сюди тільки разом зі smoke-тестом на фікстурі.
 */
import { registerSource } from './registry.js';
import { greenhouse } from './boards/greenhouse.js';
import { lever } from './boards/lever.js';
import { ashby } from './boards/ashby.js';
import { remoteok } from './boards/remoteok.js';
import { rssSources } from './boards/feeds.js';
import { dou } from './catalogs/dou.js';

for (const source of [greenhouse, lever, ashby, remoteok, ...rssSources, dou]) {
  registerSource(source);
}

export { greenhouse, lever, ashby, remoteok, rssSources, dou };
