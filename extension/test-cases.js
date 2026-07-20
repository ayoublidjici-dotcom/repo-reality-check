/*
 * Shared test cases for the scoring function.
 * Used by test.html (browser) and can be run in Node:
 *   node -e "const {computeScore}=require('./scoring.js');const run=require('./test-cases.js');run(computeScore).forEach(r=>console.log((r.ok?'PASS':'FAIL')+' — '+r.name+' — '+r.detail))"
 */

function runScoringTests(computeScore) {
  const NOW = Date.parse('2026-07-19T00:00:00Z');
  const results = [];

  function check(name, ok, detail) {
    results.push({ name, ok, detail });
  }

  // --- Success criterion 3: the hype repo -----------------------------------
  // 36,900 stars, top contributor at 97% (and top-10 sum < 500), 0 releases,
  // 3 affiliate links. Must score <= 50 with all four reasons present.
  const hype = computeScore({
    repo: {
      stargazers_count: 36900,
      created_at: '2025-01-01T00:00:00Z',
      pushed_at: '2026-07-01T00:00:00Z',
      archived: false,
      fork: false,
      license: { spdx_id: 'MIT', name: 'MIT License' }
    },
    contributors: [
      { login: 'soloauthor', contributions: 97 },
      { login: 'drive-by-1', contributions: 2 },
      { login: 'drive-by-2', contributions: 1 }
    ],
    hasRelease: false,
    readme: 'Try [our sponsor](https://vpn.example.com/?ref=hyperepo), ' +
            '[hosting](https://host.example.com/signup?plan=pro&ref=hyperepo) and ' +
            '[course](https://learn.example.com/?ref=hyperepo).',
    starBurst: false,
    now: NOW
  });
  const hypeIds = hype.reasons.map(r => r.id);
  check('criterion 3: score <= 50', hype.score <= 50, 'score=' + hype.score);
  for (const id of ['bus-factor', 'stars-vs-substance', 'no-releases', 'affiliate-links']) {
    check('criterion 3: reason "' + id + '" present', hypeIds.includes(id),
      'reasons=[' + hypeIds.join(', ') + ']');
  }
  check('criterion 3: red band', hype.band.key === 'red', 'band=' + hype.band.key);

  // --- Healthy repo (curl-like fixture) stays green --------------------------
  const healthy = computeScore({
    repo: {
      stargazers_count: 37000,
      created_at: '2010-12-31T00:00:00Z',
      pushed_at: '2026-07-18T00:00:00Z',
      archived: false,
      fork: false,
      license: { spdx_id: 'curl', name: 'curl License' }
    },
    contributors: [
      { login: 'core-1', contributions: 30000 },
      { login: 'core-2', contributions: 9000 },
      { login: 'core-3', contributions: 2000 },
      { login: 'core-4', contributions: 1500 },
      { login: 'core-5', contributions: 800 }
    ],
    hasRelease: true,
    readme: 'A command line tool and library for transferring data with URLs.',
    starBurst: false,
    now: NOW
  });
  check('healthy repo: score >= 80', healthy.score >= 80, 'score=' + healthy.score);
  check('healthy repo: green band', healthy.band.key === 'green', 'band=' + healthy.band.key);

  // --- torvalds/linux fixture: huge, old, tags-only, contributors API refuses --
  // GitHub returns 403 "list too large" for the contributors endpoint and the
  // kernel publishes tags, never GitHub releases. Must NOT trip
  // stars-vs-substance (either variant) or no-releases.
  const linux = computeScore({
    repo: {
      stargazers_count: 195000,
      created_at: '2011-09-04T22:48:12Z',
      pushed_at: '2026-07-18T00:00:00Z',
      archived: false,
      fork: false,
      license: { spdx_id: 'GPL-2.0', name: 'GNU General Public License v2.0' }
    },
    contributors: [],
    contributorsUnavailable: true,
    hasRelease: false,
    hasTags: true,
    readme: 'Linux kernel source tree.',
    starBurst: false,
    now: NOW
  });
  const linuxIds = linux.reasons.map(r => r.id);
  check('linux fixture: score >= 80', linux.score >= 80, 'score=' + linux.score);
  check('linux fixture: green band', linux.band.key === 'green', 'band=' + linux.band.key);
  check('linux fixture: no stars-vs-substance flags',
    !linuxIds.includes('stars-vs-substance') && !linuxIds.includes('stars-vs-contributors'),
    'reasons=[' + linuxIds.join(', ') + ']');
  check('linux fixture: no no-releases flag (tags exist)',
    !linuxIds.includes('no-releases'),
    'reasons=[' + linuxIds.join(', ') + ']');

  // Tags alone must not excuse a repo that has neither releases nor tags.
  const noTagsNoReleases = computeScore({
    repo: { stargazers_count: 3000, created_at: '2025-06-01T00:00:00Z', pushed_at: '2026-07-01T00:00:00Z', license: { spdx_id: 'MIT' } },
    contributors: [{ login: 'a', contributions: 400 }, { login: 'b', contributions: 300 }],
    hasRelease: false, hasTags: false, readme: '', starBurst: false, now: NOW
  });
  check('no releases AND no tags still deducts 10',
    noTagsNoReleases.reasons.some(r => r.id === 'no-releases' && r.points === 10),
    JSON.stringify(noTagsNoReleases.reasons));

  // Old (5y+) project with a full top-10 roster is exempt from
  // stars-vs-substance even with a modest top-10 sum...
  const tenSmallContributors = Array.from({ length: 10 }, (_, i) => (
    { login: 'c' + i, contributions: 40 - i }
  ));
  const oldEstablished = computeScore({
    repo: { stargazers_count: 50000, created_at: '2010-01-01T00:00:00Z', pushed_at: '2026-07-01T00:00:00Z', license: { spdx_id: 'MIT' } },
    contributors: tenSmallContributors,
    hasRelease: true, hasTags: true, readme: '', starBurst: false, now: NOW
  });
  check('old established project exempt from stars-vs-substance',
    !oldEstablished.reasons.some(r => r.id === 'stars-vs-substance'),
    JSON.stringify(oldEstablished.reasons));

  // ...but a young repo with the same numbers still gets flagged.
  const youngThin = computeScore({
    repo: { stargazers_count: 50000, created_at: '2025-06-01T00:00:00Z', pushed_at: '2026-07-01T00:00:00Z', license: { spdx_id: 'MIT' } },
    contributors: tenSmallContributors,
    hasRelease: true, hasTags: true, readme: '', starBurst: false, now: NOW
  });
  check('young repo with thin contributions still flagged',
    youngThin.reasons.some(r => r.id === 'stars-vs-substance'),
    JSON.stringify(youngThin.reasons.map(r => r.id)));

  // --- Bus factor thresholds -------------------------------------------------
  const bus91 = computeScore({
    repo: { stargazers_count: 100, pushed_at: '2026-07-01T00:00:00Z', license: { spdx_id: 'MIT' } },
    contributors: [{ login: 'a', contributions: 91 }, { login: 'b', contributions: 9 }],
    hasRelease: true, readme: '', starBurst: false, now: NOW
  });
  check('bus factor > 90% deducts 20',
    bus91.reasons.some(r => r.id === 'bus-factor' && r.points === 20),
    JSON.stringify(bus91.reasons.filter(r => r.id === 'bus-factor')));

  const bus80 = computeScore({
    repo: { stargazers_count: 100, pushed_at: '2026-07-01T00:00:00Z', license: { spdx_id: 'MIT' } },
    contributors: [{ login: 'a', contributions: 80 }, { login: 'b', contributions: 20 }],
    hasRelease: true, readme: '', starBurst: false, now: NOW
  });
  check('bus factor > 75% deducts 10',
    bus80.reasons.some(r => r.id === 'bus-factor' && r.points === 10),
    JSON.stringify(bus80.reasons.filter(r => r.id === 'bus-factor')));

  // --- Staleness / archived ---------------------------------------------------
  const stale = computeScore({
    repo: { stargazers_count: 10, pushed_at: '2024-01-01T00:00:00Z', archived: true, license: { spdx_id: 'MIT' } },
    contributors: [{ login: 'a', contributions: 50 }, { login: 'b', contributions: 50 }],
    hasRelease: true, readme: '', starBurst: false, now: NOW
  });
  check('stale > 12 months deducts 20',
    stale.reasons.some(r => r.id === 'stale' && r.points === 20),
    JSON.stringify(stale.reasons.filter(r => r.id === 'stale')));
  check('archived deducts 30',
    stale.reasons.some(r => r.id === 'archived' && r.points === 30),
    'score=' + stale.score);

  // --- README affiliate cap and hype counting --------------------------------
  const readmeFlags = computeScore({
    repo: { stargazers_count: 10, pushed_at: '2026-07-01T00:00:00Z', license: { spdx_id: 'MIT' } },
    contributors: [{ login: 'a', contributions: 50 }, { login: 'b', contributions: 50 }],
    hasRelease: true,
    readme: 'a?ref=1 b?ref=2 c?ref=3 d&ref=4 e?ref=5 — the World’s First revolutionary, ' +
            'Blazingly Fast tool. A 10x game-changing #1 pick.',
    starBurst: false, now: NOW
  });
  const aff = readmeFlags.reasons.find(r => r.id === 'affiliate-links');
  check('affiliate links capped at -15', !!aff && aff.points === 15,
    aff ? 'points=' + aff.points : 'reason missing');
  check('hype >= 3 phrases deducts 10',
    readmeFlags.reasons.some(r => r.id === 'hype' && r.points === 10),
    JSON.stringify(readmeFlags.reasons.filter(r => r.id === 'hype')));

  // "#1" must not match "#10"; "secret" must not match "secrets".
  const noFalseHype = computeScore({
    repo: { stargazers_count: 10, pushed_at: '2026-07-01T00:00:00Z', license: { spdx_id: 'MIT' } },
    contributors: [{ login: 'a', contributions: 50 }, { login: 'b', contributions: 50 }],
    hasRelease: true,
    readme: 'See issue #10 and #123. Store your secrets safely. Rated #1 overall.',
    starBurst: false, now: NOW
  });
  check('hype counting avoids #10/secrets false positives',
    !noFalseHype.reasons.some(r => r.id === 'hype'),
    JSON.stringify(noFalseHype.reasons));

  // --- Star burst, license, fork ----------------------------------------------
  const burst = computeScore({
    repo: { stargazers_count: 9000, pushed_at: '2026-07-01T00:00:00Z', license: null, fork: true, parent: { full_name: 'upstream/original' } },
    contributors: [{ login: 'a', contributions: 300 }, { login: 'b', contributions: 200 }],
    hasRelease: true, readme: '', starBurst: true, now: NOW
  });
  check('star burst deducts 15',
    burst.reasons.some(r => r.id === 'star-burst' && r.points === 15),
    'score=' + burst.score);
  check('no license deducts 5 with rights-reserved wording',
    burst.reasons.some(r => r.id === 'no-license' && r.points === 5 && /all rights reserved/.test(r.text)),
    JSON.stringify(burst.reasons.filter(r => r.id === 'no-license')));
  check('fork adds neutral "Fork of parent" note',
    burst.reasons.some(r => r.id === 'fork' && r.severity === 'neutral' && r.text.includes('upstream/original')),
    JSON.stringify(burst.reasons.filter(r => r.id === 'fork')));

  const agpl = computeScore({
    repo: { stargazers_count: 10, pushed_at: '2026-07-01T00:00:00Z', license: { spdx_id: 'AGPL-3.0', name: 'GNU AGPLv3' } },
    contributors: [{ login: 'a', contributions: 50 }, { login: 'b', contributions: 50 }],
    hasRelease: true, readme: '', starBurst: false, now: NOW
  });
  check('AGPL adds amber flag without deduction',
    agpl.score === 100 && agpl.reasons.some(r => r.id === 'agpl' && r.points === 0),
    'score=' + agpl.score + ' reasons=' + JSON.stringify(agpl.reasons));

  // --- Clamping ----------------------------------------------------------------
  const floor = computeScore({
    repo: { stargazers_count: 36900, created_at: '2020-01-01T00:00:00Z', pushed_at: '2023-01-01T00:00:00Z', archived: true, license: null },
    contributors: [{ login: 'a', contributions: 97 }],
    hasRelease: false,
    readme: 'x?ref=a y?ref=b z?ref=c — revolutionary game-changing 10x secret blazingly fast',
    starBurst: true, now: NOW
  });
  check('score clamps at 0', floor.score === 0, 'score=' + floor.score);

  return results;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = runScoringTests;
}
