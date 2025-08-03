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

async function getApiKey() {
  const items = await storageGet("api_key");
  return items.api_key || "";
}

async function fetchAndOCR(tab) {
  const apiKey = await getApiKey();
  try {
    const resp = await fetch(tab.url, { credentials: "omit" });
    const blob = await resp.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    const dataUrl = `data:${blob.type || "application/octet-stream"};base64,${base64}`;
    const ocrResp = await fetch("http://127.0.0.1:5000/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: dataUrl, api_key: apiKey }),
    });
    const data = await ocrResp.json();
    return data.markdown || "";
  } catch (e) {
    console.error("OCR request failed", e);
    return "";
  }
}

function downloadMarkdown(markdown, filename) {
  return new Promise((resolve) => {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
      URL.revokeObjectURL(url);
      resolve(!!id);
    });
  });

}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-]+/gi, "_");
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "save_page", title: "Save Page to Markdown", contexts: ["page"] });
  chrome.contextMenus.create({ id: "save_selection", title: "Save Selection to Markdown", contexts: ["selection"] });
});

async function processTab(tab, preferSelection) {
  const filename = sanitizeFilename(tab.title || "page") + ".md";
  try {
    let response;
    if (preferSelection) {
      response = await sendMessageWithInjection(tab.id, { type: "getSelection" });
      if (!response || !response.markdown || !response.markdown.trim()) {
        response = await sendMessageWithInjection(tab.id, { type: "getPage" });
      }
    } else {
      response = await sendMessageWithInjection(tab.id, { type: "getPage" });
    }
    let markdown = response && response.markdown;
    if (!markdown || !markdown.trim()) {
      markdown = await fetchAndOCR(tab);
    }
    if (markdown && markdown.trim()) {
      return await downloadMarkdown(markdown, filename);
    }
  } catch (e) {
    console.error("Processing tab failed", e);
  }
  return false;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id === undefined) return;
  await processTab(tab, info.menuItemId === "save_selection");
});

async function runTests() {
  const results = [];
  const apiKey = await getApiKey();
  results.push(apiKey ? "API key set" : "API key missing");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id !== undefined) {
      const resp = await sendMessageWithInjection(tab.id, { type: "getPage" });
      if (resp && resp.markdown) {
        results.push("Content script accessible");
      } else {
        results.push("Content script returned empty");
      }
    } else {
      results.push("No active tab");
    }
  } catch (e) {
    results.push("Error accessing tab");
  }
  try {
    const health = await fetch("http://127.0.0.1:5000/health");
    results.push(health.ok ? "OCR server reachable" : `OCR server error: ${health.status}`);
  } catch (e) {
    results.push("OCR server unreachable");
  }
  const passed = results.every((r) => !/missing|empty|error|unreachable/.test(r));
  return { passed, details: results };
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === "saveTab") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      let ok = false;
      if (tab && tab.id !== undefined) {
        ok = await processTab(tab, true);
      }
      sendResponse({ ok });
    });
    return true;
  }
  if (req.type === "runTests") {
    runTests().then(sendResponse);
    return true;
  }
});
