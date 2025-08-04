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

async function forwardConsole(level, args) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id !== undefined) {
      chrome.tabs.sendMessage(
        tab.id,
        { type: "console", level, args },
        () => void chrome.runtime.lastError
      );
    }
  } catch (_e) {
    // ignore
  }
}

function log(...args) {
  console.log("mistralocr:", ...args);
  forwardConsole("log", args);
}

function errorLog(...args) {
  const serialised = args.map((a) =>
    typeof a === "object" ? JSON.stringify(a) : a
  );
  console.error("mistralocr:", ...serialised);
  forwardConsole("error", serialised);
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

function buildAuthHeaders(apiKey, includeXApi = false) {
  const headers = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
    if (includeXApi) {
      headers["X-API-Key"] = apiKey;
    }
  }
  return headers;
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
  const send = () =>
    new Promise((resolve, reject) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  try {
    const resp = await send();
    debugLog("sendMessage response", resp);
    return resp;
  } catch (e) {
    debugLog("Injecting content script into tab", tabId, e);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      const resp = await send();
      debugLog("sendMessage response after injection", resp);
      return resp;
    } catch (err) {
      errorLog("sendMessage failed after injection", err);
      return null;
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
    // default to latest model if none stored
    model: items.model || "mistral-ocr-latest",
    language: items.language || "",
    format: items.format || "markdown",
  };
}

async function fetchAndOCR(tab, settings) {
  const { apiKey, model, language } = settings;
  try {
    debugLog("Fetching tab for OCR", tab.url);
    const resp = await fetch(tab.url, { credentials: "omit" });
    const blob = await resp.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    const dataUrl = `data:${blob.type || "application/octet-stream"};base64,${base64}`;
    const headers = buildAuthHeaders(apiKey, true);
    headers["Content-Type"] = "application/json";
    const document = blob.type.startsWith("image/")
      ? { type: "image_url", image_url: { url: dataUrl } }
      : { type: "document_url", document_url: dataUrl };
    const body = { document, model: model || "mistral-ocr-latest" };
    if (language) {
      body.language = language;
    }
    debugLog("OCR request", {
      url: "https://api.mistral.ai/v1/ocr",
      headers: scrubHeaders(headers),
      body: { ...body, document: "<omitted>" },
    });
    const ocrResp = await fetchWithRetry(
      "https://api.mistral.ai/v1/ocr",
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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
    let result = "";
    if (Array.isArray(data.pages)) {
      result = data.pages
        .map((p) => p.markdown || p.text || "")
        .join("\n\n");
    }
    if (!result) {
      result = data.text || data.markdown || "";
    }
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
      if (resp && typeof resp.markdown === "string") {
        contentOk = true;
        if (resp.markdown) {
          results.push("Content script accessible");
        } else {
          results.push("Content script returned empty");
        }
      } else if (resp === null) {
        results.push("Content script unreachable");
      } else {
        results.push("Invalid content script response");
      }
    } else {
      results.push("No active tab");
    }
  } catch (e) {
    results.push("Error accessing tab");
    debugLog("Content script test error", e);
  }

  let apiReachable = false;
  let apiAuthorized = false;
  let modelsListed = false;
  try {
    const headers = buildAuthHeaders(apiKey, true);
    if (apiKey) {
      results.push("API request headers set");
    } else {
      results.push("API request missing key headers");
    }
    const apiUrl = "https://api.mistral.ai/v1/models";
    results.push(`Using API endpoint ${apiUrl}`);
    log("runTests: Mistral API request", {
      url: apiUrl,
      method: "GET",
      headers: scrubHeaders(headers),
    });
    const resp = await fetchWithRetry(
      apiUrl,
      { method: "GET", headers, timeout: 5000 },
      1
    );
    apiReachable = true;
    results.push("Mistral API reachable");
    const body = await resp.text();
    log("runTests: Mistral API response", {
      status: resp.status,
      body,
    });
    if (resp.status === 200) {
      apiAuthorized = true;
      results.push("Mistral API authorized");
      try {
        const data = JSON.parse(body);
        if (Array.isArray(data.data) && data.data.length > 0) {
          modelsListed = true;
          results.push(`Models listed: ${data.data.length}`);
        } else {
          results.push("Mistral API returned no models");
        }
      } catch (e) {
        results.push("Failed to parse models list");
        errorLog("Parsing models list failed", e);
      }
    } else if (resp.status === 401 || resp.status === 403) {
      const snippet = body.slice(0, 100);
      results.push(`Mistral API unauthorized: ${resp.status} ${snippet}`);
      errorLog("Mistral API unauthorized", { status: resp.status, body });
    } else {
      results.push(`Mistral API error: ${resp.status}`);
      errorLog("Mistral API error", resp.status, body);
    }
  } catch (e) {
    results.push("Mistral API unreachable");
    errorLog("Mistral API request failed", e);
  }

  const passed =
    apiKeyOk &&
    contentOk &&
    apiReachable &&
    apiAuthorized &&
    modelsListed;
  log("runTests: results", results, "passed:", passed);
  return { passed, details: results };
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  log("onMessage received", req.type);
  if (req.type === "saveTab") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        let ok = false;
        if (tab && tab.id !== undefined) {
          ok = await processTab(tab, true);
        }
        debugLog("saveTab response", { ok });
        sendResponse({ ok });
      } catch (e) {
        errorLog("processTab failed", e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (req.type === "runTests") {
    runTests()
      .then((res) => {
        debugLog("runTests response", res);
        sendResponse(res);
      })
      .catch((e) => {
        errorLog("runTests failed", e);
        sendResponse({ passed: false, details: ["Exception: " + e.message] });
      });
    return true;
  }
  debugLog("Unknown message type", req.type);
  sendResponse();
});
