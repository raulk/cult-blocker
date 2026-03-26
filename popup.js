// popup.js — renders cult toggles dynamically and persists settings.

const cultListEl = document.getElementById("cultList");
const cacheCountEl = document.getElementById("cacheCount");
const hiddenCountEl = document.getElementById("hiddenCount");

let settings = {};
let thresholds = {};

function renderCults() {
  cultListEl.innerHTML = "";

  if (CULT_REGISTRY.length === 0) {
    cultListEl.innerHTML = '<div class="empty-state">No cults configured</div>';
    return;
  }

  for (const cult of CULT_REGISTRY) {
    const enabled = settings[cult.id] !== undefined ? settings[cult.id] : cult.enabled;

    const item = document.createElement("div");
    item.className = "cult-item";
    item.innerHTML = `
      <div class="cult-info">
        <span class="cult-dot" style="background:${cult.color}"></span>
        <div class="cult-label">
          <span class="cult-name">${cult.name}</span>
          <span class="cult-desc">${cult.description}</span>
        </div>
      </div>
      <label class="toggle">
        <input type="checkbox" data-cult="${cult.id}" ${enabled ? "checked" : ""}>
        <span class="slider" style="${enabled ? `background:${cult.color}` : ""}"></span>
      </label>
    `;

    const checkbox = item.querySelector("input");
    const slider = item.querySelector(".slider");

    checkbox.addEventListener("change", () => {
      settings[cult.id] = checkbox.checked;
      slider.style.background = checkbox.checked ? cult.color : "#38444d";
      saveAndBroadcast();
    });

    cultListEl.appendChild(item);

    if (cult.model) {
      const val = thresholds[cult.id] ?? cult.model.threshold ?? 0.73;
      const row = document.createElement("div");
      row.className = "threshold-row";
      row.innerHTML = `
        <label>Threshold</label>
        <input type="range" min="0.50" max="0.95" step="0.01" value="${val}">
        <span class="threshold-val">${val.toFixed(2)}</span>
      `;

      const range = row.querySelector("input[type=range]");
      const valEl = row.querySelector(".threshold-val");

      range.addEventListener("input", () => {
        valEl.textContent = parseFloat(range.value).toFixed(2);
      });

      range.addEventListener("change", () => {
        thresholds[cult.id] = parseFloat(range.value);
        chrome.storage.local.set({ cultThresholds: thresholds });
        chrome.storage.local.remove("pfp_cache");
      });

      cultListEl.appendChild(row);
    }
  }
}

function saveAndBroadcast() {
  chrome.storage.local.set({ cultSettings: settings });

  chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: "cultSettingsChanged",
        settings,
      });
    }
  });
}

// --- Init ---

chrome.storage.local.get(["cultSettings", "cultThresholds"], (data) => {
  settings = data.cultSettings || {};
  thresholds = data.cultThresholds || {};
  renderCults();
});

// Cache count
chrome.runtime.sendMessage({ type: "getCacheStats" }, (response) => {
  if (response) cacheCountEl.textContent = response.count;
});

// Clear cache
document.getElementById("clearCache").addEventListener("click", () => {
  chrome.storage.local.remove("pfp_cache", () => {
    cacheCountEl.textContent = "0";
    chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }, (tabs) => {
      for (const tab of tabs) chrome.tabs.reload(tab.id);
    });
  });
});

// Hidden count from badge
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) {
    chrome.action.getBadgeText({ tabId: tabs[0].id }, (text) => {
      hiddenCountEl.textContent = text || "0";
    });
  }
});
