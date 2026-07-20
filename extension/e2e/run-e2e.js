'use strict';
/*
 * End-to-end test for the Repo Reality Check extension.
 * Loads the real unpacked extension into Chromium (new headless) and mocks
 * github.com + api.github.com via Playwright network interception, so the
 * real content scripts, chrome.storage cache, service worker, and fetch
 * paths are exercised.
 *
 *   npm install && npm test     (from extension/e2e/)
 *
 * Phases:
 *   1  v1 behavior: panels, SPA nav, cache, options token, restart, headers
 *   2  Pro gating: locked affordances without / with-invalid key
 *   3  Pro enabled with RRC-TESTTESTTEST1234
 *   4  Compare view (cached repos → zero API calls)
 *   5  Search badges with token (concurrency ≤ 2, cache on reload)
 *   6  Search badges without token (5 auto + click-to-score + notice)
 *   7  Trending badges + SPA nav, never double-badge
 *   8  Watchlist: persistence, alarm, forced re-check, band-change notification
 */

// Route interception must also cover the background service worker's fetches
// (the watchlist re-check runs there). Set before playwright-core loads.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const EXT_PATH = path.join(__dirname, '..');
const CHROME = process.env.RRC_CHROMIUM || '/opt/pw-browsers/chromium';
const USER_DATA = path.join(__dirname, 'profile');

const NOW = Date.now();
const DAY = 86400000;
const HOUR = 3600000;
const iso = (t) => new Date(t).toISOString();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- unit-level guard: pro key pattern ----------------

const { isProKey } = require('../pro.js');

// ---------------- mock GitHub data ----------------

function mkRepo(owner, name, opts) {
  return Object.assign({
    full_name: owner + '/' + name,
    stargazers_count: 100,
    forks_count: 10,
    created_at: iso(NOW - 400 * DAY),
    pushed_at: iso(NOW - 1 * DAY),
    archived: false,
    fork: false,
    license: { spdx_id: 'MIT', name: 'MIT License' }
  }, opts);
}

function smallFixture(owner, name) {
  return {
    repo: mkRepo(owner, name),
    contributors: [
      { login: 'a', contributions: 60 },
      { login: 'b', contributions: 40 }
    ],
    releases: [{ tag_name: 'v1' }],
    tags: [{ name: 'v1' }],
    readme: 'Plain readme for ' + owner + '/' + name
  };
}

const REPOS = {
  'curl/curl': {
    repo: mkRepo('curl', 'curl', {
      stargazers_count: 37000,
      created_at: iso(NOW - 15 * 365 * DAY),
      license: { spdx_id: 'curl', name: 'curl License' }
    }),
    contributors: [
      { login: 'bagder', contributions: 30000 },
      { login: 'core2', contributions: 9000 },
      { login: 'core3', contributions: 2100 },
      { login: 'core4', contributions: 1400 },
      { login: 'core5', contributions: 900 },
      { login: 'core6', contributions: 700 },
      { login: 'core7', contributions: 500 },
      { login: 'core8', contributions: 400 },
      { login: 'core9', contributions: 300 },
      { login: 'core10', contributions: 250 }
    ],
    releases: [{ tag_name: 'curl-8_9_0' }],
    tags: [{ name: 'curl-8_9_0' }],
    readme: 'curl — command line tool and library for transferring data with URLs.'
  },
  'torvalds/linux': {
    repo: mkRepo('torvalds', 'linux', {
      stargazers_count: 195000,
      created_at: '2011-09-04T22:48:12Z',
      license: { spdx_id: 'GPL-2.0', name: 'GNU General Public License v2.0' }
    }),
    contributorsError: true, // GitHub's 403 "list too large"
    releases: [],
    tags: [{ name: 'v6.11' }],
    readme: 'Linux kernel source tree.'
  },
  'hyperepo/hyperepo': {
    repo: mkRepo('hyperepo', 'hyperepo', {
      stargazers_count: 36900,
      created_at: iso(NOW - 550 * DAY)
    }),
    contributors: [
      { login: 'soloauthor', contributions: 97 },
      { login: 'driveby1', contributions: 2 },
      { login: 'driveby2', contributions: 1 }
    ],
    releases: [],
    tags: [],
    readme: 'Try [vpn](https://vpn.example.com/?ref=hyperepo), ' +
      '[host](https://host.example.com/x?a=1&ref=hyperepo), ' +
      '[course](https://learn.example.com/?ref=hyperepo).'
  },
  'tokenuser/tokenrepo': smallFixture('tokenuser', 'tokenrepo')
};
for (let i = 1; i <= 5; i++) REPOS['cacheuser/repo' + i] = smallFixture('cacheuser', 'repo' + i);
for (let i = 1; i <= 8; i++) REPOS['searchuser/s' + i] = smallFixture('searchuser', 's' + i);
for (let i = 1; i <= 8; i++) REPOS['lateuser/u' + i] = smallFixture('lateuser', 'u' + i);

