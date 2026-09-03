# Деплой на Cloudflare

Мета: радар працює без запущеного ноута, доступний з телефона, cron не залежить від сну.

Один воркер віддає і API, і фронт. База це D1. Планувальник це Cron Triggers.

## Якщо білд висить

Дивитись, на якому етапі він став, це різні хвороби.

**Висить на `Installing`** це компіляція `better-sqlite3` через node-gyp. Лікується
прапорцем `--ignore-scripts`, він уже стоїть і в воркфлоу, і в Build command.

**Висить на `Initializing`** (до `Cloning`, у логах лише `Initializing build environment...`)
це не репозиторій: код на той момент навіть не завантажений, тому змінювати в ньому
нічого не треба. У Cloudflare це означає зіпсований build token, див. розділ
"Workers Builds" нижче. Саме через це викатка переїхала в GitHub Actions.

## Найчастіша помилка на проді

`Failed query: select ... params:` на будь-якому запиті означає, що **у віддаленій базі немає
таблиць**. Міграції треба застосувати окремо, деплой воркера їх не запускає.

```bash
pnpm wrangler d1 migrations apply job-radar --remote
pnpm cf:doctor https://job-radar.example.workers.dev/ --token <RADAR_TOKEN>
```

`doctor` покаже, які таблиці є, яких бракує і що робити. Те саме віддає
`GET /api/health?deep=1`, він доступний без токена.

Перевірити напряму:

```bash
pnpm wrangler d1 execute job-radar --remote --command "select name from sqlite_master where type='table'"
```

Має бути 10 таблиць: companies, company_state, contacts, llm_cache, llm_usage, outreach,
queue_items, runs, snapshots, vacancies.

## Один раз

```bash
pnpm wrangler login

# 1. База
pnpm wrangler d1 create job-radar
# у відповіді буде database_id, вписати його у wrangler.jsonc

# 2. Секрети
pnpm wrangler secret put RADAR_TOKEN          # вигадати довгий рядок, це пароль до радара
pnpm wrangler secret put ANTHROPIC_API_KEY
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm wrangler secret put TELEGRAM_CHAT_ID

# 3. Схема бази
pnpm cf:migrate

# 4. Викатка
pnpm deploy
```

Після викатки воркер живе на `https://job-radar.example.workers.dev`.

## Деплой на пуш, GitHub Actions

Основний шлях. Файл `.github/workflows/deploy.yml`, спрацьовує на пуш у `main`
і кнопкою Run workflow. Кроки: встановити залежності без скриптів, перевірити типи
(бекенд і фронт), зібрати фронт, `wrangler deploy`.

Типи перевіряються до викатки навмисно: воркер один і він же прод, зламану збірку
дешевше зупинити в CI.

**Що треба задати один раз** у GitHub, Settings, Secrets and variables, Actions:

| секрет | де взяти |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com, My Profile, API Tokens, шаблон **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | `pnpm wrangler whoami`, колонка Account ID |

Токен має покривати Workers Scripts (edit), Workers KV (edit), D1 (edit) і Account
Settings (read). Шаблон Edit Cloudflare Workers дає це все.

**Чому `--ignore-scripts`:** у залежностях є `better-sqlite3`, нативний драйвер для локальної
роботи. У CI він компілюється через node-gyp, це кілька хвилин або взагалі зависання,
а воркеру він не потрібен: там база це D1. З цим прапорцем збірка займає секунди.

Важливо: **міграції D1 у цей ланцюжок не входять,** і це свідомо. Застосовувати схему
автоматично на кожен пуш небезпечно. Після зміни схеми (тобто після `pnpm db:generate`)
треба один раз виконати з ноута:

```bash
pnpm wrangler d1 migrations apply job-radar --remote
```

## Workers Builds, вбудований білдер Cloudflare

Другий шлях, зараз не використовується. Він зависав на `Initializing build environment...`
і далі не йшов. Етап `Initializing` це видача білд-раннера, репо на той момент ще
не клоноване, тому причина завжди на стороні Cloudflare, а не в коді. За документацією
це буває, коли **build token видалено або перевипущено**: у налаштуваннях білда лишається
посилання на токен, якого вже немає.

