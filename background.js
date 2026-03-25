// background.js — service worker: routes classify requests, manages cache.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = "pfp_cache";

// --- Cache ---

async function getCachedResult(imageUrl) {
  const data = await chrome.storage.local.get(CACHE_KEY);
  const cache = data[CACHE_KEY] || {};
  const entry = cache[imageUrl];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    delete cache[imageUrl];
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
    return null;
  }
  return entry.result;
}

async function setCachedResult(imageUrl, result) {
  const data = await chrome.storage.local.get(CACHE_KEY);
  const cache = data[CACHE_KEY] || {};
  const keys = Object.keys(cache);
  if (keys.length > 2000) {
    const sorted = keys.sort((a, b) => cache[a].ts - cache[b].ts);
    for (let i = 0; i < 500; i++) delete cache[sorted[i]];
  }
  cache[imageUrl] = { result, ts: Date.now() };
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

// --- Offscreen document ---

let offscreenCreating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;
  if (offscreenCreating) { await offscreenCreating; return; }
  offscreenCreating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Classify profile images using ML model",
  });
  await offscreenCreating;
  offscreenCreating = null;
}

// --- Pending classifications ---

const pending = new Map();
let nextId = 0;

async function handleClassify(imageUrl, cultIds) {
  // Check cache (cache stores results for ALL cults tested)
  const cached = await getCachedResult(imageUrl);
  if (cached) {
    // Filter to only requested cults
    const matches = cached.filter((m) => cultIds.includes(m.cultId));
    return { matches };
  }

  await ensureOffscreen();
  const id = ++nextId;

  return new Promise((resolve) => {
    pending.set(id, (result) => {
      setCachedResult(imageUrl, result);
      const matches = result.filter((m) => cultIds.includes(m.cultId));
      resolve({ matches });
    });

    chrome.runtime.sendMessage({
      type: "offscreen-classify",
      imageUrl,
      cultIds,
      id,
    });

    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        setCachedResult(imageUrl, []);
        resolve({ matches: [] });
      }
    }, 10000);
  });
}

// --- Message handler ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "classify") {
    handleClassify(msg.imageUrl, msg.cultIds).then(sendResponse);
    return true;
  }

  if (msg.type === "offscreen-result" && pending.has(msg.id)) {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb(msg.matches);
    return false;
  }

  if (msg.type === "stats") {
    const text = msg.total > 0 ? String(msg.total) : "";
    chrome.action.setBadgeText({ text, tabId: sender.tab?.id });
    chrome.action.setBadgeBackgroundColor({ color: "#e74c6f" });
    return false;
  }

  if (msg.type === "getCacheStats") {
    chrome.storage.local.get(CACHE_KEY, (data) => {
      const cache = data[CACHE_KEY] || {};
      sendResponse({ count: Object.keys(cache).length });
    });
    return true;
  }
});

console.log("[cult-blocker] Service worker loaded.");
