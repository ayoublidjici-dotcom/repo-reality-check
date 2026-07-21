'use strict';

const tokenInput = document.getElementById('token');
const licenseInput = document.getElementById('license');
const saveButton = document.getElementById('save');
const status = document.getElementById('status');
const keyStatus = document.getElementById('key-status');
const watchlistEl = document.getElementById('watchlist');
const checkNowButton = document.getElementById('check-now');
const checkStatus = document.getElementById('check-status');

function renderKeyStatus() {
  const key = licenseInput.value.trim();
  if (!key) {
    keyStatus.textContent = 'No key saved — Pro features are disabled.';
    keyStatus.className = 'hint';
  } else if (isProKey(key)) {
    keyStatus.textContent = 'Key format valid — Pro features enabled (local check only for now).';
    keyStatus.className = 'hint valid';
  } else {
    keyStatus.textContent = 'Invalid key format (expected RRC- followed by 16+ letters/digits).';
    keyStatus.className = 'hint invalid';
  }
}

function fmtWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0');
}

async function renderWatchlist() {
  const list = (await RRC.storageGet(['rrcWatchlist'])).rrcWatchlist || {};
  const fulls = Object.keys(list).sort();
  if (!fulls.length) {
    watchlistEl.innerHTML = '<p class="hint">Nothing watched yet — use the ☆ watch link in a repo\'s panel.</p>';
    return;
  }
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Repo</th><th>Score</th><th>Last checked</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const full of fulls) {
    const entry = list[full];
    const tr = document.createElement('tr');

    const tdRepo = document.createElement('td');
    const a = document.createElement('a');
    a.href = 'https://github.com/' + full;
    a.textContent = full;
    a.target = '_blank';
    tdRepo.appendChild(a);
    tr.appendChild(tdRepo);

    const tdScore = document.createElement('td');
    tdScore.className = 'band-' + (entry.band || 'green');
    tdScore.textContent = entry.score != null ? String(entry.score) : '—';
    tr.appendChild(tdScore);

    const tdWhen = document.createElement('td');
    tdWhen.className = 'muted';
    tdWhen.textContent = fmtWhen(entry.checkedAt);
    tr.appendChild(tdWhen);

    const tdRemove = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = 'Remove';
    btn.addEventListener('click', async () => {
      const fresh = (await RRC.storageGet(['rrcWatchlist'])).rrcWatchlist || {};
      delete fresh[full];
      await RRC.storageSet({ rrcWatchlist: fresh });
      renderWatchlist();
    });
    tdRemove.appendChild(btn);
    tr.appendChild(tdRemove);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  watchlistEl.textContent = '';
  watchlistEl.appendChild(table);
}

chrome.storage.local.get(['githubToken', 'proLicenseKey'], (items) => {
  tokenInput.value = items.githubToken || '';
  licenseInput.value = items.proLicenseKey || '';
  renderKeyStatus();
});

licenseInput.addEventListener('input', renderKeyStatus);

saveButton.addEventListener('click', () => {
  const githubToken = tokenInput.value.trim();
  const proLicenseKey = licenseInput.value.trim();

  // TODO: real license validation against the licensing service comes in a
  // later step (Paddle webhook + Cloudflare Worker). Local pattern check only.

  chrome.storage.local.set({ githubToken, proLicenseKey }, () => {
    status.textContent = 'Saved.';
    renderKeyStatus();
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});

checkNowButton.addEventListener('click', () => {
  checkStatus.textContent = 'Checking…';
  chrome.runtime.sendMessage({ type: 'rrc-recheck-now' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      checkStatus.textContent = 'Check failed — try again.';
    } else if (res.skipped === 'not-pro') {
      checkStatus.textContent = 'Watchlist re-checks are a Pro feature.';
    } else {
      checkStatus.textContent = 'Checked ' + res.checked + ' repo' +
        (res.checked === 1 ? '' : 's') +
        (res.notified ? ', ' + res.notified + ' band change' + (res.notified === 1 ? '' : 's') : '') + '.';
    }
    renderWatchlist();
    setTimeout(() => { checkStatus.textContent = ''; }, 4000);
  });
});

renderWatchlist();
