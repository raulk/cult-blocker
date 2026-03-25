// classifier.js — parameterized image classifier.
//
// PoC: color-histogram heuristic with per-cult parameters from CULT_REGISTRY.
// See cults.js for parameter definitions.
//
// === UPGRADING TO REAL MODELS ===
//
// Option A: per-cult fine-tuned classifiers
//   Add `model: { path: "models/<cult>.onnx" }` to each cult in cults.js.
//   Load the appropriate ONNX model per cult. Run binary classification.
//
// Option B: single CLIP model + per-cult centroid
//   Add `model: { centroid: Float32Array }` to each cult in cults.js.
//   Load MobileCLIP once, embed the PFP, compare against each cult's centroid.
//   This is the most scalable approach: adding a new cult only requires
//   computing a new centroid from ~100 reference images.
//
// === END UPGRADE NOTES ===

const CultClassifier = (() => {
  const CANVAS_SIZE = 64;

  async function loadImage(url) {
    const canvas = document.getElementById("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;

    const img = new Image();
    img.crossOrigin = "anonymous";

    return new Promise((resolve, reject) => {
      img.onload = () => {
        ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
        resolve(ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE));
      };
      img.onerror = () => reject(new Error("Failed to load: " + url));
      img.src = url;
    });
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return [h * 360, s, l];
  }

  /**
   * Analyze image pixels and return feature vector.
   * Computed once per image, reused across all cult heuristics.
   */
  function extractFeatures(imageData) {
    const pixels = imageData.data;
    const totalPixels = CANVAS_SIZE * CANVAS_SIZE;
    const hueHist = new Float32Array(12);

    // Per-pixel accumulators
    const features = { totalPixels, hslPixels: [] };

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const [h, s, l] = rgbToHsl(r, g, b);
      features.hslPixels.push([h, s, l]);
      hueHist[Math.floor(h / 30) % 12]++;
    }

    // Normalize hue histogram
    const totalHue = hueHist.reduce((a, b) => a + b, 0);
    features.normalizedHist = Array.from(hueHist).map((v) => v / totalHue);
    features.maxHueBin = Math.max(...features.normalizedHist);

    return features;
  }

  /**
   * Score a feature set against a cult's heuristic parameters.
   */
  function scoreAgainstHeuristic(features, h) {
    const { totalPixels, hslPixels, maxHueBin } = features;
    let skinCount = 0, darkCount = 0, satCount = 0, pastelCount = 0;

    for (const [hue, sat, lit] of hslPixels) {
      if (
        hue >= h.skinHue[0] && hue <= h.skinHue[1] &&
        sat >= h.skinSat[0] && sat <= h.skinSat[1] &&
        lit >= h.skinLit[0] && lit <= h.skinLit[1]
      ) skinCount++;

      if (lit < 0.2) darkCount++;
      if (sat > 0.5 && lit > 0.2 && lit < 0.8) satCount++;
      if (sat < 0.3 && lit > 0.7) pastelCount++;
    }

    const skinRatio = skinCount / totalPixels;
    const darkRatio = darkCount / totalPixels;
    const satRatio = satCount / totalPixels;
    const pastelRatio = pastelCount / totalPixels;

    let score = 0;
    if (skinRatio > 0.08) score += skinRatio * h.skinWeight;
    if (darkRatio > h.darkRange[0] && darkRatio < h.darkRange[1]) score += h.darkBonus;
    if (satRatio > h.satRange[0] && satRatio < h.satRange[1]) score += satRatio * h.satWeight;
    if (pastelRatio < h.pastelCap) score += h.pastelBonus;
    if (maxHueBin > h.hueConcMin) score += maxHueBin * h.hueConcWeight;

    return Math.min(1.0, Math.max(0, score));
  }

  /**
   * Classify an image against multiple cults.
   * Returns array of { cultId, confidence } for matches above threshold.
   */
  async function classifyImage(imageUrl, cultIds) {
    try {
      const imageData = await loadImage(imageUrl);
      const features = extractFeatures(imageData);
      const matches = [];

      for (const cultId of cultIds) {
        const cult = CULT_REGISTRY.find((c) => c.id === cultId);
        if (!cult?.heuristic) continue;

        const confidence = scoreAgainstHeuristic(features, cult.heuristic);
        if (confidence > cult.heuristic.threshold) {
          matches.push({ cultId, confidence });
        }
      }

      return matches;
    } catch (err) {
      console.warn("[cult-blocker] Classification failed:", err);
      return [];
    }
  }

  return { classifyImage };
})();