const SEARCHES = {
  alpha: Array.from({ length: 8 }, (_, i) => 'searchuser/s' + (i + 1)),
  beta: Array.from({ length: 8 }, (_, i) => 'lateuser/u' + (i + 1)).concat(['curl/curl'])
};
const TRENDING = ['searchuser/s1', 'curl/curl', 'torvalds/linux', 'cacheuser/repo2'];

// Evenly-spread stargazer timestamps (no burst) for stars>5000 repos.
function stargazersPage(repo) {
  const created = Date.parse(repo.created_at);
  const span = NOW - created - 30 * DAY;
  const out = [];
  for (let i = 0; i < 100; i++) {
    out.push({ starred_at: iso(created + 30 * DAY + (span * i) / 99) });
  }
  return out;
}

// ---------------- mock pages ----------------

function repoPageHtml(owner, name) {
  return '<!DOCTYPE html><html lang="en" data-color-mode="light"><head>' +
    '<meta charset="utf-8"><title>GitHub - ' + owner + '/' + name + '</title></head>' +
    '<body><main><div id="repo-content-pjax-container" class="repository-content">' +
    '<div id="readme"><h1>' + name + '</h1></div></div></main></body></html>';
}

function searchPageHtml(q) {
  const repos = SEARCHES[q] || [];
  const rows = repos.map((full) =>
    '<div class="res"><a href="/' + full.split('/')[0] + '">' + full.split('/')[0] + '</a> ' +
    '<a href="/' + full + '">' + full + '</a></div>').join('');
  return '<!DOCTYPE html><html lang="en" data-color-mode="light"><head>' +
    '<meta charset="utf-8"><title>Search - GitHub</title></head>' +
    '<body><main><h1>Repositories</h1><div data-testid="results-list">' + rows +
    '</div></main></body></html>';
}

function trendingPageHtml() {
  // Two anchors per repo on purpose — proves the scanner never double-badges.
  const rows = TRENDING.map((full) =>
    '<article class="Box-row"><h2><a href="/' + full + '">' + full.replace('/', ' / ') +
    '</a></h2><p><a href="/' + full + '">' + full + ' again</a></p></article>').join('');
  return '<!DOCTYPE html><html lang="en" data-color-mode="light"><head>' +
    '<meta charset="utf-8"><title>Trending - GitHub</title></head>' +
    '<body><main>' + rows + '</main></body></html>';
}

// ---------------- request routing ----------------

const apiLog = []; // { url, auth, t }

// Repo-level concurrency tracker: how many distinct repos have API requests
// in flight at once (each request is held open ~100ms by the mock).
const cc = {
  active: new Map(), max: 0,
  reset() { this.active.clear(); this.max = 0; },
  enter(k) { this.active.set(k, (this.active.get(k) || 0) + 1); this.max = Math.max(this.max, this.active.size); },
  exit(k) { const n = (this.active.get(k) || 1) - 1; if (n <= 0) this.active.delete(k); else this.active.set(k, n); }
};

