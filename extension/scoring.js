/*
 * Repo Reality Check — scoring.
 *
 * computeScore(data) is a pure function: no network, no DOM, no chrome.*,
 * so it can be exercised from test.html (or Node) with fake data.
 *
 * data = {
 *   repo: {            // subset of GET /repos/{owner}/{repo}
 *     stargazers_count, created_at, pushed_at, archived, fork,
 *     license: { spdx_id, name } | null,
 *     parent: { full_name } | undefined
 *   },
 *   contributors: [{ login, contributions }, ...],   // top 10, may be []
 *   hasRelease: boolean,
 *   readme: string | null,
 *   starBurst: boolean,
 *   now: optional ms timestamp (defaults to Date.now(), injectable for tests)
 * }
 *
 * Returns { score, band: {key, label}, reasons: [...] }.
 * Each reason: { id, severity: 'red'|'amber'|'neutral', points, text }.
 * points is the deduction taken (0 for informational flags).
 */

const RRC_HYPE_PATTERNS = [
  /world['’]s first/gi,
  /world['’]s best/gi,
  /#1(?![0-9])/g,
  /revolutionary/gi,
  /game[- ]changing/gi,
  /blazingly fast/gi,
  /the last .{1,60}? you['’]?ll ever need/gi,
  /\b10x\b/gi,
  /\bsecret\b/gi
];

function rrcCountHype(text) {
  let count = 0;
  for (const re of RRC_HYPE_PATTERNS) {
    const m = text.match(re);
    if (m) count += m.length;
  }
  return count;
}

function rrcCountAffiliateLinks(text) {
  const m = text.match(/[?&]ref=/g);
  return m ? m.length : 0;
}

function computeScore(data) {
  const repo = data.repo || {};
  const contributors = data.contributors || [];
  const readme = data.readme || '';
  const now = data.now || Date.now();
  const stars = repo.stargazers_count || 0;
  const reasons = [];
  let score = 100;

  function deduct(points, id, severity, text) {
    score -= points;
    reasons.push({ id, severity, points, text });
  }

  // Bus factor: top contributor's share of the top-10 contributions.
  const sumTop10 = contributors.reduce((s, c) => s + (c.contributions || 0), 0);
  if (sumTop10 > 0) {
    const top = contributors[0];
    const share = (top.contributions / sumTop10) * 100;
    const shareText = share.toFixed(1) + '% of top-10 contributions (' +
      top.contributions + ' of ' + sumTop10 + ')';
    if (share > 90) {
      deduct(20, 'bus-factor', 'red',
        'Bus factor: one contributor (' + top.login + ') has ' + shareText + '.');
    } else if (share > 75) {
      deduct(10, 'bus-factor', 'amber',
        'Bus factor: one contributor (' + top.login + ') has ' + shareText + '.');
    }
  }

  // Stars vs substance.
  if (stars > 5000 && sumTop10 < 500) {
    deduct(15, 'stars-vs-substance', 'red',
      'Stars vs substance: ' + stars.toLocaleString() +
      ' stars but only ' + sumTop10 + ' total contributions from the top 10 contributors.');
  }
  if (stars > 20000 && contributors.length < 3) {
    deduct(15, 'stars-vs-contributors', 'red',
      'Stars vs substance: ' + stars.toLocaleString() +
      ' stars but only ' + contributors.length + ' contributor' +
      (contributors.length === 1 ? '' : 's') + ' listed.');
  }

  // Releases.
  if (stars > 2000 && !data.hasRelease) {
    deduct(10, 'no-releases', 'amber',
      'No releases despite ' + stars.toLocaleString() + ' stars.');
  }

  // Staleness.
  if (repo.pushed_at) {
    const days = Math.floor((now - Date.parse(repo.pushed_at)) / 86400000);
    if (days > 365) {
      deduct(20, 'stale', 'red',
        'Stale: last push was ' + days + ' days ago (over 12 months).');
    } else if (days > 182) {
      deduct(10, 'stale', 'amber',
        'Quiet: last push was ' + days + ' days ago (over 6 months).');
    }
  }
  if (repo.archived) {
    deduct(30, 'archived', 'red', 'Repository is archived — no longer maintained.');
  }

  // README red flags.
  if (readme) {
    const affiliates = rrcCountAffiliateLinks(readme);
    if (affiliates > 0) {
      const points = Math.min(affiliates * 5, 15);
      deduct(points, 'affiliate-links', points >= 15 ? 'red' : 'amber',
        'README contains ' + affiliates + ' link' + (affiliates === 1 ? '' : 's') +
        ' with ?ref=/&ref= tracking (affiliate-style).');
    }
    const hype = rrcCountHype(readme);
    if (hype >= 3) {
      deduct(10, 'hype', 'amber',
        'README hype: ' + hype + ' marketing phrases ("revolutionary", "blazingly fast", …).');
    }
  }

  // Star burst (approximate — sampled from first/last stargazer pages).
  if (data.starBurst) {
    deduct(15, 'star-burst', 'red',
      'Star burst (approximate): sampling suggests a large share of the ' +
      stars.toLocaleString() + ' stars landed within a ~14-day window.');
  }

  // License.
  const spdx = repo.license && repo.license.spdx_id;
  if (!repo.license) {
    deduct(5, 'no-license', 'amber',
      'No license — legally all rights reserved; you may not have the right to use this code.');
  } else if (spdx && spdx.toUpperCase().startsWith('AGPL')) {
    reasons.push({
      id: 'agpl', severity: 'amber', points: 0,
      text: 'AGPL — building a commercial service on this may require open-sourcing your code.'
    });
  }

  // Fork note (neutral, no deduction; the fork is scored on its own activity).
  if (repo.fork) {
    reasons.push({
      id: 'fork', severity: 'neutral', points: 0,
      text: 'Fork of ' + (repo.parent && repo.parent.full_name ? repo.parent.full_name : 'another repository') + '.'
    });
  }

  score = Math.max(0, Math.min(100, score));

  let band;
  if (score >= 80) band = { key: 'green', label: 'Healthy signals' };
  else if (score >= 50) band = { key: 'amber', label: 'Check the flags' };
  else band = { key: 'red', label: 'High hype risk' };

  return { score, band, reasons };
}

// Allow test.html / Node to import; content.js just uses the global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeScore };
}
