/*
 * Repo Reality Check — Pro gate.
 *
 * TODO: real server-side validation comes in a later step (Paddle webhook +
 * Cloudflare Worker). Until then validation is LOCAL ONLY: a key is "valid"
 * if it matches RRC- followed by 16+ alphanumerics.
 */

function isProKey(key) {
  return typeof key === 'string' && /^RRC-[A-Za-z0-9]{16,}$/.test(key.trim());
}

function isPro() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['proLicenseKey'], (items) => {
      resolve(isProKey(items.proLicenseKey || ''));
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isProKey };
}
