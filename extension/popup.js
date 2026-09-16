const $ = (id) => document.getElementById(id);

const SETTINGS = {
  autoCollect: true,
  minDelay: 4000,
  maxDelay: 9000,
  maxPages: 25,
  apiUrl: '',
  token: '',
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(message) {
  const tab = await activeTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    return null;
  }
}

function renderCatalogs() {
  const root = $('catalogs');

  for (const { group, links } of JOB_RADAR_CATALOGS) {
    const title = document.createElement('div');
    title.className = 'group';
    title.textContent = group;
    root.appendChild(title);

    for (const [label, url] of links) {
      const link = document.createElement('a');
      link.href = url;
      link.textContent = label;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        chrome.tabs.create({ url });
      });
      root.appendChild(link);
    }
  }
}

function setNote(text, tone) {
  const node = $('pageNote');
  node.hidden = !text;
  node.textContent = text ?? '';
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

/*
 * Nothing works until the radar address is set, so the popup says that plainly
 * instead of showing a health check that can only fail. The default used to be
 * the author's own worker, which meant an unconfigured extension looked healthy
 * while sending its findings to a stranger.
 */
async function refreshSetup() {
  const state = await chrome.runtime.sendMessage({ type: 'radar:configured' });
  const configured = Boolean(state?.configured);

  $('setup').hidden = configured;
  for (const id of ['collect', 'walk', 'jsWalk']) {
    if (!configured) $(id).disabled = true;
  }

  return configured;
}

$('setupSave').addEventListener('click', async () => {
  const apiUrl = $('setupUrl').value.trim().replace(/\/$/, '');
  if (!apiUrl) return;

  await chrome.storage.local.set({ apiUrl, token: $('setupToken').value.trim() });
  await send({ type: 'radar:settings', settings: { apiUrl } });
  await refreshSetup();
  await refresh();
  await refreshBrowserWalk();
});

$('setupUrl').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('setupSave').click();
});

async function refresh() {
  if (!(await refreshSetup())) {
    $('healthText').textContent = 'адреса не задана';
    $('health').querySelector('.dot').dataset.tone = 'bad';
    return;
  }

  const health = await chrome.runtime.sendMessage({ type: 'radar:health' });
  $('healthText').textContent = health?.ok ? 'на звʼязку' : (health?.error ?? 'не запущений');
  $('health').querySelector('.dot').dataset.tone = health?.ok ? 'ok' : 'bad';

  const day = new Date().toISOString().slice(0, 10);
  const stored = await chrome.storage.local.get({ stats: {}, ...SETTINGS });
  const today = stored.stats[day] ?? { pages: 0, created: 0, updated: 0 };

  $('pages').textContent = today.pages;
  $('created').textContent = today.created;
  $('updated').textContent = today.updated;

  $('auto').checked = stored.autoCollect;
  $('minDelay').value = Math.round(stored.minDelay / 1000);
  $('maxDelay').value = Math.round(stored.maxDelay / 1000);
  $('maxPages').value = stored.maxPages;
  $('apiUrl').value = stored.apiUrl;
  $('token').value = stored.token;

  const preview = await send({ type: 'radar:preview' });

  // Не каталог: числа порожні, зате одразу видно, куди піти. Тому список каталогів
  // розкривається сам, а на каталозі лишається згорнутим і не займає екран.
  if (!preview) {
    $('site').textContent = 'не каталог';
    $('site').dataset.tone = 'muted';
    $('pageMetrics').hidden = true;
    setNote('Відкрий сторінку каталогу зі списку нижче, і збір почнеться сам.');
    $('catalogsBox').open = true;
    $('walk').disabled = true;
    $('collect').disabled = true;
    return;
  }

  delete $('site').dataset.tone;
  $('site').textContent = preview.site;
  $('pageMetrics').hidden = false;
  $('found').textContent = preview.total;
  $('withDomain').textContent = preview.withDomain;
  $('collect').disabled = preview.total === 0;

  const walk = $('walk');
  walk.textContent = preview.walking ? 'Зупинити автообхід' : 'Автообхід пагінації';
  walk.className = preview.walking ? 'btn danger' : 'btn primary';
  walk.disabled = !preview.nextPage && !preview.walking;

  if (!preview.known) {
    setNote('Каталог незнайомий, розбір іде загальною евристикою. Перевір, чи схожі числа на правду.', 'warn');
  } else if (preview.total === 0) {
    setNote('Карток не видно. Можливо, сторінка ще вантажиться або показує перевірку.', 'warn');
  } else if (!preview.nextPage) {
    setNote('Наступної сторінки не видно, автообхід зупиниться після цієї.');
  } else {
    setNote(`Наступна сторінка знайдена, за прохід буде до ${stored.maxPages} сторінок.`);
  }
}

