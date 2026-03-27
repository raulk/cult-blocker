// classifier.js — image classifier using ONNX models with heuristic fallback.
//
// Cults with a `model` field in CULT_REGISTRY use ONNX inference.
// Cults with only a `heuristic` field use the color-histogram scorer.

const CultClassifier = (() => {
  const MODEL_INPUT_SIZE = 256;
  const HEURISTIC_SIZE = 64;
  // Cached ONNX sessions keyed by encoder key.
  const sessions = new Map();
  // In-flight session creation promises (deduplicates concurrent requests).
  const sessionPromises = new Map();
  // Cached centroids keyed by JSON path.
  const centroids = new Map();

  // --- IndexedDB model cache (persists downloaded ONNX across sessions) ---

  function openModelDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("cult-blocker-models", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("models");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function fetchModelBuffer(url) {
    const db = await openModelDB();

    const cached = await new Promise((resolve) => {
      const tx = db.transaction("models", "readonly");
      const req = tx.objectStore("models").get(url);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
    if (cached) {
      console.log(`[cult-blocker] Model loaded from cache (${(cached.byteLength / 1e6).toFixed(1)} MB)`);
      return cached;
    }

    console.log(`[cult-blocker] Downloading model from ${url}...`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Model download failed: ${resp.status}`);
    const buffer = await resp.arrayBuffer();

    await new Promise((resolve, reject) => {
      const tx = db.transaction("models", "readwrite");
      tx.objectStore("models").put(buffer, url);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    console.log(`[cult-blocker] Model cached (${(buffer.byteLength / 1e6).toFixed(1)} MB)`);
    return buffer;
  }

  // --- ONNX session management ---

  async function getSession(encoderKey) {
    if (sessions.has(encoderKey)) return sessions.get(encoderKey);
    if (sessionPromises.has(encoderKey)) return sessionPromises.get(encoderKey);

    const promise = (async () => {
      ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/");

      const source = encoderKey.startsWith("http")
        ? new Uint8Array(await fetchModelBuffer(encoderKey))
        : chrome.runtime.getURL(encoderKey);

      return ort.InferenceSession.create(source, {
        executionProviders: ["wasm"],
      });
    })();

    sessionPromises.set(encoderKey, promise);
    try {
      const session = await promise;
      sessions.set(encoderKey, session);
      return session;
    } finally {
      sessionPromises.delete(encoderKey);
    }
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
        ctx.drawImage(img, 0, 0, size, size);
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
    const raw = results[session.outputNames[0]].data;
    // L2-normalize (HF export outputs unnormalized embeddings).
    let norm = 0;
    for (let i = 0; i < raw.length; i++) norm += raw[i] * raw[i];
    norm = Math.sqrt(norm);
    const embedding = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) embedding[i] = raw[i] / norm;

    const similarity = cosineSimilarity(embedding, centroid);
    const threshold = cult.model.threshold ?? 0.65;
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
