/*
 * Repo Reality Check — background service worker (Pro watchlist).
 * Sole job: a weekly chrome.alarms re-check of watched repos, notifying via
 * chrome.notifications when a repo's band changes. Also answers the options
 * page's "Check now" message, which runs the exact same re-check.
 */

'use strict';

importScripts('scoring.js', 'pro.js', 'common.js');

const ALARM_NAME = 'rrc-weekly-recheck';
const WEEK_MINUTES = 7 * 24 * 60;
const BATCH_GAP_MS = 2000; // be polite: 1 repo at a time, 2s apart

function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: WEEK_MINUTES });
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) recheckWatchlist();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'rrc-recheck-now') {
    recheckWatchlist().then(sendResponse);
    return true; // async response
  }
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function bandLabel(key) {
  return key === 'green' ? 'Healthy signals'
    : key === 'amber' ? 'Check the flags' : 'High hype risk';
}

async function notifyBandChange(full, prevBand, result) {
  const flags = result.reasons
    .filter((r) => r.points > 0)
    .slice(0, 3)
    .map((r) => r.text)
    .join('\n');

  // Keep a small log of alerts (also lets tests and a future UI inspect them).
  const log = (await RRC.storageGet(['rrcNotifLog'])).rrcNotifLog || [];
  log.push({ repo: full, from: prevBand, to: result.band.key, at: Date.now(), flags });
  await RRC.storageSet({ rrcNotifLog: log.slice(-20) });

  try {
    chrome.notifications.create('rrc-' + full + '-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Repo Reality Check: ' + full + ' → ' + bandLabel(result.band.key),
      message: flags || 'Band changed from ' + prevBand + ' to ' + result.band.key + '.'
    });
  } catch (e) {
    // Notifications can be unavailable (e.g. headless test runs); the log above
    // is the source of truth.
  }
}

async function recheckWatchlist() {
  if (!(await isPro())) return { checked: 0, notified: 0, skipped: 'not-pro' };

  const list = (await RRC.storageGet(['rrcWatchlist'])).rrcWatchlist || {};
  const fulls = Object.keys(list);
  let checked = 0;
  let notified = 0;

  for (let i = 0; i < fulls.length; i++) {
    if (i > 0) await delay(BATCH_GAP_MS);
    const full = fulls[i];
    const [owner, repo] = full.split('/');
    try {
      const res = await RRC.scoreAndCache(owner, repo, {}); // respects 6h cache
      if (!res) continue; // repo gone/404 — keep the entry as-is
      checked++;
      const prevBand = list[full].band;
      const newBand = res.result.band.key;
      if (prevBand && prevBand !== newBand) {
        await notifyBandChange(full, prevBand, res.result);
        notified++;
      }
      list[full] = Object.assign({}, list[full], {
        band: newBand,
        score: res.result.score,
        checkedAt: Date.now()
      });
    } catch (e) {
      if (e instanceof RRC.RateLimitError) break; // stop the batch, retry next week
    }
  }

  await RRC.storageSet({ rrcWatchlist: list });
  return { checked, notified };
}
