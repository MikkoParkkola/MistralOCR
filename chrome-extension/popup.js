function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

document.addEventListener('DOMContentLoaded', async () => {
  const items = await storageGet('api_key');
  document.getElementById('apiKey').value = items.api_key || '';
});

document.getElementById('saveKey').addEventListener('click', async () => {
  const key = document.getElementById('apiKey').value.trim();
  await storageSet({ api_key: key });
  document.getElementById('status').textContent = 'API key saved.';
});

document.getElementById('runTests').addEventListener('click', () => {
  const status = document.getElementById('status');
  status.textContent = 'Running tests...';
  chrome.runtime.sendMessage({ type: 'runTests' }, (result) => {
    if (!result) {
      status.textContent = 'No response from background.';
      return;
    }
    status.textContent = (result.passed ? 'All tests passed' : 'Some tests failed') + '\n' + result.details.join('\n');
  });
});

document.getElementById('saveMarkdown').addEventListener('click', () => {
  const status = document.getElementById('status');
  status.textContent = 'Saving...';
  chrome.runtime.sendMessage({ type: 'saveTab' }, (resp) => {
    if (chrome.runtime.lastError) {
      status.textContent = 'Error: ' + chrome.runtime.lastError.message;
      return;
    }
    status.textContent = resp && resp.ok ? 'Markdown saved.' : 'Failed to save.';
  });
});
