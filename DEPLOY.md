# Деплой на Cloudflare

Мета: радар працює без запущеного ноута, доступний з телефона, cron не залежить від сну.

Один воркер віддає і API, і фронт. База це D1. Планувальник це Cron Triggers.

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

Після викатки воркер живе на `https://job-radar.<твій-субдомен>.workers.dev`.

## Перший вхід

Відкрити `https://job-radar.<субдомен>.workers.dev/?token=<RADAR_TOKEN>`.
Токен збережеться в браузері, далі заходити можна без нього. На телефоні так само.

Без токена API віддає 401. Це єдиний захист, і його досить для інструмента на одну людину,
але токен не можна класти в публічні місця.

## Розширення

У попапі розширення вписати:

- **адреса радара**: `https://job-radar.<субдомен>.workers.dev`
- **токен**: той самий `RADAR_TOKEN`

Далі збирач шле компанії прямо в хмару, локальний сервер більше не потрібен.

## Телеграм

Команди бота на Workers працюють через вебхук, полінгу там немає:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://job-radar.<субдомен>.workers.dev/api/telegram/webhook"
```

Сповіщення за розкладом (дайджест, фолоу-апи, алерти) працюють і без вебхука.

## Перенести локальну базу в D1

```bash
sqlite3 data/radar.db .dump > /tmp/dump.sql
# прибрати рядки CREATE TABLE, якщо міграції вже застосовані
pnpm wrangler d1 execute job-radar --remote --file=/tmp/dump.sql
```

Або просто почати з чистої бази: `catalog:dou`, розширення і `discover` наповнять її за вечір.

## Що лишилось локальним

- `pnpm cli` працює тільки з локальною базою. Для хмарної версії дії доступні кнопками в інтерфейсі
- Playwright, якщо колись знадобиться, на Workers не запуститься. Це буде окремий локальний обхід
- Ліміт CPU на запит: важкі прогони (`source:sync` по сотнях компаній) краще залишати cron-у,
  який ділить роботу на окремі запуски

## Скільки це коштує

Free plan: 100 тисяч запитів на добу, 5 мільйонів рядків читання з D1 на добу, cron кожні кілька годин.
Для одного користувача це безкоштовно. Платить тільки Anthropic API за класифікацію.