Якщо колись вертатись до нього:

1. Дашборд, Workers and Pages, воркер `job-radar`, Settings, Build
2. Перевірити, що імʼя воркера в дашборді збігається з `name` у `wrangler.jsonc`, тобто `job-radar`
3. У полі Build token створити **новий** токен і вибрати його, старий не переобирати
4. Якщо не допомогло, видалити і поставити наново інтеграцію з GitHub

| поле | значення |
| --- | --- |
| Build command | `pnpm install --frozen-lockfile --ignore-scripts && pnpm build:web` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Build variables | не потрібні, секрети живуть окремо |

Тримати обидва шляхи ввімкненими не варто: на кожен пуш буде дві викатки,
і остання за часом не обовʼязково новіша за комітом.

Секрети (`RADAR_TOKEN`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
задаються один раз через `wrangler secret put` або в дашборді, Settings, Variables and Secrets.
Вони не в репозиторії і не перезаписуються деплоєм.

## Корисні команди

| команда | що робить |
| --- | --- |
| `pnpm deploy` | зібрати фронт і викотити (з ноута) |
| `pnpm cf:migrate` | застосувати міграції до віддаленої бази |
| `pnpm cf:migrate:local` | те саме для локальної D1 (`wrangler dev`) |
| `pnpm cf:dev` | воркер локально на справжньому D1, порт 8787 |
| `pnpm cf:tail` | живі логи проду |
| `pnpm cf:doctor <url> --token <token>` | перевірка бази і роутів на проді |

## Перший вхід

Відкрити `https://job-radar.example.workers.dev/?token=<RADAR_TOKEN>`.
Токен збережеться в браузері, далі заходити можна без нього. На телефоні так само.

Без токена API віддає 401. Це єдиний захист, і його досить для інструмента на одну людину,
але токен не можна класти в публічні місця.

## Розширення

У попапі розширення вписати:

- **адреса радара**: `https://job-radar.example.workers.dev`
- **токен**: той самий `RADAR_TOKEN`

Далі збирач шле компанії прямо в хмару, локальний сервер більше не потрібен.

## Телеграм

Команди бота на Workers працюють через вебхук, полінгу там немає:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://job-radar.example.workers.dev/api/telegram/webhook"
```

Сповіщення за розкладом (дайджест, фолоу-апи, алерти) працюють і без вебхука.

## Перенести локальну базу в D1

`sqlite3 .dump` не годиться: він містить `CREATE TABLE`, які конфліктують із уже застосованими
міграціями. Тому є окрема команда, яка віддає тільки дані:

```bash
# тільки компанії і листування, це головне, близько 400 КБ
pnpm cli export:sql /tmp/data.sql --tables companies,company_state,contacts,outreach
pnpm wrangler d1 execute job-radar --remote --file=/tmp/data.sql
```

Повний експорт разом із вакансіями і снапшотами важить близько 13 МБ, це вже впирається
в ліміти одного `d1 execute`. Вакансії простіше зібрати наново кнопкою "Оновити вакансії",
вони й так оновлюються кожні 6 годин.

Або почати з чистої бази: розширення, кнопка "Зібрати DOU" і "Знайти career-сторінки"
наповнять її за вечір.

## Що лишилось локальним

- `pnpm cli` працює тільки з локальною базою. Для хмарної версії дії доступні кнопками в інтерфейсі
- Playwright, якщо колись знадобиться, на Workers не запуститься. Це буде окремий локальний обхід
- Ліміт CPU на запит: важкі прогони (`source:sync` по сотнях компаній) краще залишати cron-у,
  який ділить роботу на окремі запуски

## Скільки це коштує

Free plan: 100 тисяч запитів на добу, 5 мільйонів рядків читання з D1 на добу, cron кожні кілька годин.
Для одного користувача це безкоштовно. Платить тільки Anthropic API за класифікацію.