$('walk').addEventListener('click', async () => {
  const preview = await send({ type: 'radar:preview' });
  await send({ type: 'radar:walk', enabled: !preview?.walking });
  window.close();
});

$('collect').addEventListener('click', async () => {
  const button = $('collect');
  button.disabled = true;
  button.textContent = 'збираю';
  await send({ type: 'radar:collect-now' });
  button.textContent = 'Зібрати цю сторінку';
  await refresh();
});

/*
 * Обхід сайтів, намальованих скриптом. Кнопка живе окремо від каталогів навмисно:
 * це не збір списків компаній, а добір пошти і стеку по вже відомих доменах, і
 * працює він на будь-якій вкладці, не тільки на каталозі.
 */
async function refreshBrowserWalk() {
  // Без адреси черги не існує, і питати її означає лише отримати помилку у відповідь.
  const setup = await chrome.runtime.sendMessage({ type: 'radar:configured' });
  if (!setup?.configured) {
    $('jsCount').textContent = '?';
    $('jsWalk').disabled = true;
    return;
  }

  const state = await chrome.runtime.sendMessage({ type: 'radar:browser-state' });
  const running = state?.state?.running && !state?.state?.report;

  const button = $('jsWalk');
  button.textContent = running ? 'Зупинити обхід' : 'Обійти в фоні';
  button.className = running ? 'btn wide danger' : 'btn wide';

  if (running && state.state.domain) {
    $('jsNote').textContent = `${state.state.domain}, ${state.state.at} з ${state.state.total}`;
    return;
  }

  const report = state?.state?.report;
  if (report) {
    const parts = [
      `сайтів ${report.done}`,
      `сторінок ${report.pages ?? 0}`,
      `контактів ${report.contacts}`,
      `людей ${report.people ?? 0}`,
    ];

    /*
     * Порожній результат показується текстом помилки, а не числом у хвості.
     * Правило 3 в CLAUDE.md: нуль це помилка, і мовчати про неї не можна, інакше
     * обхід виглядає робочим рівно доти, доки хтось не полізе в базу перевіряти.
     */
    if (report.empty > 0) parts.push(`порожніх ${report.empty}`);
    $('jsNote').textContent = parts.join(', ');
    $('jsNote').dataset.tone = report.empty > 0 || report.errors?.length ? 'warn' : '';
    if (report.errors?.length) $('jsNote').title = report.errors.join('\n');
  }

  const queue = await chrome.runtime.sendMessage({ type: 'radar:browser-queue' });
  $('jsCount').textContent = queue?.ok ? queue.count : '?';
  $('jsWalk').disabled = !queue?.ok || queue.count === 0;
}

$('jsWalk').addEventListener('click', async () => {
  const state = await chrome.runtime.sendMessage({ type: 'radar:browser-state' });
  if (state?.state?.running && !state?.state?.report) {
    await chrome.runtime.sendMessage({ type: 'radar:browser-stop' });
    await refreshBrowserWalk();
    return;
  }

  $('jsWalk').disabled = true;
  $('jsNote').textContent = 'відкриваю сайти у фонових вкладках';
  // Попап закривається при переході по вкладках, тому робота живе у service worker.
  chrome.runtime.sendMessage({ type: 'radar:browser-walk', limit: 10 });
  setTimeout(refreshBrowserWalk, 1500);
});

$('open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'radar:open-app' }));

for (const [id, key, scale] of [
  ['auto', 'autoCollect', null],
  ['minDelay', 'minDelay', 1000],
  ['maxDelay', 'maxDelay', 1000],
  ['maxPages', 'maxPages', 1],
  ['apiUrl', 'apiUrl', 'text'],
  ['token', 'token', 'text'],
]) {
  $(id).addEventListener('change', async (event) => {
    const value =
      scale === 'text'
        ? event.target.value.trim()
        : scale
          ? Number(event.target.value) * scale
          : event.target.checked;
    await chrome.storage.local.set({ [key]: value });
    await send({ type: 'radar:settings', settings: { [key]: value } });
  });
}

renderCatalogs();
refresh();
refreshBrowserWalk();
