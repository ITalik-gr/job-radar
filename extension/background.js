/**
 * Sends what was collected to Job Radar and keeps a per day counter.
 * The address is configured by the user: a local server or their own worker.
 */

/*
 * No default address on purpose.
 *
 * It used to point at the author's own worker. Anyone who installed the
 * extension without opening settings shipped their scraped companies to
 * someone else's radar and could not tell: the popup said "connected" and the
 * counters went up, because that other server did answer. An empty address
 * fails loudly instead, which is the only honest default here.
 */
const DEFAULTS = { apiUrl: '', token: '' };

async function settings() {
  return chrome.storage.local.get(DEFAULTS);
}

/** Address of the radar, or null while the extension is not set up yet. */
async function apiBase() {
  const { apiUrl } = await settings();
  const clean = String(apiUrl || '').trim().replace(/\/$/, '');
  return clean || null;
}

async function call(path, options = {}) {
  const { apiUrl, token } = await settings();
  const base = String(apiUrl || '').trim().replace(/\/$/, '');
  if (!base) throw new Error('radar address is not set');

  const response = await fetch(`${base}/api${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-radar-token': token } : {}),
    },
  });
  if (!response.ok) {
    const detail = response.status === 401 ? 'wrong token' : `server answered ${response.status}`;
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
 * Auto-walk state lives in the service worker, not in the content script.
 *
 * Reason: the content script is an untrusted context, and chrome.storage.session
 * is not available to it by default. That is what threw the "Access to storage is
 * not allowed from this context" error, which broke auto-walk entirely. The service
 * worker is a trusted context, so it reads and writes itself, and the page just asks.
 *
 * Session, not local, on purpose: the walk must not continue after a browser restart,
 * it is a one-off action for a single session.
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
    apiBase().then((base) => {
      if (!base) return sendResponse({ ok: false, error: 'radar address is not set' });
      const isLocal = /localhost|127\.0\.0\.1/.test(base);
      chrome.tabs.create({ url: isLocal ? 'http://localhost:5173' : base });
      sendResponse({ ok: true });
    });
    return true;
  }

  /** Whether the extension knows where to send anything at all. */
  if (message.type === 'radar:configured') {
    apiBase().then((base) => sendResponse({ ok: true, configured: Boolean(base) }));
    return true;
  }

  return false;
});

/**
 * Walking sites that a script renders.
 *
 * The server-side crawl reads raw HTML, and on a React site that is an empty shell:
 * no email, no stack mentions. So the radar puts such domains into a separate queue,
 * and the extension opens them here, in a real browser, where the page is already
 * rendered.
 *
 * The tab is created **inactive**: it never switches the owner away, he keeps doing
 * his own thing. Once read, the tab closes itself.
 *
 * The pace is human, as section 4 of CLAUDE.md requires: the pause between sites is
 * never less than three seconds, and there is a limit of domains per pass. These are
 * other people's sites, and they must be visited the way a human would.
 */
const BROWSER_WALK = {
  minGapMs: 3500,
  settleMs: 2500,
  loadTimeoutMs: 20000,
  /*
   * The pause between pages of one site, and how many pages per domain.
   *
   * Three seconds is the floor from section 4 of CLAUDE.md, and it fits doubly well
   * here: this is not catalog pagination, it is another studio's own site, and a
   * "human" is reading it right now. Four pages is the home page plus contacts,
   * about, and vacancies, exactly the ones where what we came for lives. Going
   * deeper has no point and only costs more time.
   */
  pageGapMs: 3000,
  maxPages: 4,
};

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

    // The page might have loaded before the listener was attached, so the state is also checked directly.
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => tab?.status === 'complete' && finish(true)).catch(() => finish(false));
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readPage(tabId) {
  await waitForLoad(tabId, BROWSER_WALK.loadTimeoutMs);
  // Loaded does not mean rendered yet: rendering and data requests happen afterward.
  await pause(BROWSER_WALK.settleMs);

  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['site.js'],
  });

  return injected?.result ?? null;
}

/** The second and following pages are merged into what was already collected from the home page. */
function mergePage(into, page) {
  const known = new Set(into.emails.map((item) => item.email));
  for (const item of page.emails) {
    if (known.has(item.email)) continue;
    known.add(item.email);
    into.emails.push(item);
  }

  into.techHints = [...new Set([...into.techHints, ...page.techHints])];
  into.copyrightYear = Math.max(into.copyrightYear ?? 0, page.copyrightYear ?? 0) || null;
  into.lastPostAt = Math.max(into.lastPostAt ?? 0, page.lastPostAt ?? 0) || null;
  into.textLength += page.textLength;
  into.pages.push({ url: page.url, lines: page.lines });
}

/**
 * Walking one site: the home page, then whatever it links to.
 *
 * Reading only the home page used to be a bug, and a silent one: the page would open,
 * the script would run, and nothing would come back, because the studio's home page
 * holds a pitch, while the email lives on "contact" and the names on "about". It
 * looked like the collection was broken, though it was working and just looking in
 * the wrong place.
 *
 * There is one tab for the whole walk: it simply navigates to each address, the way
 * a human would. Also inactive, never switching the owner away.
 */
async function readSite(target) {
  const tab = await chrome.tabs.create({ url: `https://${target.domain}`, active: false });

  try {
    const home = await readPage(tab.id);
    if (!home) return null;

    const found = {
      domain: home.domain,
      emails: [...home.emails],
      techHints: [...home.techHints],
      copyrightYear: home.copyrightYear,
      lastPostAt: home.lastPostAt,
      textLength: home.textLength,
      pages: [{ url: home.url, lines: home.lines }],
      /** Addresses that could not be reached. An empty result needs an explanation, not silence. */
      failed: [],
    };

    for (const url of (home.links ?? []).slice(0, BROWSER_WALK.maxPages - 1)) {
      const { browserWalk: state } = await chrome.storage.session.get({ browserWalk: null });
      if (state?.stop) break;

      await pause(BROWSER_WALK.pageGapMs);

      try {
        await chrome.tabs.update(tab.id, { url });
        const page = await readPage(tab.id);
        if (page) mergePage(found, page);
        else found.failed.push(url);
      } catch (error) {
        found.failed.push(`${url}: ${String(error?.message ?? error)}`);
      }
    }

    return found;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function browserWalk(limit) {
  const { targets } = await call(`/import/browser/queue?limit=${limit}`);
  const report = { total: targets.length, done: 0, pages: 0, contacts: 0, people: 0, empty: 0, errors: [] };

  for (const [index, target] of targets.entries()) {
    const { browserWalk: state } = await chrome.storage.session.get({ browserWalk: null });
    if (state?.stop) break;

    await chrome.storage.session.set({
      browserWalk: { running: true, at: index + 1, total: targets.length, domain: target.domain },
    });

    try {
      const found = await readSite(target);
      if (found) {
        report.pages += found.pages.length;
        const saved = await post('/import/browser/site', { ...found, companyId: target.companyId });
        report.contacts += saved.contactsAdded ?? 0;
        report.people += saved.peopleFound ?? 0;
        /*
         * Empty means the server recognized nothing, not that there was no email.
         * A tech lead's name without an address is also a find: the email is looked up from it later.
         */
        if (!saved.emailsFound && !saved.peopleFound) {
          report.empty += 1;
          report.errors.push(`${target.domain}: read ${found.pages.length} page(s), found nothing`);
        }
      } else {
        report.empty += 1;
        report.errors.push(`${target.domain}: page could not be read`);
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
