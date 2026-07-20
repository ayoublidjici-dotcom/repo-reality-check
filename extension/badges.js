/*
 * Repo Reality Check — inline score badges on Search results and Trending
 * (Pro). Badges are computed lazily: only repos scrolled into the viewport
 * are scored, at most 2 repos in flight, reusing the shared 6h cache.
 * Without a token, only the first 5 visible repos are auto-scored; the rest
 * become click-to-score "＋" badges with a one-line notice linking settings.
 */

(() => {
  'use strict';

  const AUTO_BUDGET_NO_TOKEN = 5;
  const MAX_INFLIGHT = 2;
  const NOTICE_ID = 'rrc-badge-notice';

  let queue = [];
  let inflight = 0;
  let autoScored = 0;
  let pro = false;
  let token = '';
  let lastHref = '';

  function pageType() {
    if (location.hostname !== 'github.com') return null;
    if (location.pathname === '/trending' ||
        location.pathname.startsWith('/trending/')) return 'trending';
    if (location.pathname === '/search' &&
        new URLSearchParams(location.search).get('type') === 'repositories') {
      return 'search';
    }
    return null;
  }

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const badge = entry.target;
      io.unobserve(badge);
      if (badge.dataset.state === 'pending') {
        badge.dataset.state = 'queued';
        queue.push(badge);
      }
    }
    pump();
  }, { rootMargin: '100px' });

  // ---------- badge states ----------

  function paint(badge, result) {
    badge.dataset.state = 'scored';
    badge.textContent = 'RRC ' + result.score;
    badge.classList.add('rrc-badge-' + result.band.key);
    const top = result.reasons.filter((r) => r.points > 0)[0];
    badge.title = result.band.label + (top ? ' — ' + top.text : '');
  }

  function setPlus(badge) {
    badge.dataset.state = 'plus';
    badge.textContent = '＋';
    badge.title = 'Score this repo';
    badge.addEventListener('click', () => {
      if (badge.dataset.state !== 'plus') return;
      badge.dataset.userRequested = '1';
      badge.dataset.state = 'queued';
      badge.textContent = '…';
      queue.push(badge);
      pump();
    }, { once: true });
  }

  function setError(badge, why) {
    badge.dataset.state = 'error';
    badge.textContent = '–';
    badge.title = 'Repo Reality Check: ' + (why || 'could not score this repo');
  }

  function setLocked(badge) {
    badge.dataset.state = 'locked';
    badge.textContent = 'RRC';
    badge.title = 'Inline scores are a Repo Reality Check Pro feature';
    const tag = document.createElement('span');
    tag.className = 'rrc-pro-tag';
    tag.textContent = 'Pro';
    badge.appendChild(tag);
    badge.addEventListener('click', () => {
      window.open(chrome.runtime.getURL('options.html') + '#pro');
    });
  }

  // ---------- scoring pipeline (concurrency-limited) ----------

  function pump() {
    while (inflight < MAX_INFLIGHT && queue.length) {
      const badge = queue.shift();
      if (!badge.isConnected) continue;
      processBadge(badge);
    }
  }

  async function processBadge(badge) {
    inflight++;
    try {
      const full = badge.dataset.rrcFull;
      const [owner, repo] = full.split('/');

      // Cache hits are free — they never count against the no-token budget.
      const cached = await RRC.getCached(full);
      if (cached) {
        paint(badge, cached.result);
        return;
      }

      if (!token && !badge.dataset.userRequested) {
        if (autoScored >= AUTO_BUDGET_NO_TOKEN) {
          setPlus(badge);
          ensureNotice();
          return;
        }
        autoScored++;
      }

      const res = await RRC.scoreAndCache(owner, repo, {});
      if (res) paint(badge, res.result);
      else setError(badge);
    } catch (e) {
      setError(badge, e instanceof RRC.RateLimitError
        ? 'GitHub rate limit reached — add a token in settings' : '');
    } finally {
      inflight--;
      pump();
    }
  }

  function ensureNotice() {
    if (document.getElementById(NOTICE_ID)) return;
    const main = document.querySelector('main') || document.body;
    const notice = document.createElement('div');
    notice.id = NOTICE_ID;
    notice.className = 'rrc-notice';
    notice.append('Repo Reality Check: scored the first 5 repos — add a free GitHub token in ');
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'settings';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(chrome.runtime.getURL('options.html'));
    });
    notice.append(link);
    notice.append(' for unlimited inline scoring, or click ＋ to score one.');
    main.prepend(notice);
  }

  // ---------- DOM scanning ----------

  function findRepoAnchors(seen) {
    const out = [];
    for (const a of document.querySelectorAll('main a[href]')) {
      let url;
      try { url = new URL(a.href); } catch { continue; }
      if (url.hostname !== 'github.com') continue;
      const target = RRC.parseRepoPath(url.pathname);
      if (!target || seen.has(target.full)) continue;
      seen.add(target.full);
      out.push({ anchor: a, full: target.full });
    }
    return out;
  }

  function scan() {
    if (!pageType()) return;

    // A repo gets exactly one badge, ever — seed the seen-set with badges
    // already in the DOM so rescans (SPA nav, lazy-loaded results) never
    // double-badge, even when a repo appears in several anchors.
    const seen = new Set();
    document.querySelectorAll('.rrc-badge').forEach((b) => {
      if (b.dataset.rrcFull) seen.add(b.dataset.rrcFull);
    });

    for (const { anchor, full } of findRepoAnchors(seen)) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'rrc-badge';
      badge.dataset.rrcFull = full;
      if (!pro) {
        setLocked(badge);
      } else {
        badge.dataset.state = 'pending';
        badge.textContent = '…';
        io.observe(badge);
      }
      anchor.insertAdjacentElement('afterend', badge);
    }
  }

  async function refreshAndScan() {
    if (location.href !== lastHref) {
      // New page: reset the lazy pipeline (old badges left the DOM).
      lastHref = location.href;
      queue = [];
      autoScored = 0;
    }
    if (!pageType()) return;
    pro = await isPro();
    token = await RRC.getToken();
    scan();
  }

  // ---------- navigation + dynamic content hooks ----------

  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refreshAndScan, 300);
  }

  document.addEventListener('turbo:load', scheduleScan);
  window.addEventListener('popstate', scheduleScan);

  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(scheduleScan).observe(titleEl, {
      childList: true, characterData: true, subtree: true
    });
  }

  // Results load in dynamically (pagination, lazy rendering) — rescan on DOM
  // growth. scan() is idempotent, and pageType() bails instantly on repo pages.
  new MutationObserver(() => {
    if (pageType()) scheduleScan();
  }).observe(document.body, { childList: true, subtree: true });

  refreshAndScan();
})();
