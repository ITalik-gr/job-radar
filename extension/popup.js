const $ = (id) => document.getElementById(id);
const SETTINGS = {
  autoCollect: true,
  minDelay: 4000,
  maxDelay: 9000,
  maxPages: 25,
  apiUrl: 'https://job-radar.example.workers.dev',
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
    title.className = 'muted';
    title.style.margin = '6px 0 2px';
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

async function refresh() {
  const health = await chrome.runtime.sendMessage({ type: 'radar:health' });
  $('health').textContent = health?.ok ? 'на звʼязку' : (health?.error ?? 'не запущений');
  $('health').className = health?.ok ? '' : 'bad';

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
  if (!preview) {
    $('site').textContent = 'не каталог';
    $('walk').disabled = true;
    return;
  }

  $('site').textContent = preview.site + (preview.known ? '' : ', незнайомий');
  $('found').textContent = preview.total;
  $('withDomain').textContent = preview.withDomain;
  $('next').textContent = preview.nextPage ? 'є' : 'нема';
  $('walk').textContent = preview.walking ? 'Зупинити автообхід' : 'Автообхід пагінації';
  $('walk').className = preview.walking ? 'danger' : '';
  $('walk').disabled = !preview.nextPage && !preview.walking;
}

$('walk').addEventListener('click', async () => {
  const preview = await send({ type: 'radar:preview' });
  await send({ type: 'radar:walk', enabled: !preview?.walking });
  window.close();
});

$('collect').addEventListener('click', async () => {
  $('collect').textContent = 'збираю';
  await send({ type: 'radar:collect-now' });
  $('collect').textContent = 'Зібрати цю сторінку';
  await refresh();
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
      scale === 'text' ? event.target.value.trim() : scale ? Number(event.target.value) * scale : event.target.checked;
    await chrome.storage.local.set({ [key]: value });
    await send({ type: 'radar:settings', settings: { [key]: value } });
  });
}

renderCatalogs();
refresh();
