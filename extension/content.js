/*
 * Repo Reality Check — content script (repo root pages).
 * Detects repo root pages, scores them via the shared RRC pipeline
 * (common.js: fetch + 6h cache + computeScore), and injects the panel.
 */

(() => {
  'use strict';

  const PANEL_ID = 'rrc-panel';

  // Token used to discard stale async work after SPA navigation.
  let loadSeq = 0;

  function getRepoFromUrl() {
    if (location.hostname !== 'github.com') return null;
    return RRC.parseRepoPath(location.pathname); // repo root only in v1
  }

  // ---------- panel rendering ------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function findMountPoint() {
    return document.querySelector('#repo-content-pjax-container') ||
      document.querySelector('.repository-content') ||
      document.querySelector('main');
  }

  function removePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
  }

  function mountPanel(panel) {
    removePanel();
    const mount = findMountPoint();
    if (mount) mount.prepend(panel);
  }

  function openExtensionPage(page, hashOrQuery) {
    window.open(chrome.runtime.getURL(page) + (hashOrQuery || ''));
  }

  function openSettings(e) {
    e.preventDefault();
    openExtensionPage('options.html');
  }

  // Disabled Pro affordance: label + small "Pro" tag, click explains Pro.
  function proLocked(label) {
    const btn = el('button', 'rrc-link rrc-pro-locked', label);
    btn.type = 'button';
    btn.title = 'Repo Reality Check Pro feature';
    btn.appendChild(el('span', 'rrc-pro-tag', 'Pro'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openExtensionPage('options.html', '#pro');
    });
    return btn;
  }

  function watchButton(repoFull, result, cachedAt, ctx) {
    if (!ctx.pro) return proLocked('☆ watch');
    const btn = el('button', 'rrc-link rrc-watch',
      ctx.watched ? '★ watching' : '☆ watch');
    btn.type = 'button';
    btn.title = 'Watch this repo: weekly re-check with a notification if its band changes';
    btn.addEventListener('click', async () => {
      const list = (await RRC.storageGet(['rrcWatchlist'])).rrcWatchlist || {};
      if (list[repoFull]) {
        delete list[repoFull];
        ctx.watched = false;
      } else {
        list[repoFull] = {
          addedAt: Date.now(),
          score: result.score,
          band: result.band.key,
          checkedAt: cachedAt
        };
        ctx.watched = true;
      }
      await RRC.storageSet({ rrcWatchlist: list });
      btn.textContent = ctx.watched ? '★ watching' : '☆ watch';
    });
    return btn;
  }

  function renderPanel(repoFull, result, cachedAt, fromCache, ctx) {
    const panel = el('section', 'rrc');
    panel.id = PANEL_ID;
    panel.dataset.rrcRepo = repoFull;

    const bar = el('div', 'rrc-bar');

    // Left: score + band.
    const left = el('div', 'rrc-left rrc-band-' + result.band.key);
    left.appendChild(el('span', 'rrc-score', String(result.score)));
    left.appendChild(el('span', 'rrc-band-label', result.band.label));
    bar.appendChild(left);

    // Middle: top 3 red/amber chips by deduction size.
    const chips = el('div', 'rrc-chips');
    result.reasons
      .filter((r) => r.severity === 'red' || r.severity === 'amber')
      .sort((a, b) => b.points - a.points)
      .slice(0, 3)
      .forEach((r) => {
        const chip = el('span', 'rrc-chip rrc-chip-' + r.severity, r.text);
        chip.title = r.text;
        chips.appendChild(chip);
      });
    bar.appendChild(chips);

    // Right: expand chevron.
    const toggle = el('button', 'rrc-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Expand Repo Reality Check details');
    toggle.appendChild(el('span', 'rrc-chevron', '▾'));
    bar.appendChild(toggle);

    panel.appendChild(bar);

    // Expanded detail: full reason list + footer.
    const detail = el('div', 'rrc-detail');
    detail.hidden = true;

    const list = el('ul', 'rrc-reasons');
    if (result.reasons.length === 0) {
      list.appendChild(el('li', 'rrc-reason rrc-reason-neutral',
        'No flags — all checks passed.'));
    }
    result.reasons.forEach((r) => {
      const li = el('li', 'rrc-reason rrc-reason-' + r.severity);
      if (r.points > 0) li.appendChild(el('span', 'rrc-points', '−' + r.points));
      li.appendChild(el('span', 'rrc-reason-text', r.text));
      list.appendChild(li);
    });
    detail.appendChild(list);

    const footer = el('div', 'rrc-footer');
    const when = new Date(cachedAt);
    const hhmm = String(when.getHours()).padStart(2, '0') + ':' +
      String(when.getMinutes()).padStart(2, '0');
    footer.appendChild(el('span', null,
      (fromCache ? 'cached ' : 'fetched ') + hhmm));
    footer.appendChild(el('span', 'rrc-dot', '·'));
    const refresh = el('a', 'rrc-link', 'refresh');
    refresh.href = '#';
    refresh.addEventListener('click', (e) => {
      e.preventDefault();
      run({ force: true });
    });
    footer.appendChild(refresh);
    footer.appendChild(el('span', 'rrc-dot', '·'));
    const settings = el('a', 'rrc-link', 'settings');
    settings.href = '#';
    settings.addEventListener('click', openSettings);
    footer.appendChild(settings);

    // Pro affordances: compare + watch.
    footer.appendChild(el('span', 'rrc-dot', '·'));
    if (ctx.pro) {
      const compare = el('a', 'rrc-link', 'compare');
      compare.href = '#';
      compare.addEventListener('click', (e) => {
        e.preventDefault();
        openExtensionPage('compare.html', '?left=' + encodeURIComponent(repoFull));
      });
      footer.appendChild(compare);
    } else {
      footer.appendChild(proLocked('compare'));
    }
    footer.appendChild(el('span', 'rrc-dot', '·'));
    footer.appendChild(watchButton(repoFull, result, cachedAt, ctx));

    detail.appendChild(footer);

    panel.appendChild(detail);

    toggle.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      panel.classList.toggle('rrc-open', open);
    });

    mountPanel(panel);
  }

  function renderRateLimited(repoFull) {
    const panel = el('section', 'rrc rrc-degraded');
    panel.id = PANEL_ID;
    panel.dataset.rrcRepo = repoFull;
    const bar = el('div', 'rrc-bar');
    bar.appendChild(el('span', 'rrc-degraded-text',
      'GitHub rate limit reached — add a free token in settings for 5,000 req/hr.'));
    const settings = el('a', 'rrc-link', 'settings');
    settings.href = '#';
    settings.addEventListener('click', openSettings);
    bar.appendChild(settings);
    panel.appendChild(bar);
    mountPanel(panel);
  }

  // ---------- orchestration ------------------------------------------------------

  async function run(opts) {
    const force = !!(opts && opts.force);
    const target = getRepoFromUrl();

    if (!target) {
      removePanel();
      return;
    }

    // Never double-inject: same repo already shown → nothing to do.
    const existing = document.getElementById(PANEL_ID);
    if (existing && existing.dataset.rrcRepo === target.full && !force) return;

    const seq = ++loadSeq;

    try {
      const [pro, wl] = await Promise.all([
        isPro(),
        RRC.storageGet(['rrcWatchlist'])
      ]);
      const watchlist = wl.rrcWatchlist || {};

      const res = await RRC.scoreAndCache(target.owner, target.repo, { force });
      if (seq !== loadSeq) return; // user navigated away mid-fetch
      if (!res) {
        removePanel();
        return;
      }
      renderPanel(target.full, res.result, res.cachedAt, res.fromCache,
        { pro, watched: !!watchlist[target.full] });
    } catch (e) {
      if (seq !== loadSeq) return;
      if (e instanceof RRC.RateLimitError) {
        renderRateLimited(target.full);
      } else {
        // Network hiccup etc. — stay quiet rather than break the page.
        console.warn('Repo Reality Check:', e);
      }
    }
  }

  // ---------- SPA navigation hooks -------------------------------------------------

  let debounceTimer = null;
  function scheduleRun() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => run(), 250);
  }

  document.addEventListener('turbo:load', scheduleRun);
  window.addEventListener('popstate', scheduleRun);

  // Fallback: GitHub always updates <title> on soft navigation.
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(scheduleRun).observe(titleEl, {
      childList: true, characterData: true, subtree: true
    });
  }

  run();
})();
