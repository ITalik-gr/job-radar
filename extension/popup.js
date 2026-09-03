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

async function refresh() {
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