async function installRoutes(context) {
  await context.route('https://github.com/**', (route) => {
    const u = new URL(route.request().url());
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.pathname === '/search') {
      const type = u.searchParams.get('type');
      const q = u.searchParams.get('q');
      return route.fulfill({
        contentType: 'text/html',
        body: type === 'repositories'
          ? searchPageHtml(q)
          : '<!DOCTYPE html><html><head><title>Search</title></head><body><main>no repo results</main></body></html>'
      });
    }
    if (u.pathname === '/trending') {
      return route.fulfill({ contentType: 'text/html', body: trendingPageHtml() });
    }
    if (parts.length === 2) {
      return route.fulfill({ contentType: 'text/html', body: repoPageHtml(parts[0], parts[1]) });
    }
    return route.fulfill({ status: 404, contentType: 'text/html', body: '<html><title>404</title><body>404</body></html>' });
  });

  await context.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    apiLog.push({ url: u.pathname + u.search, auth: req.headers()['authorization'] || null, t: Date.now() });

    const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    const key = m ? m[1] + '/' + m[2] : null;
    const fixture = key && REPOS[key];

    cc.enter(key || 'unknown');
    await delay(100); // hold requests open so concurrency is observable
    const done = () => cc.exit(key || 'unknown');

    const json = (obj, init) => {
      done();
      return route.fulfill(Object.assign({
        contentType: 'application/json',
        headers: Object.assign({ 'x-ratelimit-remaining': '4999' }, (init && init.headers) || {}),
        body: JSON.stringify(obj)
      }, init && init.status ? { status: init.status } : {}));
    };

    if (!fixture) return json({ message: 'Not Found' }, { status: 404 });

    const sub = m[3] || '';
    if (sub === '') return json(fixture.repo);
    if (sub === 'contributors') {
      if (fixture.contributorsError) {
        return json({ message: 'The history or contributor list is too large to list contributors for this repository via the API.' }, { status: 403 });
      }
      return json(fixture.contributors);
    }
    if (sub === 'releases') return json(fixture.releases);
    if (sub === 'tags') return json(fixture.tags);
    if (sub === 'readme') { done(); return route.fulfill({ contentType: 'text/plain', headers: { 'x-ratelimit-remaining': '4999' }, body: fixture.readme }); }
    if (sub === 'stargazers') return json(stargazersPage(fixture.repo)); // no Link header → single-page sample
    return json({ message: 'Not Found' }, { status: 404 });
  });
}

// ---------------- harness ----------------

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ' — ' + detail : ''));
}

async function launch() {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    executablePath: CHROME,
    headless: true,
    args: [
      '--disable-extensions-except=' + EXT_PATH,
      '--load-extension=' + EXT_PATH,
      '--no-sandbox'
    ]
  });
  await installRoutes(context);
  return context;
}

const pageErrors = [];
function watchErrors(page) {
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location() || {};
      pageErrors.push(msg.text() + ' @ ' + (loc.url || 'unknown'));
    }
  });
}

async function waitPanel(page, repoFull) {
  await page.waitForFunction(
    (full) => {
      const p = document.getElementById('rrc-panel');
      return p && p.dataset.rrcRepo === full;
    }, repoFull, { timeout: 20000 });
}

async function panelInfo(page) {
  return page.evaluate(() => {
    const panels = document.querySelectorAll('#rrc-panel, .rrc');
    const p = document.getElementById('rrc-panel');
    const reasons = [...p.querySelectorAll('.rrc-reason-text')].map((n) => n.textContent);
    return {
      count: new Set([...panels]).size,
      repo: p.dataset.rrcRepo,
      score: p.querySelector('.rrc-score') ? p.querySelector('.rrc-score').textContent : null,
      band: p.querySelector('.rrc-left') ? p.querySelector('.rrc-left').className : '',
      chips: [...p.querySelectorAll('.rrc-chip')].map((n) => n.textContent),
      reasons,
      lockedFooter: [...p.querySelectorAll('.rrc-footer .rrc-pro-locked')].map((n) => n.textContent.replace('Pro', '').trim()),
      proTags: p.querySelectorAll('.rrc-footer .rrc-pro-tag').length
    };
  });
}

