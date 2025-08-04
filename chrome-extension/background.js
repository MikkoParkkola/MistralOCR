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
      } else if (resp === null) {
        results.push("Content script unreachable");
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
    const headers = buildAuthHeaders(apiKey, true);
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
    results.push("Middleware reachable");
    if (health.status === 200) {
      serverAuthorized = true;
      results.push("Middleware authorized");
    } else if (health.status === 401 || health.status === 403) {
      const snippet = body.slice(0, 100);
      results.push(`Middleware unauthorized: ${health.status} ${snippet}`);
      errorLog("Middleware unauthorized", { status: health.status, body });
    } else {
      results.push(`Middleware error: ${health.status}`);
      errorLog("Middleware error", health.status, body);
    }
  } catch (e) {
    results.push("Middleware unreachable");
    errorLog("Health check failed", e);
  }

  let apiReachable = false;
  let apiAuthorized = false;
  let modelsListed = false;
  let apiModelsData = null;
  let apiRequest = null;
  try {
      const headers = buildAuthHeaders(apiKey, true);
      if (apiKey) {
        results.push("API request headers set");
      } else {
        results.push("API request missing key headers");
      }
      const apiUrl = "https://api.mistral.ai/v1/models";
      results.push(`Using API endpoint ${apiUrl}`);
      apiRequest = { method: "GET", headers: scrubHeaders(headers) };
      log("runTests: Mistral API request", { url: apiUrl, ...apiRequest });
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
        apiModelsData = data;
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

  let middlewareModelsOk = false;
  let middlewareRequestMatch = false;
  if (serverReachable && apiAuthorized && modelsListed) {
    try {
      const headers = buildAuthHeaders(apiKey, true);
      const mReq = { method: "GET", headers: scrubHeaders(headers) };
      log("runTests: middleware models request", {
        url: "http://127.0.0.1:5000/v1/models",
        ...mReq,
      });
      if (apiRequest && JSON.stringify(mReq) === JSON.stringify(apiRequest)) {
        middlewareRequestMatch = true;
        results.push("Middleware request matches direct");
      } else {
        results.push("Middleware request mismatch");
        errorLog("Middleware request mismatch", { direct: apiRequest, middleware: mReq });
      }
      const mResp = await fetchWithRetry(
        "http://127.0.0.1:5000/v1/models",
        { method: "GET", headers, timeout: 5000 },
        1
      );
      const mBody = await mResp.text();
      log("runTests: middleware models response", {
        status: mResp.status,
        body: mBody,
      });
      if (mResp.status === 200) {
        try {
          const data = JSON.parse(mBody);
          if (JSON.stringify(data) === JSON.stringify(apiModelsData)) {
            middlewareModelsOk = true;
            const count = Array.isArray(data.data) ? data.data.length : 0;
            results.push(`Middleware models match API: ${count}`);
          } else {
            results.push("Middleware models mismatch");
            errorLog("Middleware models mismatch", {
              api: apiModelsData,
              middleware: data,
            });
          }
        } catch (e) {
          results.push("Middleware models parse failed");
          errorLog("Parsing middleware models failed", e);
        }
      } else if (mResp.status === 401 || mResp.status === 403) {
        const snippet = mBody.slice(0, 100);
        results.push(`Middleware unauthorized: ${mResp.status} ${snippet}`);
        errorLog("Middleware models unauthorized", { status: mResp.status, body: mBody });
      } else {
        results.push(`Middleware models error: ${mResp.status}`);
        errorLog("Middleware models error", mResp.status, mBody);
      }
    } catch (e) {
      results.push("Middleware models request failed");
      errorLog("Middleware models request failed", e);
    }
  } else if (serverReachable) {
    results.push("Skipping middleware models test: direct API failed");
  }
  const passed =
    apiKeyOk &&
    contentOk &&
    serverReachable &&
    serverAuthorized &&
    apiReachable &&
    apiAuthorized &&
    modelsListed &&
    middlewareModelsOk &&
    middlewareRequestMatch;
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
