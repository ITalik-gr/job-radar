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

  /*
   * Панель на сторінці каталогу. Стилі живуть в одному <style>, а не в атрибутах
   * кожного вузла: інакше кожен перемальовок переписує двадцять inline-правил
   * і панель неможливо правити. Класи з префіксом jr- щоб не зачепити стилі сайту.
   */
  const PANEL_CSS = `
    #job-radar-panel {
      position: fixed;
      z-index: 2147483647;
      right: 16px;
      bottom: 16px;
      width: 288px;
      background: #fff;
      border: 1px solid #e6e5e1;
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .14);
      color: #161615;
      font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      text-align: left;
    }
    #job-radar-panel.jr-collapsed { width: auto; }
    #job-radar-panel * { box-sizing: border-box; }

    .jr-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid #e6e5e1;
    }
    .jr-title { font-weight: 600; display: flex; align-items: center; gap: 7px; }
    .jr-dot { width: 7px; height: 7px; border-radius: 50%; background: #0ca30c; flex: none; }
    .jr-dot[data-tone="warn"] { background: #fab219; }
    .jr-dot[data-tone="bad"] { background: #d03b3b; }
    .jr-hide {
      margin-left: auto;
      border: 0;
      background: none;
      padding: 2px 4px;
      color: #8a8985;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      border-radius: 4px;
    }
    .jr-hide:hover { background: #f3f3f1; color: #161615; }

    .jr-body { padding: 10px 12px; }
    .jr-site {
      font-size: 12px;
      color: #8a8985;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .jr-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
    .jr-metrics b { display: block; font-size: 18px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
    .jr-metrics span { font-size: 11px; color: #8a8985; }
    .jr-status { margin-top: 10px; padding-top: 8px; border-top: 1px solid #e6e5e1; font-size: 12px; color: #575653; }
    .jr-status[data-tone="warn"] { color: #8a5d00; }
    .jr-status[data-tone="bad"] { color: #a62d2d; }

    .jr-actions { display: flex; gap: 8px; padding: 0 12px 12px; }
    .jr-btn {
      flex: 1;
      min-height: 32px;
      border-radius: 6px;
      border: 1px solid #d2d1cc;
      background: #fff;
      color: #161615;
      font: inherit;
      font-weight: 500;
      cursor: pointer;
    }
    .jr-btn:hover { background: #f3f3f1; }
    .jr-btn.jr-primary { border-color: #1c5cab; background: #2a78d6; color: #fff; }
    .jr-btn.jr-primary:hover { background: #1c5cab; }
    .jr-btn.jr-stop { border-color: #d03b3b; background: #fdf0f0; color: #a62d2d; }

    .jr-pill {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 8px 12px;
      border: 0;
      background: none;
      color: #1c5cab;
      font: inherit;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
  `;

  function panel() {
    let node = document.getElementById('job-radar-panel');
    if (node) return node;

    const style = document.createElement('style');
    style.id = 'job-radar-style';
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);

    node = document.createElement('div');
    node.id = 'job-radar-panel';
    document.body.appendChild(node);
    return node;
  }

  function render(status = {}) {
    const node = panel();
    const result = STATE.lastResult;
    const walk = STATE.walk;

    node.textContent = '';

    // Згорнутий стан це один рядок: панель не мусить закривати картки каталогу.
    if (!STATE.panelOpen) {
      node.className = 'jr-collapsed';
      const open = document.createElement('button');
      open.className = 'jr-pill';
      open.innerHTML = '<i class="jr-dot"></i>';
      open.append(`Job Radar${walk ? ` ${walk.page}/${STATE.settings.maxPages}` : ''}`);
      open.onclick = () => {
        STATE.panelOpen = true;
        render(status);
      };
      node.appendChild(open);
      return;
    }

    node.className = '';
    const tone = status.tone ?? 'ok';

    const head = document.createElement('div');
    head.className = 'jr-head';
    head.innerHTML = `
      <span class="jr-title"><i class="jr-dot" data-tone="${tone}"></i>Job Radar</span>
      <button class="jr-hide" type="button">згорнути</button>
    `;
    head.querySelector('.jr-hide').onclick = () => {
      STATE.panelOpen = false;
      render(status);
    };
    node.appendChild(head);

    const body = document.createElement('div');
    body.className = 'jr-body';

    const site = document.createElement('div');
    site.className = 'jr-site';
    site.textContent = (result?.site ?? location.hostname) + (result && !result.known ? ', незнайомий' : '');
    body.appendChild(site);

    const metrics = document.createElement('div');
    metrics.className = 'jr-metrics';
    metrics.innerHTML = `
      <div><b>${result?.total ?? 0}</b><span>карток на сторінці</span></div>
      <div><b>${result?.withDomain ?? 0}</b><span>з доменом</span></div>
    `;
    body.appendChild(metrics);

    const line = document.createElement('div');
    line.className = 'jr-status';
    if (status.tone) line.dataset.tone = status.tone;
    line.textContent = walk
      ? `автообхід: сторінка ${walk.page} з ${STATE.settings.maxPages}, зібрано ${walk.created}`
      : (status.text ??
        (result ? `нових ${result.created}, оновлено ${result.updated}` : 'чекаю на завантаження'));
    body.appendChild(line);

    if (walk && status.text) {
      const extra = document.createElement('div');
      extra.className = 'jr-status';
      extra.style.borderTop = '0';
      extra.style.marginTop = '2px';
      extra.style.paddingTop = '0';
      extra.textContent = status.text;
      body.appendChild(extra);
    }

    node.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'jr-actions';

    const collectButton = document.createElement('button');
    collectButton.type = 'button';
    collectButton.className = 'jr-btn';
    collectButton.textContent = 'Зібрати';
    collectButton.onclick = () => collect(true);
    actions.appendChild(collectButton);

    const walkButton = document.createElement('button');
    walkButton.type = 'button';
    walkButton.className = `jr-btn ${walk ? 'jr-stop' : 'jr-primary'}`;
    walkButton.textContent = walk ? 'Стоп' : 'Автообхід';
    walkButton.onclick = () => (STATE.walk ? stopWalk('зупинено вручну') : startWalk());
    actions.appendChild(walkButton);

    node.appendChild(actions);
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
