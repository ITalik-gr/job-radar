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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
