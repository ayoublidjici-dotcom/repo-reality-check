/*
 * Repo Reality Check — shared runtime.
 * Loaded by the content scripts, the extension pages (options/compare), and
 * the background service worker (via importScripts). Everything that touches
 * the GitHub API, the 6h cache, or the saved token lives here so all surfaces
 * share one pipeline. Requires scoring.js (computeScore) to be loaded first.
 */

'use strict';

const RRC = (() => {
  const RESERVED_OWNERS = new Set([
    'settings', 'search', 'marketplace', 'topics', 'orgs', 'sponsors',
    'notifications', 'explore', 'codespaces', 'features', 'pulls', 'issues',
    'about', 'pricing', 'login', 'join'
  ]);

  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  // Bump when the data shape or scoring rules change, so cached results
  // computed under old rules are refetched instead of shown for up to 6h.
  const CACHE_VERSION = 2;

  class RateLimitError extends Error {}

  function parseRepoPath(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    const [owner, repo] = parts;
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    return { owner, repo, full: owner + '/' + repo };
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  async function getToken() {
    return (await storageGet(['githubToken'])).githubToken || '';
  }

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

  function cacheKey(full) {
    return 'rrc-cache:' + full;
  }

  async function getCached(full) {
    const key = cacheKey(full);
    const entry = (await storageGet([key]))[key];
    if (entry && entry.v === CACHE_VERSION &&
        Date.now() - entry.cachedAt < CACHE_TTL_MS) {
      return entry; // { v, data, result, cachedAt }
    }
    return null;
  }

  /*
   * The one entry point every surface uses: cache-first score of owner/repo.
   * Returns { data, result, cachedAt, fromCache } or null for a 404.
   * Throws RateLimitError when GitHub's quota is exhausted.
   */
  async function scoreAndCache(owner, repo, opts) {
    const full = owner + '/' + repo;
    if (!opts || !opts.force) {
      const cached = await getCached(full);
      if (cached) {
        return { data: cached.data, result: cached.result, cachedAt: cached.cachedAt, fromCache: true };
      }
    }
    const token = await getToken();
    const data = await fetchRepoData(owner, repo, token);
    if (!data) return null;
    const result = computeScore(data);
    const cachedAt = Date.now();
    await storageSet({ [cacheKey(full)]: { v: CACHE_VERSION, data, result, cachedAt } });
    return { data, result, cachedAt, fromCache: false };
  }

  return {
    RESERVED_OWNERS, CACHE_TTL_MS, CACHE_VERSION, RateLimitError,
    parseRepoPath, storageGet, storageSet, getToken,
    getCached, scoreAndCache
  };
})();
