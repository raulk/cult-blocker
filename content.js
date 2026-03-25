// content.js — observes X's feed, extracts PFPs, hides posts matching enabled cults.

(function () {
  "use strict";

  const TWEET_SELECTOR = 'article[data-testid="tweet"]';
  const AVATAR_SELECTOR =
    'div[data-testid="Tweet-User-Avatar"] img[src*="pbs.twimg.com/profile_images"]';
  const DEBOUNCE_MS = 300;
  const ATTR_PROCESSED = "data-cult-checked";
  const ATTR_HIDDEN = "data-cult-hidden";

  // Per-cult hidden counts for badge
  let hiddenCounts = {};
  let enabledCults = {};

  // --- Init enabled state from storage ---

  function loadEnabledState() {
    return new Promise((resolve) => {
      chrome.storage.local.get("cultSettings", (data) => {
        const settings = data.cultSettings || {};
        for (const cult of CULT_REGISTRY) {
          enabledCults[cult.id] =
            settings[cult.id] !== undefined ? settings[cult.id] : cult.enabled;
        }
        resolve();
      });
    });
  }

  function getEnabledCultIds() {
    return Object.entries(enabledCults)
      .filter(([, v]) => v)
      .map(([k]) => k);
  }

  // --- Stats ---

  function updateBadge() {
    const total = Object.values(hiddenCounts).reduce((a, b) => a + b, 0);
    chrome.runtime.sendMessage({ type: "stats", hiddenCounts, total });
  }

  // --- Classification request ---

  async function classifyPfp(imageUrl) {
    const cultIds = getEnabledCultIds();
    if (cultIds.length === 0) return [];

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "classify", imageUrl, cultIds },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn("[cult-blocker]", chrome.runtime.lastError.message);
            resolve([]);
            return;
          }
          resolve(response?.matches || []);
        }
      );
    });
  }

  // --- Process a single tweet ---

  async function processTweet(article) {
    if (article.hasAttribute(ATTR_PROCESSED)) return;
    article.setAttribute(ATTR_PROCESSED, "1");

    const avatarImg = article.querySelector(AVATAR_SELECTOR);
    if (!avatarImg) return;

    let pfpUrl = avatarImg.src;
    pfpUrl = pfpUrl.replace(/_(?:mini|normal|bigger|200x200|400x400)\./, "_bigger.");

    const matches = await classifyPfp(pfpUrl);
    if (matches.length === 0) return;

    // Use the highest-confidence match for display
    const best = matches.reduce((a, b) => (a.confidence > b.confidence ? a : b));
    const cult = CULT_REGISTRY.find((c) => c.id === best.cultId);
    if (!cult) return;

    article.setAttribute(ATTR_HIDDEN, matches.map((m) => m.cultId).join(","));
    article.classList.add("cult-blocked");

    hiddenCounts[cult.id] = (hiddenCounts[cult.id] || 0) + 1;
    updateBadge();

    const banner = document.createElement("div");
    banner.className = "cult-blocked-banner";
    banner.style.setProperty("--cult-color", cult.color);
    banner.innerHTML = `
      <span>
        <span class="cult-blocked-dot" style="background:${cult.color}"></span>
        Post hidden — ${cult.name} PFP detected (${(best.confidence * 100).toFixed(0)}%)
      </span>
      <button class="cult-reveal-btn">Show</button>
    `;
    banner.querySelector(".cult-reveal-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      article.classList.remove("cult-blocked");
      banner.remove();
    });
    article.parentNode.insertBefore(banner, article);
  }

  // --- Scan ---

  function scanTweets() {
    const tweets = document.querySelectorAll(TWEET_SELECTOR);
    for (const tweet of tweets) {
      processTweet(tweet);
    }
  }

  // --- Debounced observer ---

  let debounceTimer = null;

  function onMutation() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanTweets, DEBOUNCE_MS);
  }

  const observer = new MutationObserver(onMutation);

  function startObserving() {
    observer.observe(document.body, { childList: true, subtree: true });
    scanTweets();
  }

  // --- Listen for settings changes from popup ---

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "cultSettingsChanged") {
      enabledCults = { ...msg.settings };

      // Unhide posts for cults that were just disabled
      document.querySelectorAll(`[${ATTR_HIDDEN}]`).forEach((article) => {
        const cultIds = article.getAttribute(ATTR_HIDDEN).split(",");
        const anyEnabled = cultIds.some((id) => enabledCults[id]);
        if (!anyEnabled) {
          article.classList.remove("cult-blocked");
          const banner = article.previousElementSibling;
          if (banner?.classList.contains("cult-blocked-banner")) banner.remove();
        } else if (!article.classList.contains("cult-blocked")) {
          article.classList.add("cult-blocked");
        }
      });
    }
  });

  // --- Init ---

  loadEnabledState().then(startObserving);

  console.log("[cult-blocker] Content script loaded.");
})();
