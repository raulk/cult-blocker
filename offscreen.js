// offscreen.js — bridges service worker messages to the classifier.

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "update-thresholds") {
    for (const cult of CULT_REGISTRY) {
      if (cult.model && msg.thresholds[cult.id] !== undefined) {
        cult.model.threshold = msg.thresholds[cult.id];
      }
    }
    return;
  }

  if (msg.type !== "offscreen-classify") return;

  CultClassifier.classifyImage(msg.imageUrl, msg.cultIds)
    .then((matches) => {
      chrome.runtime.sendMessage({
        type: "offscreen-result",
        id: msg.id,
        matches,
      });
    })
    .catch((err) => {
      console.error("[cult-blocker] Offscreen classify error:", err);
      chrome.runtime.sendMessage({
        type: "offscreen-result",
        id: msg.id,
        matches: [],
      });
    });
});

console.log("[cult-blocker] Offscreen document ready.");
