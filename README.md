# Cult Blocker — Chrome Extension PoC

Hides posts on X from accounts with cult-affiliated PFPs. Supports
multiple cults with independent toggles.

## Architecture

```
cults.js            Registry of supported cults. Each cult defines
                    display info and classifier parameters. Adding a
                    new cult is a single object in this file.

content.js          MutationObserver on X's feed. Extracts PFP URLs,
                    requests classification against all enabled cults,
                    hides matching posts with cult-colored banners.

background.js       Service worker. Routes messages, manages the
                    classification cache (chrome.storage.local, 24h TTL).

offscreen.html/js   Offscreen document. Runs the classifier outside
                    X's CSP sandbox.

classifier.js       Parameterized classifier. Extracts image features
                    once, scores against each cult's heuristic params.

popup.html/js       Popup UI. Dynamically renders per-cult toggles
                    from the registry. Settings persist across sessions.
```

## Currently supported cults

| Cult   | Status  | Notes                                   |
|--------|---------|-----------------------------------------|
| Milady | Active  | Milady Maker, Remilio, and derivatives   |

More cults can be added by appending to `CULT_REGISTRY` in `cults.js`.
Commented-out examples for Azuki, Pudgy Penguins, and BAYC are included.

## Install (developer mode)

1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select this directory

Navigate to https://x.com. Toggle cults on/off via the popup.

## Adding a new cult

Open `cults.js` and add an entry to `CULT_REGISTRY`:

```js
{
  id: "penguin",
  name: "Pudgy Penguins",
  description: "Pudgy Penguins and Lil Pudgys",
  color: "#3b82f6",
  enabled: false,
  heuristic: {
    skinHue: [190, 220],     // blue-ish body tones
    skinSat: [0.3, 0.8],
    skinLit: [0.5, 0.85],
    skinWeight: 2.0,
    darkRange: [0.02, 0.3],
    darkBonus: 0.1,
    satRange: [0.2, 0.7],
    satWeight: 0.6,
    pastelCap: 0.5,
    pastelBonus: 0.1,
    hueConcWeight: 0.5,
    hueConcMin: 0.3,
    threshold: 0.5,
  },
}
```

The popup and classifier pick it up automatically. No other files need changes.

## Upgrading classifiers

The PoC heuristic is intentionally naive. Two upgrade paths:

**Per-cult fine-tuned model (best accuracy)**
Add `model: { path: "models/<cult>.onnx" }` to each cult entry.
See `classifier.js` for integration notes.

**Single CLIP model + per-cult centroid (best scalability)**
Add `model: { centroid: Float32Array }` to each cult entry.
Load MobileCLIP once, compute cosine similarity per centroid.
Adding a new cult = computing a centroid from ~100 reference images.

## Files

```
manifest.json       MV3 manifest
cults.js            Cult registry (add new cults here)
content.js          Feed observer and DOM manipulation
content.css         Styles for hidden posts and reveal banners
background.js       Service worker (cache, routing)
offscreen.html      Offscreen document shell
offscreen.js        Message bridge to classifier
classifier.js       Parameterized image classifier
popup.html          Extension popup UI
popup.js            Popup logic (dynamic cult toggles)
icons/              Extension icons
```
