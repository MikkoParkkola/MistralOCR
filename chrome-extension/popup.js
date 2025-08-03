function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

document.addEventListener('DOMContentLoaded', async () => {
  const items = await storageGet(['api_key', 'model', 'language', 'debug']);
  document.getElementById('apiKey').value = items.api_key || '';
  document.getElementById('model').value = items.model || '';
  document.getElementById('language').value = items.language || '';
  document.getElementById('debug').checked = !!items.debug;
});

document.getElementById('saveSettings').addEventListener('click', async () => {
  const key = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('model').value.trim();
  const language = document.getElementById('language').value.trim();
  await storageSet({ api_key: key, model, language });
  console.log('mistralocr: settings saved');
  document.getElementById('status').textContent = 'Settings saved.';
});

document.getElementById('debug').addEventListener('change', async (e) => {
  await storageSet({ debug: e.target.checked });
});

document.getElementById('runTests').addEventListener('click', () => {
  const status = document.getElementById('status');
  status.textContent = 'Running tests...';
  console.log('mistralocr: runTests clicked');
  chrome.runtime.sendMessage({ type: 'runTests' }, (result) => {
    if (!result) {
      status.textContent = 'No response from background.';
      console.log('mistralocr: runTests no response');
      return;
    }
    status.textContent = (result.passed ? 'All tests passed' : 'Some tests failed') + '\n' + result.details.join('\n');
    console.log('mistralocr: runTests result', result);
  });
});

document.getElementById('saveMarkdown').addEventListener('click', () => {
  const status = document.getElementById('status');
  status.textContent = 'Saving...';
  console.log('mistralocr: saveMarkdown clicked');
  chrome.runtime.sendMessage({ type: 'saveTab' }, (resp) => {
    if (chrome.runtime.lastError) {
      status.textContent = 'Error: ' + chrome.runtime.lastError.message;
      console.log('mistralocr: saveMarkdown error', chrome.runtime.lastError.message);
      return;
    }
    status.textContent = resp && resp.ok ? 'Markdown saved.' : 'Failed to save.';
    console.log('mistralocr: saveMarkdown result', resp);
  });
});
