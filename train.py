#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "torch>=2.0",
#     "torchvision>=0.15",
#     "open-clip-torch>=2.24",
#     "pillow>=10.0",
#     "numpy>=1.24",
#     "tqdm>=4.65",
#     "onnx>=1.14",
#     "requests>=2.31",
# ]
# ///
"""
train.py — compute a CLIP centroid from Milady PFP images and export
the MobileCLIP image encoder to ONNX.

No negatives needed. No training loop. Just:
  1. Download Milady images (or use existing ones)
  2. Embed each with MobileCLIP-S0
  3. Average into a centroid vector
  4. Export image encoder to ONNX
  5. Save centroid as JSON

At runtime in the extension:
  1. Download ONNX image encoder from Hugging Face (cached in IndexedDB)
  2. Preprocess PFP: resize to 256x256, scale to [0,1]
  3. Run inference to get embedding, L2-normalize
  4. Cosine similarity against centroid
  5. Threshold (suggested: p5 of training distribution)

Usage:
    uv run train.py download        # fetch Milady images
    uv run train.py centroid        # compute centroid + export ONNX
    uv run train.py all             # both
"""

import argparse
import json
import logging
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import open_clip
import requests
import torch
from PIL import Image
from tqdm import tqdm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("train")

# Milady Maker: contract 0x5Af0D9827E0c53E4799BB226655A1de152A425a5
# baseURI -> https://www.miladymaker.net/milady/json/
# Images at /milady/{id}.png
MILADY_IMAGE_BASE = "https://www.miladymaker.net/milady"
MILADY_TOTAL_SUPPLY = 10000

SEED = 42
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------


def download_file(url: str, dest: Path, timeout: int = 30, retries: int = 3) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=timeout, stream=True)
            r.raise_for_status()
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, "wb") as f:
                for chunk in r.iter_content(8192):
                    f.write(chunk)
            return True
        except Exception:
            if attempt < retries - 1:
                time.sleep(1 * (attempt + 1))
    return False


def download_milady_images(data_dir: Path, count: int, workers: int) -> int:
    out_dir = data_dir / "positives" / "milady"
    out_dir.mkdir(parents=True, exist_ok=True)

    existing = len(list(out_dir.glob("*.png"))) + len(list(out_dir.glob("*.jpg")))
    if existing >= count:
        log.info(f"Already have {existing} Milady images, skipping.")
        return existing

    log.info(f"Downloading up to {count} Milady images...")
    token_ids = list(range(MILADY_TOTAL_SUPPLY))
    random.shuffle(token_ids)
    token_ids = token_ids[:count]

    downloaded = existing
    failed = 0

    def fetch_one(token_id: int) -> bool:
        dest = out_dir / f"{token_id}.png"
        if dest.exists():
            return True
        return download_file(f"{MILADY_IMAGE_BASE}/{token_id}.png", dest)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_one, tid): tid for tid in token_ids}
        pbar = tqdm(
            as_completed(futures), total=len(futures), desc="Milady images", unit="img"
        )
        for future in pbar:
            if future.result():
                downloaded += 1
            else:
                failed += 1
            pbar.set_postfix(ok=downloaded, fail=failed)

    log.info(f"Milady download: {downloaded} ok, {failed} failed.")
    return downloaded


# ---------------------------------------------------------------------------
# Centroid computation
# ---------------------------------------------------------------------------


def collect_images(directory: Path) -> list[Path]:
    images = [p for p in directory.rglob("*") if p.suffix.lower() in IMAGE_EXTENSIONS]
    images.sort()
    return images


