// cults.js — registry of supported cults.
//
// Each cult defines:
//   id           Unique key, used in storage and messaging
//   name         Display name
//   description  Short description for the popup
//   color        Accent color for UI elements
//   enabled      Default enabled state
//   heuristic    Parameters for the PoC color-histogram classifier
//                (swap for per-cult model paths when upgrading to ONNX)
//
// To add a new cult:
// 1. Add an entry below with tuned heuristic params.
// 2. That's it. The popup, content script, and classifier pick it up automatically.
//
// To upgrade to real models:
// Add a `model` field with { path: "models/cultname.onnx", centroid: [...] }
// and update classifier.js to dispatch on model vs heuristic.

const CULT_REGISTRY = [
  {
    id: "milady",
    name: "Milady",
    description: "Milady Maker, Remilio, and derivatives",
    color: "#e74c6f",
    enabled: true,
    model: {
      encoder: "models/mobileclip_image_encoder.onnx",
      centroid: "models/milady_centroid.json",
      threshold: 0.65,
    },
    heuristic: {
      // Warm pastel skin, dark hair, anime saturation, limited palette
      skinHue: [10, 40],
      skinSat: [0.2, 0.7],
      skinLit: [0.5, 0.85],
      skinWeight: 2.0,
      darkRange: [0.05, 0.4],
      darkBonus: 0.15,
      satRange: [0.1, 0.6],
      satWeight: 0.8,
      pastelCap: 0.4,
      pastelBonus: 0.1,
      hueConcWeight: 0.5,
      hueConcMin: 0.25,
      threshold: 0.55,
    },
  },
  // --- Add more cults below ---
  // {
  //   id: "azuki",
  //   name: "Azuki",
  //   description: "Azuki, Beanz, and Elementals",
  //   color: "#c13540",
  //   enabled: false,
  //   heuristic: {
  //     skinHue: [5, 35],
  //     skinSat: [0.15, 0.6],
  //     skinLit: [0.55, 0.9],
  //     skinWeight: 1.8,
  //     darkRange: [0.03, 0.35],
  //     darkBonus: 0.12,
  //     satRange: [0.15, 0.65],
  //     satWeight: 0.7,
  //     pastelCap: 0.5,
  //     pastelBonus: 0.08,
  //     hueConcWeight: 0.4,
  //     hueConcMin: 0.2,
  //     threshold: 0.55,
  //   },
  // },
  // {
  //   id: "penguin",
  //   name: "Pudgy Penguins",
  //   description: "Pudgy Penguins and Lil Pudgys",
  //   color: "#3b82f6",
  //   enabled: false,
  //   heuristic: { ... },
  // },
  // {
  //   id: "ape",
  //   name: "Bored Apes",
  //   description: "BAYC, MAYC, and Kennel Club",
  //   color: "#d4a843",
  //   enabled: false,
  //   heuristic: { ... },
  // },
];

// Make available in both content script and offscreen contexts
if (typeof globalThis !== "undefined") {
  globalThis.CULT_REGISTRY = CULT_REGISTRY;
}
