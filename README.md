# Cult Blocker

Chrome extension that hides posts on X from accounts with cult-affiliated PFPs.
Uses MobileCLIP2-S0 embeddings with per-cult centroids for classification.
Supports multiple cults with independent toggles and adjustable thresholds.

## Quickstart

```bash
git clone <repo-url>
cd cult-blocker
just setup
```

This fetches the ONNX runtime WASM files and verifies the models are present.
Then load the extension in Chrome:

1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" and select this directory

Navigate to https://x.com. Toggle cults on/off via the extension popup.

## How it works

Each cult has a CLIP centroid vector computed from reference PFP images. At
runtime, the extension embeds each profile picture with MobileCLIP2-S0 (ONNX,
running in WASM) and computes cosine similarity against the centroid. Posts
above the threshold get hidden behind a banner that shows the similarity score.

The classifier runs entirely in the browser. No images leave the machine.

## Currently supported cults

| Cult   | Status | Notes                                  |
|--------|--------|----------------------------------------|
| Milady | Active | Milady Maker, Remilio, and derivatives  |

More cults can be added by appending to `CULT_REGISTRY` in `cults.js` and
computing a centroid (see below).

## Retraining the centroid

`train.py` downloads Milady images, embeds them with MobileCLIP2-S0, and
averages the embeddings into a centroid vector. No negatives, no training loop.

```bash
just download                     # fetch Milady images
just centroid                     # compute centroid + export ONNX encoder
just all                          # both in one shot
```

### Subcommands

**`download`** fetches Milady NFT images into `data/positives/milady/`.

| Flag | Default | |
|---|---|---|
| `--data-dir` | `./data` | Where to store images |
| `--num-milady` | `10000` | Number of images to download |
| `--workers` | `16` | Download threads |

**`centroid`** embeds all images, computes the centroid, and exports the ONNX
image encoder.

| Flag | Default | |
|---|---|---|
| `--images-dir` | `<data-dir>/positives/milady` | Image source directory |
| `--output-dir` | `./models` | Where to write model + centroid |
| `--device` | auto | `cuda`, `mps`, or `cpu` |
| `--batch-size` | `64` | Embedding batch size |

**`all`** runs `download` then `centroid`. Accepts all flags from both.

## Adding a new cult

1. Collect ~100+ reference PFP images for the cult
2. Run `just centroid --images-dir path/to/images --output-dir models`
3. Add an entry to `CULT_REGISTRY` in `cults.js`:

```js
{
  id: "penguin",
  name: "Pudgy Penguins",
  description: "Pudgy Penguins and Lil Pudgys",
  color: "#3b82f6",
  enabled: false,
  model: {
    encoder: "models/mobileclip_image_encoder.onnx",
    centroid: "models/penguin_centroid.json",
    threshold: 0.73,
  },
}
```

All cults share the same ONNX encoder; only the centroid differs. The popup
and classifier pick up new entries automatically.

## Architecture

```
cults.js            Registry of supported cults. Each cult defines display
                    info, ONNX encoder path, centroid path, and threshold.

content.js          MutationObserver on X's feed. Extracts PFP URLs,
                    requests classification, hides matching posts.

background.js       Service worker. Routes messages, manages the
                    classification cache (chrome.storage.local, 24h TTL).

offscreen.html/js   Offscreen document. Runs ONNX inference outside
                    X's CSP sandbox.

classifier.js       Loads ONNX encoder, embeds PFPs, computes cosine
                    similarity against per-cult centroids.

popup.html/js       Extension popup. Per-cult toggles, threshold sliders,
                    cache management.

train.py            Centroid computation pipeline (uv script, not shipped).
```

## Files tracked with Git LFS

`*.onnx` and `*.wasm` files are stored in Git LFS. After cloning, run
`git lfs pull` if the files appear as pointers.
