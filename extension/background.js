/**
 * Пересилає зібране в Job Radar і веде лічильник за добу.
 * Адрес налаштовується: локальний сервер або задеплоєний воркер на Cloudflare.
 */
// Локально замінити на http://localhost:3000 у попапі розширення.
const DEFAULTS = { apiUrl: 'https://job-radar.example.workers.dev', token: '' };

async function settings() {
  return chrome.storage.local.get(DEFAULTS);
}

async function call(path, options = {}) {
  const { apiUrl, token } = await settings();
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-radar-token': token } : {}),
    },
  });
  if (!response.ok) {
    const detail = response.status === 401 ? 'невірний токен' : `${response.status} від сервера`;
    throw new Error(detail);
  }
  return response.json();
}

const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) });

async function bumpStats(result) {
  const day = new Date().toISOString().slice(0, 10);
  const { stats = {} } = await chrome.storage.local.get({ stats: {} });
  const today = stats[day] ?? { pages: 0, found: 0, created: 0, updated: 0 };

  stats[day] = {
    pages: today.pages + 1,
    found: today.found + result.itemsFound,
    created: today.created + result.itemsNew,
    updated: today.updated + result.updated,
  };

  await chrome.storage.local.set({ stats, lastResult: { ...result, at: Date.now() } });
  await chrome.action.setBadgeText({ text: String(stats[day].created || '') });
  await chrome.action.setBadgeBackgroundColor({ color: '#1e4433' });
}

/*
 * Стан автообходу живе в service worker, а не в content script.
 *
 * Причина: content script це untrusted context, і chrome.storage.session йому за
 * замовчуванням недоступний. Звідти й падала помилка "Access to storage is not
 * allowed from this context", через яку автообхід не працював зовсім. Service
 * worker це trusted context, тому читає і пише сам, а сторінка лише питає.
 *
 * Саме session, а не local: обхід не має продовжуватись після перезапуску браузера,
 * це разова дія на один сеанс.
 */
async function walkState() {
  const { walk = null } = await chrome.storage.session.get({ walk: null });
  return walk;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'radar:walk-get') {
    walkState().then((walk) => sendResponse({ ok: true, walk }));
    return true;
  }

  if (message.type === 'radar:walk-set') {
    chrome.storage.session
      .set({ walk: message.walk })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  if (message.type === 'radar:walk-clear') {
    chrome.storage.session
      .remove('walk')
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  if (message.type === 'radar:collect') {
    post('/import/catalog', message.payload)
      .then(async (result) => {
        await bumpStats(result);
        sendResponse({ ok: true, result });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error.message ?? error) }));
    return true;
  }

  if (message.type === 'radar:health') {
    call('/health')
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message ?? error) }));
    return true;
  }

  if (message.type === 'radar:open-app') {
    settings().then(({ apiUrl }) => {
      const isLocal = /localhost|127\.0\.0\.1/.test(apiUrl);
      chrome.tabs.create({ url: isLocal ? 'http://localhost:5173' : apiUrl });
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});

/**
 * Обхід сайтів, які малює скрипт.
 *
 * Серверний обхід читає сирий HTML, і на React-сайті там порожній каркас: ні пошти,
 * ні згадок стеку. Тому такі домени радар складає в окрему чергу, а розширення
 * відкриває їх тут, у справжньому браузері, де сторінка вже намальована.
 *
 * Вкладка створюється **неактивною**: власника нікуди не перекидає, він продовжує
 * робити своє. Після зчитування вкладка закривається сама.
 *
 * Темп людський, як вимагає розділ 4 CLAUDE.md: пауза між сайтами не менша за три
 * секунди і ліміт доменів за прохід. Це чужі сайти, і ходити ними треба так, як
 * ходить людина.
 */
const BROWSER_WALK = { minGapMs: 3500, settleMs: 2500, loadTimeoutMs: 20000 };

async function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };

    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };

    // Сторінка могла завантажитись ще до підписки, тому стан перевіряється і напряму.
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => tab?.status === 'complete' && finish(true)).catch(() => finish(false));
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readSite(target) {
  const tab = await chrome.tabs.create({ url: `https://${target.domain}`, active: false });

  try {
    await waitForLoad(tab.id, BROWSER_WALK.loadTimeoutMs);
    // Завантаження це ще не намальована сторінка: рендер і запити даних ідуть після.
    await pause(BROWSER_WALK.settleMs);

    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['site.js'],
    });

    return injected?.result ?? null;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function browserWalk(limit) {
  const { targets } = await call(`/import/browser/queue?limit=${limit}`);
  const report = { total: targets.length, done: 0, contacts: 0, empty: 0, errors: [] };

  for (const [index, target] of targets.entries()) {
    const { browserWalk: state } = await chrome.storage.session.get({ browserWalk: null });
    if (state?.stop) break;

    await chrome.storage.session.set({
      browserWalk: { running: true, at: index + 1, total: targets.length, domain: target.domain },
    });

    try {
      const found = await readSite(target);
      if (found) {
        const saved = await post('/import/browser/site', { ...found, companyId: target.companyId });
        report.contacts += saved.contactsAdded ?? 0;
        if (!found.emails?.length) report.empty += 1;
      } else {
        report.empty += 1;
      }
      report.done += 1;
    } catch (error) {
      report.errors.push(`${target.domain}: ${String(error?.message ?? error)}`);
    }

    if (index < targets.length - 1) await pause(BROWSER_WALK.minGapMs);
  }

  await chrome.storage.session.set({ browserWalk: { running: false, report } });
  return report;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'radar:browser-queue') {
    call('/import/browser/queue?limit=50')
      .then((data) => sendResponse({ ok: true, count: data.targets.length }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message ?? error) }));
    return true;
  }

  if (message.type === 'radar:browser-walk') {
    chrome.storage.session
      .set({ browserWalk: { running: true, at: 0, total: 0 } })
      .then(() => browserWalk(message.limit ?? 10))
      .then((report) => sendResponse({ ok: true, report }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message ?? error) }));
    return true;
  }

  if (message.type === 'radar:browser-stop') {
    chrome.storage.session
      .set({ browserWalk: { running: true, stop: true } })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'radar:browser-state') {
    chrome.storage.session
      .get({ browserWalk: null })
      .then(({ browserWalk: state }) => sendResponse({ ok: true, state }));
    return true;
  }

  return false;
});
