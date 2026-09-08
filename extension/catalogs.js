/**
 * Каталоги, де живуть студії і агенції. Використовується попапом як швидкі посилання.
 *
 * Кожне посилання перевірене відкриттям у справжньому браузері 4 вересня 2026.
 * Каталоги переписують свої URL і не ставлять редіректів, тому мертві посилання тут
 * зʼявляються самі собою. Перед тим як додати нове, відкрий його і подивись на заголовок:
 * Clutch і GoodFirms на неіснуючий шлях віддають 404, а не редірект на список.
 *
 * Прибрані з попередньої версії:
 *   clutch.co/agencies/web-design        404, правильний шлях це /web-designers
 *   clutch.co/ua/kyiv/web-developers     404, міських сторінок у такому вигляді немає
 *   clutch.co/web-developers?employees=  параметр нічого не фільтрує, віддає ті самі 95 675
 *   goodfirms.co/directory/services/...  404
 *   goodfirms.co/directory/platform/...  404 для react-js
 *   upcity.com/web-design/agencies       не відкривається, правильний шлях це /web-design
 *   jobs.dou.ua/companies/?business=...  список DOU не показує сайтів компаній, тому
 *                                        збір із нього давав нуль збережених: усе
 *                                        відсіювалось як "немає домену". DOU береться
 *                                        серверним каталогом, `pnpm cli catalog:dou`,
 *                                        він заходить у профіль і бере сайт звідти
 */
const JOB_RADAR_CATALOGS = [
  {
    group: 'Дизайн-студії',
    links: [
      ['Clutch, web design', 'https://clutch.co/web-designers'],
      ['DesignRush, web design', 'https://www.designrush.com/agency/website-design-development'],
      ['GoodFirms, web design', 'https://www.goodfirms.co/directory/platforms/top-web-design-companies'],
      ['UpCity, web design', 'https://upcity.com/web-design'],
    ],
  },
  {
    group: 'Веб-розробка',
    links: [
      ['Clutch', 'https://clutch.co/web-developers'],
      ['GoodFirms', 'https://www.goodfirms.co/companies/web-development-agency'],
      ['DesignRush', 'https://www.designrush.com/agency/web-development-companies'],
      ['Sortlist', 'https://www.sortlist.com/web-development'],
      ['The Manifest', 'https://themanifest.com/web-development/companies'],
      ['TechBehemoths', 'https://techbehemoths.com/companies/web-development'],
    ],
  },
  {
    group: 'Україна і поблизу',
    links: [
      ['Clutch, Україна', 'https://clutch.co/ua/web-developers'],
      ['Clutch, Польща', 'https://clutch.co/pl/web-developers'],
      ['Clutch, Німеччина', 'https://clutch.co/de/web-developers'],
      ['GoodFirms, Україна', 'https://www.goodfirms.co/companies/web-development-agency/ua'],
      ['DesignRush, Україна', 'https://www.designrush.com/agency/web-development-companies/ua'],
    ],
  },
];
