let debugEnabled = false;

// Load debug setting on startup
storageGet("debug").then((items) => {
  debugEnabled = !!items.debug;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.debug) {
    debugEnabled = changes.debug.newValue;
  }
});

function log(...args) {
  console.log("mistralocr:", ...args);
}

function errorLog(...args) {
  console.error("mistralocr:", ...args);
}

function debugLog(...args) {
  if (debugEnabled) {
    log(...args);
  }
}

function scrubHeaders(headers = {}) {
  const clean = { ...headers };
  if (clean.Authorization) {
    clean.Authorization = clean.Authorization.replace(/Bearer\s+.+/, "Bearer ***");
  }
  if (clean["X-API-Key"]) {
    clean["X-API-Key"] = "***";
  }
  return clean;
}

async function fetchWithRetry(url, options = {}, retries = 2, backoff = 500) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      debugLog("fetchWithRetry request", {
        url,
        options: {
          ...options,
          headers: scrubHeaders(options.headers),
        },
        attempt,
      });
      const controller = new AbortController();
      const timeout = options.timeout || 5000;
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (debugEnabled) {
        const respClone = resp.clone();
        let body = "";
        try {
          body = await respClone.text();
        } catch (e) {
          body = "<unreadable>";
        }
        debugLog("fetchWithRetry response", {
          url,
          status: resp.status,
          body,
        });
      }
      if (!resp.ok && attempt < retries && resp.status >= 500) {
        debugLog(`Fetch ${url} failed with status ${resp.status}, retrying...`);
        await new Promise((r) => setTimeout(r, backoff * 2 ** attempt));
        continue;
      }
      return resp;
    } catch (e) {
      debugLog(`Fetch ${url} error`, e);
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, backoff * 2 ** attempt));
    }
  }
  throw new Error("fetchWithRetry exhausted retries");
}

async function sendMessageWithInjection(tabId, message) {
  debugLog("sendMessage", { tabId, message });
  try {
    const resp = await chrome.tabs.sendMessage(tabId, message);
    debugLog("sendMessage response", resp);
    return resp;
  } catch (e) {
    debugLog("Injecting content script into tab", tabId, e);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      const resp = await chrome.tabs.sendMessage(tabId, message);
      debugLog("sendMessage response after injection", resp);
      return resp;
    } catch (err) {
      errorLog("sendMessage failed after injection", err);
      throw err;
    }
  }
}

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function getSettings() {
  const items = await storageGet(["api_key", "model", "language", "format"]);
  return {
    apiKey: items.api_key || "",
    model: items.model || "",
    language: items.language || "",
    format: items.format || "markdown",
  };
}

async function fetchAndOCR(tab, settings) {
  const { apiKey, model, language, format } = settings;
  try {
    debugLog("Fetching tab for OCR", tab.url);
    const resp = await fetch(tab.url, { credentials: "omit" });
    const blob = await resp.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    const dataUrl = `data:${blob.type || "application/octet-stream"};base64,${base64}`;
    const headers = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      headers["X-API-Key"] = apiKey;
    }
    debugLog("OCR request", {
      url: "http://127.0.0.1:5000/ocr",
      headers: scrubHeaders(headers),
      body: { model, language, format, fileLength: dataUrl.length },
    });
    const ocrResp = await fetchWithRetry(
      "http://127.0.0.1:5000/ocr",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ file: dataUrl, model, language, format }),
        timeout: 15000,
      },
      2
    );
    const rawBody = await ocrResp.text();
    debugLog("OCR response raw", { status: ocrResp.status, body: rawBody });
    if (!ocrResp.ok) {
      return "";
    }
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (e) {
      errorLog("Failed to parse OCR response", e);
      return "";
    }
    const result = data.text || data.markdown || "";
    debugLog("OCR result", result);
    return result;
  } catch (e) {
    errorLog("OCR request failed", e);
    return "";
  }
}

