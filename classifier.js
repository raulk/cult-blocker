// classifier.js — image classifier using ONNX models with heuristic fallback.
//
// Cults with a `model` field in CULT_REGISTRY use ONNX inference.
// Cults with only a `heuristic` field use the color-histogram scorer.

const CultClassifier = (() => {
  const MODEL_INPUT_SIZE = 224;
  const HEURISTIC_SIZE = 64;
  // Cached ONNX sessions keyed by model path.
  const sessions = new Map();
  // Cached centroids keyed by JSON path.
  const centroids = new Map();

  async function getSession(modelPath) {
    if (sessions.has(modelPath)) return sessions.get(modelPath);

    const url = chrome.runtime.getURL(modelPath);
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/");
    const session = await ort.InferenceSession.create(url, {
      executionProviders: ["wasm"],
    });
    sessions.set(modelPath, session);
    return session;
  }

  async function getCentroid(centroidPath) {
    if (centroids.has(centroidPath)) return centroids.get(centroidPath);

    const url = chrome.runtime.getURL(centroidPath);
    const resp = await fetch(url);
    const data = await resp.json();
    const vec = new Float32Array(data.centroid);
    centroids.set(centroidPath, vec);
    return vec;
  }

  // Draw image to canvas at target size. Returns ImageData.
  function loadImageToCanvas(url, size) {
    const canvas = document.getElementById("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = size;
    canvas.height = size;

    const img = new Image();
    img.crossOrigin = "anonymous";

    return new Promise((resolve, reject) => {
      img.onload = () => {
        // Resize to 256, center-crop to 224 (matches training transforms).
        if (size === MODEL_INPUT_SIZE) {
          const s = 256;
          const offset = (s - MODEL_INPUT_SIZE) / 2;
          ctx.drawImage(img, -offset, -offset, s, s);
        } else {
          ctx.drawImage(img, 0, 0, size, size);
        }
        resolve(ctx.getImageData(0, 0, size, size));
      };
      img.onerror = () => reject(new Error("Failed to load: " + url));
      img.src = url;
    });
  }

  // --- ONNX model path ---

  function preprocessForModel(imageData) {
    const { data, width, height } = imageData;
    const chw = new Float32Array(3 * height * width);
    const hw = height * width;

    for (let i = 0; i < hw; i++) {
      const r = data[i * 4] / 255;
      const g = data[i * 4 + 1] / 255;
      const b = data[i * 4 + 2] / 255;
      // MobileCLIP2-S0 expects raw [0,1] pixels (no normalization).
      chw[i] = r;
      chw[hw + i] = g;
      chw[2 * hw + i] = b;
    }

    return new ort.Tensor("float32", chw, [1, 3, height, width]);
  }

  function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async function classifyWithModel(imageUrl, cult) {
    const imageData = await loadImageToCanvas(imageUrl, MODEL_INPUT_SIZE);
    const input = preprocessForModel(imageData);
    const session = await getSession(cult.model.encoder);
    const centroid = await getCentroid(cult.model.centroid);
    const results = await session.run({ [session.inputNames[0]]: input });
    const embedding = results[session.outputNames[0]].data;

    const similarity = cosineSimilarity(embedding, centroid);
    const threshold = cult.model.threshold ?? 0.73;
    console.log(
      `[cult-blocker] ${cult.id}: similarity=${similarity.toFixed(4)} threshold=${threshold} embNorm=${Math.sqrt(embedding.reduce((s, v) => s + v * v, 0)).toFixed(4)}`
    );
    return { cultId: cult.id, confidence: similarity, threshold };
  }

  // --- Heuristic path (unchanged from PoC) ---

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

  function extractFeatures(imageData) {
    const pixels = imageData.data;
    const totalPixels = HEURISTIC_SIZE * HEURISTIC_SIZE;
    const hueHist = new Float32Array(12);
    const features = { totalPixels, hslPixels: [] };

    for (let i = 0; i < pixels.length; i += 4) {
      const [h, s, l] = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
      features.hslPixels.push([h, s, l]);
      hueHist[Math.floor(h / 30) % 12]++;
    }

    const totalHue = hueHist.reduce((a, b) => a + b, 0);
    features.normalizedHist = Array.from(hueHist).map((v) => v / totalHue);
    features.maxHueBin = Math.max(...features.normalizedHist);
    return features;
  }

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

  async function classifyWithHeuristic(imageUrl, cult) {
    const imageData = await loadImageToCanvas(imageUrl, HEURISTIC_SIZE);
    const features = extractFeatures(imageData);
    const confidence = scoreAgainstHeuristic(features, cult.heuristic);
    if (confidence > cult.heuristic.threshold) {
      return { cultId: cult.id, confidence };
    }
    return null;
  }

  // --- Public API ---

  async function classifyImage(imageUrl, cultIds) {
    try {
      const matches = [];

      for (const cultId of cultIds) {
        const cult = CULT_REGISTRY.find((c) => c.id === cultId);
        if (!cult) continue;

        const result = cult.model
          ? await classifyWithModel(imageUrl, cult)
          : cult.heuristic
            ? await classifyWithHeuristic(imageUrl, cult)
            : null;

        if (result) matches.push(result);
      }

      return matches;
    } catch (err) {
      console.warn("[cult-blocker] Classification failed:", err);
      return [];
    }
  }

  return { classifyImage };
})();