async function badgeStats(page, prefix) {
  return page.evaluate((pre) => {
    const badges = [...document.querySelectorAll('.rrc-badge')]
      .filter((b) => !pre || (b.dataset.rrcFull || '').startsWith(pre));
    const byState = {};
    const perRepo = {};
    for (const b of badges) {
      byState[b.dataset.state] = (byState[b.dataset.state] || 0) + 1;
      perRepo[b.dataset.rrcFull] = (perRepo[b.dataset.rrcFull] || 0) + 1;
    }
    return {
      total: badges.length,
      byState,
      maxPerRepo: Math.max(0, ...Object.values(perRepo)),
      noticePresent: !!document.getElementById('rrc-badge-notice'),
      noticeHasSettingsLink: !!document.querySelector('#rrc-badge-notice a')
    };
  }, prefix || '');
}

async function waitBadges(page, prefix, state, count) {
  await page.waitForFunction(({ pre, st, n }) => {
    const badges = [...document.querySelectorAll('.rrc-badge')]
      .filter((b) => !pre || (b.dataset.rrcFull || '').startsWith(pre));
    return badges.filter((b) => b.dataset.state === st).length >= n;
  }, { pre: prefix || '', st: state, n: count }, { timeout: 30000 });
}

function storageRead(page, keys) {
  return page.evaluate((ks) => new Promise((res) => chrome.storage.local.get(ks, res)), keys);
}

