/**
 * Збирає сторінку каталогу і, за бажанням, сам гортає пагінацію.
 *
 * Межі, узгоджені в CLAUDE.md, правило 4: сторінки відкриває справжній браузер власника,
 * пауза між переходами не менша за 3 секунди, ліміт сторінок за прохід. Ніяких CAPTCHA,
 * ніяких підроблених сесій. Якщо каталог показав челендж, обхід зупиняється.
 */
(() => {
  const DEFAULTS = { autoCollect: true, minDelay: 4000, maxDelay: 9000, maxPages: 25 };

  const STATE = {
    lastSignature: '',
    busy: false,
    settings: { ...DEFAULTS },
    walk: null,
    lastResult: null,
    panelOpen: true,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function challengeShown() {
    const text = document.body?.innerText?.slice(0, 400) ?? '';
    return /just a moment|verify you are human|enable javascript and cookies|перевір/i.test(text);
  }

  // ---------- панель ----------

  function panel() {
    let node = document.getElementById('job-radar-panel');
    if (node) return node;

    node = document.createElement('div');
    node.id = 'job-radar-panel';
    node.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'right:16px',
      'bottom:16px',
      'width:260px',
      'padding:10px 12px',
      'border-radius:10px',
      'font:12px/1.5 ui-sans-serif,system-ui,sans-serif',
      'color:#e6e9ef',
      'background:#14171cf2',
      'border:1px solid #262b33',
      'box-shadow:0 6px 24px rgba(0,0,0,.45)',
      'backdrop-filter:blur(6px)',
    ].join(';');
    document.body.appendChild(node);
    return node;
  }

  function render(status = {}) {
    const node = panel();
    const result = STATE.lastResult;
    const walk = STATE.walk;

    if (!STATE.panelOpen) {
      node.innerHTML = '';
      const open = document.createElement('button');
      open.textContent = `Job Radar${walk ? ` ${walk.page}/${STATE.settings.maxPages}` : ''}`;
      open.style.cssText = 'all:unset;cursor:pointer;color:#6ee7a8;font:12px ui-sans-serif,system-ui';
      open.onclick = () => {
        STATE.panelOpen = true;
        render();
      };
      node.style.width = 'auto';
      node.appendChild(open);
      return;
    }

    node.style.width = '260px';
    const tone = status.tone ?? 'ok';
    const color = tone === 'bad' ? '#f2777a' : tone === 'warn' ? '#f0b429' : '#6ee7a8';

    node.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="color:${color}">Job Radar</b>
        <span style="cursor:pointer;color:#8a93a3" id="jr-hide">згорнути</span>
      </div>
      <div style="color:#8a93a3">${result?.site ?? location.hostname}${result && !result.known ? ', незнайомий' : ''}</div>
      <div>на сторінці <b>${result?.total ?? 0}</b>, з доменом <b>${result?.withDomain ?? 0}</b></div>
      <div style="color:#8a93a3">${status.text ?? (result ? `нових ${result.created}, оновлено ${result.updated}` : 'чекаю на завантаження')}</div>
      ${walk ? `<div style="color:#f0b429;margin-top:4px">автообхід: сторінка ${walk.page} з ${STATE.settings.maxPages}, зібрано ${walk.created}</div>` : ''}
      <div style="display:flex;gap:6px;margin-top:8px">
        <button id="jr-collect" style="flex:1;padding:5px;border-radius:6px;border:1px solid #262b33;background:#1b1f26;color:#e6e9ef;font:inherit;cursor:pointer">Зібрати</button>
        <button id="jr-walk" style="flex:1;padding:5px;border-radius:6px;border:1px solid ${walk ? '#4a2226' : '#1e4433'};background:${walk ? '#2a1618' : '#12271c'};color:${walk ? '#f2777a' : '#6ee7a8'};font:inherit;cursor:pointer">${walk ? 'Стоп' : 'Автообхід'}</button>
      </div>
      ${result?.nextPage ? '<div style="color:#8a93a3;margin-top:6px">наступна сторінка знайдена</div>' : '<div style="color:#8a93a3;margin-top:6px">наступної сторінки не видно</div>'}
    `;

    node.querySelector('#jr-hide').onclick = () => {
      STATE.panelOpen = false;
      render();
    };
    node.querySelector('#jr-collect').onclick = () => collect(true);
    node.querySelector('#jr-walk').onclick = () => (STATE.walk ? stopWalk('зупинено вручну') : startWalk());
  }

  // ---------- збір ----------

  async function collect(manual = false) {
    if (STATE.busy) return null;

    const parsed = window.JobRadarParsers.parse();
    const withDomain = parsed.items.filter((item) => item.domain).length;

    STATE.lastResult = {
      site: parsed.site,
      known: parsed.known,
      total: parsed.items.length,
      withDomain,
      nextPage: parsed.nextPage,
      created: STATE.lastResult?.created ?? 0,
      updated: STATE.lastResult?.updated ?? 0,
    };

    if (parsed.items.length === 0) {
      render({ text: challengeShown() ? 'сторінка показує перевірку, збір пропущено' : 'карток не видно', tone: 'warn' });
      return null;
    }

    const signature = `${location.pathname}${location.search}|${parsed.items.length}|${parsed.items[0].name}`;
    if (!manual && signature === STATE.lastSignature) {
      render();
      return STATE.lastResult;
    }
    STATE.lastSignature = signature;

    STATE.busy = true;
    render({ text: 'надсилаю' });

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'radar:collect',
        payload: { source: parsed.site, pageUrl: location.href, items: parsed.items },
      });

      if (!response?.ok) {
        render({ text: `${response?.error ?? 'сервер недоступний'}`, tone: 'bad' });
        return null;
      }

      STATE.lastResult.created = response.result.itemsNew;
      STATE.lastResult.updated = response.result.updated;
      render();
      return STATE.lastResult;
    } finally {
      STATE.busy = false;
    }
  }

  // ---------- автообхід ----------

  async function startWalk() {
    const { walk } = await chrome.storage.session.get({ walk: null });
    if (walk) return;

    STATE.walk = { page: 1, created: 0, startedAt: Date.now() };
    await chrome.storage.session.set({ walk: STATE.walk });
    render({ text: 'автообхід запущено' });
    void step();
  }

  async function stopWalk(reason) {
    STATE.walk = null;
    await chrome.storage.session.remove('walk');
    render({ text: reason, tone: 'warn' });
  }

  async function step() {
    const result = await collect(true);
    if (!STATE.walk) return;

    if (result) {
      STATE.walk.created += result.created;
      await chrome.storage.session.set({ walk: STATE.walk });
    }

    if (challengeShown()) return stopWalk('сайт показав перевірку, зупиняюсь');
    if (STATE.walk.page >= STATE.settings.maxPages) return stopWalk(`ліміт ${STATE.settings.maxPages} сторінок`);

    const next = result?.nextPage ?? window.JobRadarParsers.parse().nextPage;
    if (!next) return stopWalk('сторінки закінчились');

    // Пауза між сторінками навмисна: гортаємо не швидше за людину.
    const delay =
      STATE.settings.minDelay + Math.random() * Math.max(0, STATE.settings.maxDelay - STATE.settings.minDelay);
    render({ text: `наступна сторінка через ${Math.round(delay / 1000)} с` });
    await sleep(delay);
    if (!STATE.walk) return;

    STATE.walk.page += 1;
    await chrome.storage.session.set({ walk: STATE.walk });
    location.href = next;
  }

  // ---------- старт ----------

  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => STATE.settings.autoCollect && collect(false), 1200);
  });

  (async () => {
    const settings = await chrome.storage.local.get(DEFAULTS);
    STATE.settings = { ...DEFAULTS, ...settings };

    const { walk } = await chrome.storage.session.get({ walk: null });
    STATE.walk = walk;

    render({ text: 'читаю сторінку' });

    if (STATE.settings.autoCollect || walk) {
      await sleep(900);
      if (walk) void step();
      else void collect(false);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  })();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'radar:collect-now') {
      collect(true).then((result) => sendResponse({ ok: true, result }));
      return true;
    }
    if (message.type === 'radar:preview') {
      const parsed = window.JobRadarParsers.parse();
      sendResponse({
        site: parsed.site,
        known: parsed.known,
        method: parsed.method,
        total: parsed.items.length,
        withDomain: parsed.items.filter((item) => item.domain).length,
        nextPage: parsed.nextPage,
        walking: Boolean(STATE.walk),
      });
      return true;
    }
    if (message.type === 'radar:walk') {
      (message.enabled ? startWalk() : stopWalk('зупинено з попапа')).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'radar:settings') {
      STATE.settings = { ...STATE.settings, ...message.settings };
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