def compute_centroid(
    images_dir: Path, output_dir: Path, device: str, batch_size: int
):
    output_dir.mkdir(parents=True, exist_ok=True)

    log.info("Loading MobileCLIP2-S0...")
    model, _, _ = open_clip.create_model_and_transforms(
        "MobileCLIP2-S0", pretrained="dfndr2b"
    )
    model = model.to(device).eval()
    log.info(f"Model loaded on {device}.")

    # Match the HF ONNX export: resize to 256x256, no center crop, [0,1] pixels.
    from torchvision import transforms

    preprocess = transforms.Compose([
        transforms.Resize((256, 256), interpolation=transforms.InterpolationMode.BICUBIC),
        transforms.ToTensor(),
    ])

    image_paths = collect_images(images_dir)
    if not image_paths:
        log.error(f"No images found in {images_dir}")
        sys.exit(1)
    log.info(f"Found {len(image_paths)} images.")

    # Embed all images
    all_embeddings = []
    failed = 0

    for i in tqdm(
        range(0, len(image_paths), batch_size), desc="Embedding", unit="batch"
    ):
        batch_paths = image_paths[i : i + batch_size]
        batch_tensors = []

        for path in batch_paths:
            try:
                img = Image.open(path).convert("RGB")
                batch_tensors.append(preprocess(img))
            except Exception:
                log.debug(f"Failed to load {path}", exc_info=True)
                failed += 1

        if not batch_tensors:
            continue

        batch = torch.stack(batch_tensors).to(device)
        with torch.no_grad():
            embeddings = model.encode_image(batch)
            embeddings = embeddings / embeddings.norm(dim=-1, keepdim=True)
        all_embeddings.append(embeddings.cpu().numpy())

    if not all_embeddings:
        log.error("No embeddings computed. Check your images.")
        sys.exit(1)

    all_embeddings = np.concatenate(all_embeddings, axis=0)
    log.info(
        f"Computed {all_embeddings.shape[0]} embeddings "
        f"(dim={all_embeddings.shape[1]}), {failed} failed."
    )

    # Average and normalize
    centroid = np.mean(all_embeddings, axis=0)
    centroid = centroid / np.linalg.norm(centroid)

    # Similarity distribution stats
    similarities = all_embeddings @ centroid
    suggested_threshold = float(np.percentile(similarities, 5))
    log.info(
        f"Similarity to centroid: "
        f"mean={similarities.mean():.4f} std={similarities.std():.4f} "
        f"min={similarities.min():.4f} max={similarities.max():.4f} "
        f"p5={np.percentile(similarities, 5):.4f} "
        f"p10={np.percentile(similarities, 10):.4f}"
    )
    log.info(f"Suggested threshold (p5): {suggested_threshold:.4f}")

    # Save centroid
    centroid_path = output_dir / "milady_centroid.json"
    centroid_data = {
        "cult_id": "milady",
        "embedding_dim": int(centroid.shape[0]),
        "centroid": centroid.tolist(),
        "stats": {
            "num_images": int(all_embeddings.shape[0]),
            "similarity_mean": float(similarities.mean()),
            "similarity_std": float(similarities.std()),
            "similarity_min": float(similarities.min()),
            "similarity_p5": float(np.percentile(similarities, 5)),
            "similarity_p10": float(np.percentile(similarities, 10)),
            "suggested_threshold": suggested_threshold,
        },
    }
    with open(centroid_path, "w") as f:
        json.dump(centroid_data, f)
    log.info(f"Saved centroid to {centroid_path}")

    # Export ONNX
    export_onnx(model, output_dir)

    log.info("=" * 60)
    log.info("Ship with the extension:")
    log.info(f"  {output_dir}/mobileclip_image_encoder.onnx")
    log.info(f"  {output_dir}/milady_centroid.json")
    log.info(f"Suggested threshold: {suggested_threshold:.2f}")
    log.info("=" * 60)


# ---------------------------------------------------------------------------
# ONNX export
# ---------------------------------------------------------------------------


def export_onnx(clip_model: torch.nn.Module, output_dir: Path):
    log.info("Exporting image encoder to ONNX...")
    clip_model = clip_model.cpu()

    visual = clip_model.visual
    visual.eval()

    dummy = torch.randn(1, 3, 256, 256)
    onnx_path = output_dir / "mobileclip_image_encoder.onnx"

    torch.onnx.export(
        visual,
        dummy,
        str(onnx_path),
        input_names=["image"],
        output_names=["embedding"],
        dynamic_axes={"image": {0: "batch"}},
        opset_version=17,
    )
    # Merge external data into a single file (browser WASM can't load .data sidecar).
    import onnx

    model_proto = onnx.load(str(onnx_path), load_external_data=True)
    onnx.save_model(model_proto, str(onnx_path), save_as_external_data=False)

    data_file = Path(str(onnx_path) + ".data")
    if data_file.exists():
        data_file.unlink()

    log.info(f"Exported: {onnx_path} ({onnx_path.stat().st_size / 1024 / 1024:.1f} MB)")

    onnx.checker.check_model(onnx_path)
    log.info("ONNX validation passed.")


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def resolve_device(device: str | None) -> str:
    if device is not None:
        return device
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def cmd_download(args: argparse.Namespace):
    random.seed(SEED)
    download_milady_images(args.data_dir, args.num_milady, args.workers)


def cmd_centroid(args: argparse.Namespace):
    device = resolve_device(args.device)
    images_dir = args.images_dir or args.data_dir / "positives" / "milady"
    compute_centroid(images_dir, args.output_dir, device, args.batch_size)


def cmd_all(args: argparse.Namespace):
    cmd_download(args)
    cmd_centroid(args)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Compute Milady CLIP centroid for Cult Blocker."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_data = argparse.ArgumentParser(add_help=False)
    p_data.add_argument("--data-dir", type=Path, default=Path("./data"))
    p_data.add_argument("--num-milady", type=int, default=10000)
    p_data.add_argument("--workers", type=int, default=16)

    p_centroid = argparse.ArgumentParser(add_help=False)
    p_centroid.add_argument("--images-dir", type=Path, default=None)
    p_centroid.add_argument("--output-dir", type=Path, default=Path("./models"))
    p_centroid.add_argument("--device", type=str, default=None)
    p_centroid.add_argument("--batch-size", type=int, default=64)

    sub.add_parser("download", parents=[p_data], help="Download Milady images")
    sub.add_parser(
        "centroid",
        parents=[p_data, p_centroid],
        help="Compute centroid and export ONNX encoder",
    )
    sub.add_parser(
        "all",
        parents=[p_data, p_centroid],
        help="Download + compute centroid",
    )

    args = parser.parse_args()
    {"download": cmd_download, "centroid": cmd_centroid, "all": cmd_all}[
        args.command
    ](args)


if __name__ == "__main__":
    main()