(async () => {
  // Pro key pattern guard (node-side).
  check('isProKey accepts RRC-TESTTESTTEST1234 and rejects RRC-SHORT',
    isProKey('RRC-TESTTESTTEST1234') && !isProKey('RRC-SHORT') && !isProKey(''),
    '');

  fs.rmSync(USER_DATA, { recursive: true, force: true });
  let context = await launch();

  // ============ Phase 1 — v1 behavior (unchanged) ============
  const page = await context.newPage();
  watchErrors(page);

  await page.goto('https://github.com/curl/curl');
  await waitPanel(page, 'curl/curl');
  let info = await panelInfo(page);
  check('curl/curl renders one panel', info.count === 1, 'count=' + info.count);
  check('curl/curl scores green >= 80',
    Number(info.score) >= 80 && info.band.includes('rrc-band-green'),
    'score=' + info.score + ' band=' + info.band);

  await page.goto('https://github.com/torvalds/linux');
  await waitPanel(page, 'torvalds/linux');
  info = await panelInfo(page);
  check('torvalds/linux renders one panel', info.count === 1, 'count=' + info.count);
  check('torvalds/linux scores green >= 80',
    Number(info.score) >= 80 && info.band.includes('rrc-band-green'),
    'score=' + info.score + ' band=' + info.band);
  check('torvalds/linux has no false-positive reasons',
    !info.reasons.some((t) => /Stars vs substance|No releases/i.test(t)),
    JSON.stringify(info.reasons));

  await page.goto('https://github.com/hyperepo/hyperepo');
  await waitPanel(page, 'hyperepo/hyperepo');
  await page.click('#rrc-panel .rrc-toggle');
  info = await panelInfo(page);
  check('hype repo scores red <= 50',
    Number(info.score) <= 50 && info.band.includes('rrc-band-red'),
    'score=' + info.score + ' band=' + info.band);
  const wantReasons = [/Bus factor/i, /Stars vs substance/i, /No releases or tags/i, /ref=.*tracking|affiliate/i];
  check('hype repo shows all four reasons',
    wantReasons.every((re) => info.reasons.some((t) => re.test(t))),
    JSON.stringify(info.reasons));
  check('hype repo shows up to 3 chips', info.chips.length === 3, 'chips=' + info.chips.length);

  // SPA navigation curl → linux → back, one panel each time.
  await page.goto('https://github.com/curl/curl');
  await waitPanel(page, 'curl/curl');
  await page.evaluate(() => {
    history.pushState({}, '', '/torvalds/linux');
    document.title = 'GitHub - torvalds/linux';
  });
  await waitPanel(page, 'torvalds/linux');
  info = await panelInfo(page);
  check('SPA nav curl→linux: one panel, linux data',
    info.count === 1 && info.repo === 'torvalds/linux',
    'count=' + info.count + ' repo=' + info.repo);
  await page.evaluate(() => history.back());
  await waitPanel(page, 'curl/curl');
  info = await panelInfo(page);
  check('SPA nav back→curl: one panel, curl data',
    info.count === 1 && info.repo === 'curl/curl',
    'count=' + info.count + ' repo=' + info.repo);

  // Cache: visit 5 repos, revisit all 5, zero extra API calls.
  const five = ['cacheuser/repo1', 'cacheuser/repo2', 'cacheuser/repo3', 'cacheuser/repo4', 'cacheuser/repo5'];
  for (const r of five) {
    await page.goto('https://github.com/' + r);
    await waitPanel(page, r);
  }
  const callsAfterFirstVisits = apiLog.length;
  for (const r of five) {
    await page.goto('https://github.com/' + r);
    await waitPanel(page, r);
  }
  await page.waitForTimeout(500);
  const extra = apiLog.length - callsAfterFirstVisits;
  check('revisiting 5 repos makes zero API calls', extra === 0,
    'extra calls=' + extra + (extra ? ' → ' + JSON.stringify(apiLog.slice(callsAfterFirstVisits).map(x => x.url)) : ''));

  // Settings link opens options page (also yields the extension id).
  await page.click('#rrc-panel .rrc-toggle');
  const [optionsPopup] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }),
    page.click('#rrc-panel .rrc-footer a:has-text("settings")')
  ]);
  await optionsPopup.waitForLoadState();
  const optionsUrl = optionsPopup.url();
  check('settings link opens options page',
    /^chrome-extension:\/\/[a-p]{32}\/options\.html$/.test(optionsUrl), optionsUrl);

  // Save token, restart browser, verify persistence + Authorization header.
  await optionsPopup.fill('#token', 'ghp_e2e_test_token_123');
  await optionsPopup.click('#save');
  await optionsPopup.waitForSelector('#status:has-text("Saved.")');
  check('options page saves token', true, '');

  await context.close();
  context = await launch();

  let page2 = await context.newPage();
  watchErrors(page2);
  await page2.goto(optionsUrl);
  const persisted = await page2.inputValue('#token');
  check('token persists after browser restart',
    persisted === 'ghp_e2e_test_token_123', 'token=' + JSON.stringify(persisted));

  let mark = apiLog.length;
  await page2.goto('https://github.com/tokenuser/tokenrepo');
  await waitPanel(page2, 'tokenuser/tokenrepo');
  const tokenCalls = apiLog.slice(mark);
  check('API requests carry Authorization header after token save',
    tokenCalls.length > 0 && tokenCalls.every((c) => c.auth === 'Bearer ghp_e2e_test_token_123'),
    tokenCalls.map((c) => c.url + ' auth=' + c.auth).join('; '));

  // ============ Phase 2 — Pro gating: no key ============
  await page2.goto('https://github.com/curl/curl');
  await waitPanel(page2, 'curl/curl');
  await page2.click('#rrc-panel .rrc-toggle');
  info = await panelInfo(page2);
  check('no key: compare + watch render locked with Pro tags',
    info.lockedFooter.length === 2 &&
    info.lockedFooter.includes('compare') && info.proTags === 2,
    'locked=' + JSON.stringify(info.lockedFooter) + ' tags=' + info.proTags);

  const [proPopup] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }),
    page2.click('#rrc-panel .rrc-footer .rrc-pro-locked:has-text("compare")')
  ]);
  await proPopup.waitForLoadState();
  check('locked affordance opens options.html#pro',
    proPopup.url() === optionsUrl + '#pro', proPopup.url());
  await proPopup.close();

  mark = apiLog.length;
  await page2.goto('https://github.com/search?q=alpha&type=repositories');
  await page2.waitForSelector('.rrc-badge');
  await page2.waitForTimeout(600);
  let stats = await badgeStats(page2);
  check('no key: search badges render locked, zero API calls',
    stats.total === 8 && stats.byState.locked === 8 &&
    !stats.noticePresent && apiLog.length === mark,
    JSON.stringify(stats.byState) + ' calls=' + (apiLog.length - mark));

  // ============ Phase 3 — invalid key stays locked, valid key unlocks ============
  await page2.goto(optionsUrl);
  await page2.fill('#license', 'RRC-SHORT');
  await page2.click('#save');
  await page2.waitForSelector('#status:has-text("Saved.")');
  const invalidStatus = await page2.getAttribute('#key-status', 'class');
  check('options flags RRC-SHORT as invalid', /invalid/.test(invalidStatus), invalidStatus);

  await page2.goto('https://github.com/curl/curl');
  await waitPanel(page2, 'curl/curl');
  await page2.click('#rrc-panel .rrc-toggle');
  info = await panelInfo(page2);
  check('invalid key: affordances stay locked', info.lockedFooter.length === 2,
    'locked=' + JSON.stringify(info.lockedFooter));

  await page2.goto(optionsUrl);
  await page2.fill('#license', 'RRC-TESTTESTTEST1234');
  await page2.click('#save');
  await page2.waitForSelector('#status:has-text("Saved.")');
  const validStatus = await page2.getAttribute('#key-status', 'class');
  check('options flags RRC-TESTTESTTEST1234 as valid', /valid/.test(validStatus) && !/invalid/.test(validStatus), validStatus);

  await page2.goto('https://github.com/curl/curl');
  await waitPanel(page2, 'curl/curl');
  await page2.click('#rrc-panel .rrc-toggle');
  info = await panelInfo(page2);
  check('valid key: compare + watch active (nothing locked)',
    info.lockedFooter.length === 0, 'locked=' + JSON.stringify(info.lockedFooter));

  // ============ Phase 4 — compare view ============
  mark = apiLog.length;
  const [comparePage] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }),
    page2.click('#rrc-panel .rrc-footer a:has-text("compare")')
  ]);
  await comparePage.waitForLoadState();
  watchErrors(comparePage);
  check('compare link opens compare.html with prefilled left',
    comparePage.url().includes('/compare.html?left=curl%2Fcurl'), comparePage.url());
  check('compare left input prefilled', (await comparePage.inputValue('#left')) === 'curl/curl', '');

  await comparePage.fill('#right', 'torvalds/linux');
  await comparePage.click('#go');
  await comparePage.waitForSelector('#table:not([hidden])', { timeout: 15000 });
  const cmp = await comparePage.evaluate(() => {
    const rows = [...document.querySelectorAll('#rows tr')];
    return {
      rowCount: rows.length,
      allAligned: rows.every((tr) => tr.children.length === 3),
      heads: [document.getElementById('head-left').textContent, document.getElementById('head-right').textContent],
      scores: [...document.querySelectorAll('#rows .score')].map((n) => n.textContent)
    };
  });
  check('compare renders aligned signal rows for both repos',
    cmp.rowCount >= 15 && cmp.allAligned &&
    cmp.heads[0] === 'curl/curl' && cmp.heads[1] === 'torvalds/linux',
    JSON.stringify(cmp));
  check('compare scores match (100 vs 100)',
    cmp.scores.join(',') === '100,100', cmp.scores.join(','));
  check('compare of cached repos makes zero API calls',
    apiLog.length === mark, 'calls=' + (apiLog.length - mark));
  await comparePage.close();

  // ============ Phase 5 — search badges with token ============
  mark = apiLog.length;
  cc.reset();
  await page2.goto('https://github.com/search?q=alpha&type=repositories');
  await waitBadges(page2, 'searchuser/', 'scored', 8);
  stats = await badgeStats(page2, 'searchuser/');
  const alphaCalls = apiLog.slice(mark);
  check('with token: all 8 visible results get scored badges',
    stats.total === 8 && stats.byState.scored === 8, JSON.stringify(stats.byState));
  check('badge scoring makes exactly 4 calls per repo',
    alphaCalls.length === 32, 'calls=' + alphaCalls.length);
  check('badge scoring concurrency ≤ 2 repos in flight',
    cc.max <= 2 && cc.max >= 1, 'max concurrent repos=' + cc.max);

  mark = apiLog.length;
  await page2.reload();
  await waitBadges(page2, 'searchuser/', 'scored', 8);
  await page2.waitForTimeout(400);
  check('reloading search uses the cache (zero API calls)',
    apiLog.length === mark, 'calls=' + (apiLog.length - mark));

  // ============ Phase 6 — search badges without token ============
  await page2.goto(optionsUrl);
  await page2.fill('#token', '');
  await page2.click('#save');
  await page2.waitForSelector('#status:has-text("Saved.")');

  await page2.goto('https://github.com/search?q=beta&type=repositories');
  await waitBadges(page2, 'lateuser/', 'scored', 5);
  await waitBadges(page2, 'lateuser/', 'plus', 3);
  stats = await badgeStats(page2, 'lateuser/');
  check('no token: exactly 5 auto-scored, 3 click-to-score',
    stats.byState.scored === 5 && stats.byState.plus === 3, JSON.stringify(stats.byState));
  const curlBadge = await badgeStats(page2, 'curl/');
  check('no token: cached repo still gets a free badge',
    curlBadge.byState.scored === 1, JSON.stringify(curlBadge.byState));
  stats = await badgeStats(page2);
  check('no token: inline notice present and links to settings',
    stats.noticePresent && stats.noticeHasSettingsLink, JSON.stringify(stats));

  await page2.click('.rrc-badge[data-state="plus"]');
  await waitBadges(page2, 'lateuser/', 'scored', 6);
  stats = await badgeStats(page2, 'lateuser/');
  check('clicking ＋ scores that repo',
    stats.byState.scored === 6 && (stats.byState.plus || 0) === 2, JSON.stringify(stats.byState));

  // ============ Phase 7 — trending + SPA nav, never double-badge ============
  mark = apiLog.length;
  await page2.goto('https://github.com/trending');
  await waitBadges(page2, '', 'scored', 4);
  await page2.waitForTimeout(400);
  stats = await badgeStats(page2);
  check('trending: all 4 repos badged once despite duplicate anchors',
    stats.total === 4 && stats.maxPerRepo === 1, JSON.stringify(stats));
  check('trending with warm cache: zero API calls',
    apiLog.length === mark, 'calls=' + (apiLog.length - mark));

  await page2.evaluate(() => {
    history.pushState({}, '', '/curl/curl');
    document.title = 'GitHub - curl/curl';
  });
  await waitPanel(page2, 'curl/curl');
  await page2.evaluate(() => history.back());
  await page2.waitForFunction(() => !document.getElementById('rrc-panel'), null, { timeout: 10000 });
  await page2.waitForTimeout(600);
  stats = await badgeStats(page2);
  check('SPA trending→repo→back: panel gone, badges intact, no duplicates',
    stats.total === 4 && stats.maxPerRepo === 1, JSON.stringify(stats));

  // ============ Phase 8 — watchlist ============
  await page2.goto('https://github.com/cacheuser/repo1');
  await waitPanel(page2, 'cacheuser/repo1');
  await page2.click('#rrc-panel .rrc-toggle');
  await page2.click('#rrc-panel .rrc-watch');
  await page2.waitForSelector('#rrc-panel .rrc-watch:has-text("watching")');
  check('watch toggle marks repo as watching', true, '');

  await page2.goto(optionsUrl);
  await page2.waitForSelector('#watchlist table');

  // Simulate the weekly pass finding a change: age the cache entry beyond its
  // 6h TTL and flip the fixture to archived (100 green → 70 amber), then force
  // the same re-check the alarm runs.
  //
  // Playwright quirk: it can only intercept the service worker's network when
  // it observes the worker spawn. Stop any live worker first so the "Check
  // now" message wakes a fresh, fully-intercepted one.
  const cdp = await context.newCDPSession(page2);
  await cdp.send('ServiceWorker.enable').catch(() => {});
  await cdp.send('ServiceWorker.stopAllWorkers').catch(() => {});
  await page2.waitForTimeout(500);

  await page2.evaluate(() => new Promise((res) => {
    const key = 'rrc-cache:cacheuser/repo1';
    chrome.storage.local.get([key], (o) => {
      const entry = o[key];
      entry.cachedAt = Date.now() - 7 * 3600 * 1000;
      chrome.storage.local.set({ [key]: entry }, res);
    });
  }));
  REPOS['cacheuser/repo1'].repo.archived = true;

  await page2.click('#check-now');
  await page2.waitForSelector('#check-status:has-text("Checked 1 repo, 1 band change.")', { timeout: 20000 });
  let wlRow = await page2.evaluate(() => {
    const tr = document.querySelector('#watchlist tbody tr');
    return { cells: [...tr.children].map((td) => td.textContent.trim()), scoreClass: tr.children[1].className };
  });
  check('forced re-check re-scores the watched repo (100 → 70 amber)',
    wlRow.cells[1] === '70' && /band-amber/.test(wlRow.scoreClass), JSON.stringify(wlRow));

  let notifLog = (await storageRead(page2, ['rrcNotifLog'])).rrcNotifLog || [];
  check('band change fires exactly one notification',
    notifLog.length === 1 && notifLog[0].repo === 'cacheuser/repo1' &&
    notifLog[0].from === 'green' && notifLog[0].to === 'amber',
    JSON.stringify(notifLog));

  await page2.click('#check-now');
  await page2.waitForSelector('#check-status:has-text("Checked 1 repo.")', { timeout: 20000 });
  notifLog = (await storageRead(page2, ['rrcNotifLog'])).rrcNotifLog || [];
  check('re-checking again does not re-notify (band unchanged)',
    notifLog.length === 1, 'log length=' + notifLog.length);

  // Persistence: restart the browser, the watchlist and alarm must survive.
  await context.close();
  context = await launch();
  page2 = await context.newPage();
  watchErrors(page2);
  await page2.goto(optionsUrl);
  await page2.waitForSelector('#watchlist table');
  wlRow = await page2.evaluate(() => {
    const tr = document.querySelector('#watchlist tbody tr');
    return tr ? [...tr.children].map((td) => td.textContent.trim()) : null;
  });
  check('watchlist persists across browser restart',
    !!wlRow && wlRow[0] === 'cacheuser/repo1' && wlRow[1] === '70',
    JSON.stringify(wlRow));

  const alarms = await page2.evaluate(() => new Promise((res) => chrome.alarms.getAll(res)));
  check('weekly alarm is scheduled',
    alarms.some((a) => a.name === 'rrc-weekly-recheck' && a.periodInMinutes === 7 * 24 * 60),
    JSON.stringify(alarms.map((a) => a.name)));

  // ============ console/page errors ============
  // The 403 from torvalds/linux/contributors is GitHub's genuine behavior on
  // huge repos; the browser auto-logs every 4xx resource load as a console
  // "error". That's expected input we handle, not an extension defect.
  const relevant = pageErrors.filter((e) =>
    !/favicon/i.test(e) &&
    !(/status of 403/.test(e) && /torvalds\/linux\/contributors/.test(e)));
  check('zero unexpected console/page errors across all pages', relevant.length === 0,
    relevant.slice(0, 5).join(' | '));

  await context.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + results.length + ' checks, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
