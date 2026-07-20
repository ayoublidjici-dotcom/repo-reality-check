/*
 * Repo Reality Check — compare view (Pro).
 * Side-by-side columns for two repos, with every scoring signal's raw
 * numbers aligned in rows. Uses the shared cache — a cached repo costs
 * zero API calls.
 */

'use strict';

const leftInput = document.getElementById('left');
const rightInput = document.getElementById('right');
const goButton = document.getElementById('go');
const statusEl = document.getElementById('status');
const table = document.getElementById('table');
const rowsEl = document.getElementById('rows');

const DAY = 86400000;

function fmtDays(dateStr) {
  if (!dateStr) return '—';
  const days = Math.floor((Date.now() - Date.parse(dateStr)) / DAY);
  if (days > 365) return Math.floor(days / 365) + 'y ' + Math.floor((days % 365) / 30) + 'mo ago';
  if (days > 60) return Math.floor(days / 30) + 'mo ago';
  return days + 'd ago';
}

function busFactor(data) {
  const sum = data.contributors.reduce((s, c) => s + (c.contributions || 0), 0);
  if (data.contributorsUnavailable) return { text: 'unavailable (list too large)' };
  if (!sum) return { text: '—' };
  const top = data.contributors[0];
  const share = (top.contributions / sum) * 100;
  return { text: share.toFixed(1) + '% (' + top.login + ', ' + top.contributions + ' of ' + sum + ')', sum };
}

// Each row: [label, fn({data, result}) -> string | Node]
const ROWS = [
  ['Score', (e) => {
    const span = document.createElement('span');
    span.className = 'score band-' + e.result.band.key;
    span.textContent = String(e.result.score);
    return span;
  }],
  ['Band', (e) => {
    const span = document.createElement('span');
    span.className = 'band-' + e.result.band.key;
    span.textContent = e.result.band.label;
    return span;
  }],
  ['Stars', (e) => (e.data.repo.stargazers_count || 0).toLocaleString()],
  ['Forks', (e) => (e.data.repo.forks_count || 0).toLocaleString()],
  ['Created', (e) => fmtDays(e.data.repo.created_at)],
  ['Last push', (e) => fmtDays(e.data.repo.pushed_at)],
  ['Archived', (e) => e.data.repo.archived ? 'yes' : 'no'],
  ['License', (e) => e.data.repo.license
    ? (e.data.repo.license.spdx_id || e.data.repo.license.name || 'unknown')
    : 'none'],
  ['Releases', (e) => e.data.hasRelease ? 'yes'
    : (e.data.hasTags ? 'tags only' : 'none')],
  ['Top contributor share', (e) => busFactor(e.data).text],
  ['Top-10 contributions', (e) => {
    if (e.data.contributorsUnavailable) return 'unavailable';
    return String(e.data.contributors.reduce((s, c) => s + (c.contributions || 0), 0));
  }],
  ['Contributors listed', (e) => e.data.contributorsUnavailable
    ? 'unavailable' : String(e.data.contributors.length)],
  ['README affiliate links', (e) => String(e.data.readme ? rrcCountAffiliateLinks(e.data.readme) : 0)],
  ['README hype phrases', (e) => String(e.data.readme ? rrcCountHype(e.data.readme) : 0)],
  ['Star burst (approx.)', (e) => e.data.starBurst ? 'suspected' : 'not detected'],
  ['Fork', (e) => e.data.repo.fork
    ? ('of ' + (e.data.repo.parent ? e.data.repo.parent.full_name : '?')) : 'no'],
  ['Flags', (e) => {
    const flagged = e.result.reasons.filter((r) => r.points > 0 || r.severity === 'amber');
    if (!flagged.length) return '—';
    const ul = document.createElement('ul');
    ul.className = 'reasons';
    for (const r of flagged) {
      const li = document.createElement('li');
      li.className = 'band-' + (r.severity === 'red' ? 'red' : 'amber');
      li.textContent = (r.points ? '−' + r.points + ' ' : '') + r.text;
      ul.appendChild(li);
    }
    return ul;
  }],
  ['Data', (e) => {
    const span = document.createElement('span');
    span.className = 'muted';
    const when = new Date(e.cachedAt);
    span.textContent = (e.fromCache ? 'cached ' : 'fetched ') +
      String(when.getHours()).padStart(2, '0') + ':' +
      String(when.getMinutes()).padStart(2, '0');
    return span;
  }]
];

function parseInput(value) {
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//, '');
  return RRC.parseRepoPath('/' + trimmed);
}

async function loadSide(value) {
  const target = parseInput(value);
  if (!target) throw new Error('"' + value + '" is not an owner/repo');
  const res = await RRC.scoreAndCache(target.owner, target.repo, {});
  if (!res) throw new Error(target.full + ' not found on GitHub');
  return { full: target.full, entry: res };
}

async function compare() {
  statusEl.textContent = 'Loading…';
  table.hidden = true;
  try {
    const [left, right] = await Promise.all([
      loadSide(leftInput.value),
      loadSide(rightInput.value)
    ]);
    document.getElementById('head-left').textContent = left.full;
    document.getElementById('head-right').textContent = right.full;
    rowsEl.textContent = '';
    for (const [label, fn] of ROWS) {
      const tr = document.createElement('tr');
      const th = document.createElement('td');
      th.textContent = label;
      tr.appendChild(th);
      for (const side of [left, right]) {
        const td = document.createElement('td');
        const v = fn(side.entry);
        td.append(v);
        tr.appendChild(td);
      }
      rowsEl.appendChild(tr);
    }
    table.hidden = false;
    statusEl.textContent = '';
  } catch (e) {
    statusEl.textContent = e instanceof RRC.RateLimitError
      ? 'GitHub rate limit reached — add a free token in settings for 5,000 req/hr.'
      : String(e.message || e);
  }
}

(async () => {
  if (!(await isPro())) {
    document.getElementById('pro-gate').hidden = false;
    return;
  }
  document.getElementById('app').hidden = false;

  // Prefill the left side with the repo the user came from.
  const fromQuery = new URLSearchParams(location.search).get('left');
  if (fromQuery) leftInput.value = fromQuery;

  goButton.addEventListener('click', compare);
  for (const input of [leftInput, rightInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') compare();
    });
  }
})();
