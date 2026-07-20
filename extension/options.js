'use strict';

const tokenInput = document.getElementById('token');
const licenseInput = document.getElementById('license');
const saveButton = document.getElementById('save');
const status = document.getElementById('status');

chrome.storage.local.get(['githubToken', 'proLicenseKey'], (items) => {
  tokenInput.value = items.githubToken || '';
  licenseInput.value = items.proLicenseKey || '';
});

saveButton.addEventListener('click', () => {
  const githubToken = tokenInput.value.trim();
  const proLicenseKey = licenseInput.value.trim();

  // TODO: validate the Pro license key against the licensing service.
  // For now the key is only stored.

  chrome.storage.local.set({ githubToken, proLicenseKey }, () => {
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});
