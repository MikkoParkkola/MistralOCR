async function sendMessageWithInjection(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function getApiKey(tabId) {
  const items = await storageGet("api_key");
  let key = items.api_key;
  if (!key) {
    const resp = await sendMessageWithInjection(tabId, { type: "promptApiKey" });
    key = resp && resp.apiKey ? resp.apiKey : "";
    if (key) await storageSet({ api_key: key });
  }
  return key || "";
}

async function fetchAndOCR(tab) {
  const apiKey = await getApiKey(tab.id);
  const resp = await fetch(tab.url, { credentials: "omit" });
  const blob = await resp.blob();
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
  const dataUrl = `data:${blob.type || "application/octet-stream"};base64,${base64}`;
  const ocrResp = await fetch("http://localhost:5000/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: dataUrl, api_key: apiKey }),
  });
  const data = await ocrResp.json();
  return data.markdown || "";
}

function downloadMarkdown(markdown, filename) {
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-]+/gi, "_");
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "save_page", title: "Save Page to Markdown", contexts: ["page"] });
  chrome.contextMenus.create({ id: "save_selection", title: "Save Selection to Markdown", contexts: ["selection"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id === undefined) return;
  const filename = sanitizeFilename(tab.title || "page") + ".md";
  let response;
  if (info.menuItemId === "save_selection") {
    response = await sendMessageWithInjection(tab.id, { type: "getSelection" });
  } else {
    response = await sendMessageWithInjection(tab.id, { type: "getPage" });
  }
  let markdown = response && response.markdown;
  if (!markdown || !markdown.trim()) {
    markdown = await fetchAndOCR(tab);
  }
  if (markdown && markdown.trim()) {
    downloadMarkdown(markdown, filename);
  }
});
