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
    $('healthText').textContent = 'address is not set';
    $('health').querySelector('.dot').dataset.tone = 'bad';
    return;
  }

  const health = await chrome.runtime.sendMessage({ type: 'radar:health' });
  $('healthText').textContent = health?.ok ? 'connected' : (health?.error ?? 'not running');
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

  // Not a catalog: the numbers are empty, but it is immediately clear where to go.
  // So the catalog list expands itself, and on a catalog it stays collapsed and does not take up the screen.
  if (!preview) {
    $('site').textContent = 'not a catalog';
    $('site').dataset.tone = 'muted';
    $('pageMetrics').hidden = true;
    setNote('Open a catalog page from the list below, and collection will start on its own.');
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
  walk.textContent = preview.walking ? 'Stop auto-walk' : 'Auto-walk pagination';
  walk.className = preview.walking ? 'btn danger' : 'btn primary';
  walk.disabled = !preview.nextPage && !preview.walking;

  if (!preview.known) {
    setNote('Catalog is unfamiliar, parsing runs on the generic heuristic. Check whether the numbers look right.', 'warn');
  } else if (preview.total === 0) {
    setNote('No cards visible. The page may still be loading or showing a verification challenge.', 'warn');
  } else if (!preview.nextPage) {
    setNote('No next page visible, auto-walk will stop after this one.');
  } else {
    setNote(`Next page found, up to ${stored.maxPages} pages will be visited per pass.`);
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
  button.textContent = 'collecting';
  await send({ type: 'radar:collect-now' });
  button.textContent = 'Collect this page';
  await refresh();
});

/*
 * Walking sites that a script renders. The button lives apart from the catalogs on
 * purpose: this is not collecting lists of companies, but picking up email and stack
 * for domains already known, and it works on any tab, not only on a catalog.
 */
async function refreshBrowserWalk() {
  // Without an address the queue does not exist, and asking for it would only get an error back.
  const setup = await chrome.runtime.sendMessage({ type: 'radar:configured' });
  if (!setup?.configured) {
    $('jsCount').textContent = '?';
    $('jsWalk').disabled = true;
    return;
  }

  const state = await chrome.runtime.sendMessage({ type: 'radar:browser-state' });
  const running = state?.state?.running && !state?.state?.report;

  const button = $('jsWalk');
  button.textContent = running ? 'Stop walk' : 'Walk in background';
  button.className = running ? 'btn wide danger' : 'btn wide';

  if (running && state.state.domain) {
    $('jsNote').textContent = `${state.state.domain}, ${state.state.at} of ${state.state.total}`;
    return;
  }

  const report = state?.state?.report;
  if (report) {
    const parts = [
      `sites ${report.done}`,
      `pages ${report.pages ?? 0}`,
      `contacts ${report.contacts}`,
      `people ${report.people ?? 0}`,
    ];

    /*
     * An empty result shows as error text, not as a number at the tail.
     * Rule 3 in CLAUDE.md: zero is an error, and staying silent about it is not
     * allowed, otherwise the walk looks like it is working right up until someone
     * checks the database.
     */
    if (report.empty > 0) parts.push(`empty ${report.empty}`);
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
  $('jsNote').textContent = 'opening sites in background tabs';
  // The popup closes when switching tabs, so the work lives in the service worker.
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
