/*
 * Repo Reality Check — content script.
 * Detects repo root pages, fetches GitHub API data (cached 6h), scores via
 * computeScore (scoring.js, loaded before this file), and injects the panel.
 */

(() => {
  'use strict';

  const RESERVED_OWNERS = new Set([
    'settings', 'search', 'marketplace', 'topics', 'orgs', 'sponsors',
    'notifications', 'explore', 'codespaces', 'features', 'pulls', 'issues',
    'about', 'pricing', 'login', 'join'
  ]);

  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  // Bump when the data shape or scoring rules change, so cached results
  // computed under old rules are refetched instead of shown for up to 6h.
  const CACHE_VERSION = 2;
  const PANEL_ID = 'rrc-panel';

  // Token used to discard stale async work after SPA navigation.
  let loadSeq = 0;

  // ---------- page detection -------------------------------------------------

  function getRepoFromUrl() {
    if (location.hostname !== 'github.com') return null;
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null; // repo root only in v1
    const [owner, repo] = parts;
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    return { owner, repo, full: owner + '/' + repo };
  }

  // ---------- storage helpers ------------------------------------------------

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  // ---------- GitHub API -----------------------------------------------------

  class RateLimitError extends Error {}

  async function apiFetch(url, accept, token) {
    const headers = { Accept: accept || 'application/vnd.github+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(url, { headers });
    if ((res.status === 403 || res.status === 429) &&
        res.headers.get('x-ratelimit-remaining') === '0') {
      throw new RateLimitError('GitHub rate limit reached');
    }
    return res;
  }

  /*
   * Star-burst sampling (approximate). Only called when stars > 5000.
   * Fetches the FIRST stargazer page and, via the Link rel="last" header,
   * the LAST page — two requests max. The list is ordered oldest→newest,
   * so page 1 holds the earliest stars and the last page the newest.
   */
  async function sampleStarBurst(owner, repo, repoData, token) {
    const base = 'https://api.github.com/repos/' + owner + '/' + repo +
      '/stargazers?per_page=100';
    const accept = 'application/vnd.github.star+json';

    const first = await apiFetch(base + '&page=1', accept, token);
    if (!first.ok) return false;
    const firstPage = await first.json();

    let lastPage = firstPage;
    const link = first.headers.get('Link') || '';
    const m = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
    if (m) {
      const res = await apiFetch(base + '&page=' + m[1], accept, token);
      if (!res.ok) return false;
      lastPage = await res.json();
    }

    const times = (page) => page
      .map((s) => Date.parse(s.starred_at))
      .filter((t) => !isNaN(t))
      .sort((a, b) => a - b);
    const firstTimes = times(firstPage);
    const lastTimes = times(lastPage);
    if (!firstTimes.length || !lastTimes.length) return false;

    const DAY = 86400000;
    const ageDays = (Date.now() - Date.parse(repoData.created_at)) / DAY;
    if (ageDays < 90) return false; // "months old" — young repos get a pass

    const oldestStar = firstTimes[0];
    const newestStar = lastTimes[lastTimes.length - 1];
    const totalSpanDays = (newestStar - oldestStar) / DAY;

    // Case A: every sampled star — oldest to newest — fits in ~14 days on an
    // old repo: essentially the whole star count arrived in one burst.
    if (totalSpanDays <= 14) return true;

    // Case B: the newest 100 stars arrived so fast that the same rate over a
    // 14-day window would account for >30% of all stars.
    const lastSpanDays = Math.max(
      (lastTimes[lastTimes.length - 1] - lastTimes[0]) / DAY, 0.02);
    const recentRatePerDay = lastTimes.length / lastSpanDays;
    if (recentRatePerDay * 14 > 0.3 * repoData.stargazers_count) return true;

    return false;
  }

  async function fetchRepoData(owner, repo, token) {
    const api = 'https://api.github.com/repos/' + owner + '/' + repo;

    const repoRes = await apiFetch(api, null, token);
    if (!repoRes.ok) return null; // 404 etc. — not a scoreable repo page
    const repoData = await repoRes.json();

    const [contribRes, releasesRes, readmeRes] = await Promise.all([
      apiFetch(api + '/contributors?per_page=10', null, token),
      apiFetch(api + '/releases?per_page=1', null, token),
      apiFetch(api + '/readme', 'application/vnd.github.raw', token)
    ]);

    // GitHub refuses to list contributors for very large repos (403 "list too
    // large", e.g. torvalds/linux). Record that so scoring doesn't mistake
    // "no data" for "no contributors".
    let contributors = [];
    let contributorsUnavailable = false;
    if (contribRes.ok) {
      if (contribRes.status !== 204) {
        const body = await contribRes.text();
        if (body) contributors = JSON.parse(body);
      }
    } else {
      contributorsUnavailable = true;
    }

    let hasRelease = false;
    if (releasesRes.ok) {
      const releases = await releasesRes.json();
      hasRelease = Array.isArray(releases) && releases.length > 0;
    }

    // Tags are a release signal too (kernel-style projects tag versions but
    // never publish GitHub releases). Only worth a request when releases came
    // back empty and the repo is big enough for scoring to care.
    let hasTags = false;
    if (!hasRelease && repoData.stargazers_count > 2000) {
      const tagsRes = await apiFetch(api + '/tags?per_page=1', null, token);
      if (tagsRes.ok) {
        const tags = await tagsRes.json();
        hasTags = Array.isArray(tags) && tags.length > 0;
      }
    }

    let readme = null;
    if (readmeRes.ok) readme = await readmeRes.text();

    let starBurst = false;
    if (repoData.stargazers_count > 5000) {
      try {
        starBurst = await sampleStarBurst(owner, repo, repoData, token);
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
        // Sampling is best-effort; any other failure just skips the flag.
      }
    }

    return {
      repo: {
        stargazers_count: repoData.stargazers_count,
        forks_count: repoData.forks_count,
        created_at: repoData.created_at,
        pushed_at: repoData.pushed_at,
        archived: repoData.archived,
        fork: repoData.fork,
        license: repoData.license
          ? { spdx_id: repoData.license.spdx_id, name: repoData.license.name }
          : null,
        parent: repoData.parent ? { full_name: repoData.parent.full_name } : undefined
      },
      contributors: (contributors || []).map((c) => ({
        login: c.login, contributions: c.contributions
      })),
      contributorsUnavailable,
      hasRelease,
      hasTags,
      readme: readme ? readme.slice(0, 200000) : null,
      starBurst
    };
  }

  // ---------- panel rendering --------------------------------------------------

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

  function openSettings(e) {
    e.preventDefault();
    window.open(chrome.runtime.getURL('options.html'));
  }

  function renderPanel(repoFull, result, cachedAt, fromCache) {
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
    const cacheKey = 'rrc-cache:' + target.full;

    try {
      if (!force) {
        const cached = (await storageGet([cacheKey]))[cacheKey];
        if (cached && cached.v === CACHE_VERSION &&
            Date.now() - cached.cachedAt < CACHE_TTL_MS) {
          if (seq !== loadSeq) return;
          renderPanel(target.full, cached.result, cached.cachedAt, true);
          return;
        }
      }

      const token = (await storageGet(['githubToken'])).githubToken || '';
      const data = await fetchRepoData(target.owner, target.repo, token);
      if (seq !== loadSeq) return; // user navigated away mid-fetch
      if (!data) {
        removePanel();
        return;
      }

      const result = computeScore(data);
      const cachedAt = Date.now();
      await storageSet({ [cacheKey]: { v: CACHE_VERSION, data, result, cachedAt } });
      if (seq !== loadSeq) return;
      renderPanel(target.full, result, cachedAt, false);
    } catch (e) {
      if (seq !== loadSeq) return;
      if (e instanceof RateLimitError) {
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