function downloadContent(content, filename, format) {
  return new Promise((resolve) => {
    const mime = {
      markdown: "text/markdown",
      text: "text/plain",
      json: "application/json",
    }[format] || "text/markdown";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
      URL.revokeObjectURL(url);
      resolve(!!id);
    });
  });
}

function markdownToText(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[`*_>#-]/g, "");
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-]+/gi, "_");
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "save_page", title: "Save Page", contexts: ["page"] });
  chrome.contextMenus.create({ id: "save_selection", title: "Save Selection", contexts: ["selection"] });
});

async function processTab(tab, preferSelection) {
  const settings = await getSettings();
  const { format } = settings;
  const ext = { markdown: ".md", text: ".txt", json: ".json" }[format] || ".md";
  const filename = sanitizeFilename(tab.title || "page") + ext;
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
    let content = response && response.markdown;
    if (!content || !content.trim()) {
      debugLog("Falling back to OCR for tab", tab.id);
      content = await fetchAndOCR(tab, settings);
    }
    if (format === "text" && content) {
      content = markdownToText(content);
    }
  if (content && content.trim()) {
      const ok = await downloadContent(content, filename, format);
      debugLog("downloadContent result", { ok, filename, format });
      return ok;
    }
  } catch (e) {
    errorLog("Processing tab failed", e);
  }
  return false;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id === undefined) return;
  await processTab(tab, info.menuItemId === "save_selection");
});

async function runTests() {
  log("runTests: start");
  const results = [];
  const { apiKey } = await getSettings();
  const apiKeyOk = !!apiKey;
  log("runTests: api key", apiKey ? apiKey.slice(0, 4) + "..." : "missing");
  results.push(apiKeyOk ? "API key set" : "API key missing");

  let contentOk = false;
  try {
    log("runTests: checking content script");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id !== undefined) {
      const resp = await sendMessageWithInjection(tab.id, { type: "getPage" });
      debugLog("runTests: content script response", resp);
      if (resp && resp.markdown) {
        results.push("Content script accessible");
        contentOk = true;
      } else {
        results.push("Content script returned empty");
      }
    } else {
      results.push("No active tab");
    }
  } catch (e) {
    results.push("Error accessing tab");
    debugLog("Content script test error", e);
  }

  let serverReachable = false;
  let serverAuthorized = false;
  try {
    const headers = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      headers["X-API-Key"] = apiKey;
    }
    log("runTests: health check request", {
      url: "http://127.0.0.1:5000/health",
      headers: scrubHeaders(headers),
    });
    const health = await fetchWithRetry(
      "http://127.0.0.1:5000/health",
      { headers, timeout: 5000 },
      1
    );
    serverReachable = true;
    const body = await health.text();
    log("runTests: health check response", {
      status: health.status,
      body,
    });
    results.push("OCR server reachable");
    if (health.status === 200) {
      serverAuthorized = true;
      results.push("OCR server authorized");
    } else if (health.status === 401 || health.status === 403) {
      results.push(`OCR server unauthorized: ${health.status}`);
      errorLog("OCR server unauthorized", body);
    } else {
      results.push(`OCR server error: ${health.status}`);
      errorLog("OCR server error", health.status, body);
    }
  } catch (e) {
    results.push("OCR server unreachable");
    errorLog("Health check failed", e);
  }
  const passed = apiKeyOk && contentOk && serverReachable && serverAuthorized;
  log("runTests: results", results, "passed:", passed);
  return { passed, details: results };
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === "saveTab") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      (async () => {
        let ok = false;
        if (tab && tab.id !== undefined) {
          try {
            ok = await processTab(tab, true);
          } catch (e) {
            errorLog("processTab failed", e);
          }
        }
        sendResponse({ ok });
      })();
    });
    return true;
  }
  if (req.type === "runTests") {
    runTests()
      .then(sendResponse)
      .catch((e) => {
        errorLog("runTests failed", e);
        sendResponse({ passed: false, details: ["Exception: " + e.message] });
      });
    return true;
  }
});
