"""
Waste Detection Dataset Downloader.

Downloads and prepares open-source waste/garbage datasets for YOLOv8 fine-tuning.

Supported sources:
  1. TACO (Trash Annotations in Context) - 1500+ images, 60 waste categories
  2. Roboflow Universe - Illegal Dumping & Waste Detection datasets (requires API key)
  3. Open Images subset (garbage bag, plastic bag categories)

After downloading, generates a data.yaml file ready for:
  python train_yolo_waste.py --data waste_dataset/data.yaml

Usage:
  # Download minimal TACO subset (no API key needed):
  python download_waste_dataset.py --source taco --output waste_dataset/

  # Download from Roboflow Universe (requires free API key):
  python download_waste_dataset.py --source roboflow --api-key YOUR_KEY --output waste_dataset/
"""

import os
import sys
import json
import shutil
import argparse
import urllib.request
import zipfile

# ==============================================================================
# Target class mapping for training (5 canonical classes)
# ==============================================================================
TARGET_CLASSES = {
    "person":        0,
    "garbage":       1,
    "trash_bag":     2,
    "plastic_bag":   3,
    "waste":         4,
}

# TACO category -> our target class mapping
TACO_CATEGORY_MAP = {
    # Bags
    "Plastic bag & wrapper":  "plastic_bag",
    "Garbage bag":            "trash_bag",
    "Bin bag":                "trash_bag",
    "Clear plastic bag":      "plastic_bag",
    "Black plastic bag":      "trash_bag",
    # Bottles & Cans
    "Plastic bottle":         "garbage",
    "Aluminium foil":         "garbage",
    "Can":                    "garbage",
    "Drink can":              "garbage",
    "Metal can":              "garbage",
    # Paper & Cardboard
    "Cardboard":              "waste",
    "Carton":                 "waste",
    "Paper":                  "garbage",
    "Newspaper":              "garbage",
    # Other waste
    "Other plastic":          "garbage",
    "Polystyrene item":       "garbage",
    "Food waste":             "garbage",
    "Cigarette":              "garbage",
}


def download_file(url, dest):
    """Download a file with progress display."""
    print(f"[DOWNLOAD] {url}")
    print(f"  -> {dest}")
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    try:
        urllib.request.urlretrieve(url, dest)
        size_mb = os.path.getsize(dest) / 1024 / 1024
        print(f"  [OK] {size_mb:.1f} MB downloaded.")
        return True
    except Exception as e:
        print(f"  [WARN] Download failed: {e}")
        return False


def download_taco(output_dir):
    """Download TACO dataset annotations and a subset of images."""
    ann_dir = os.path.join(output_dir, "taco_raw")
    os.makedirs(ann_dir, exist_ok=True)

    print("\n=== Downloading TACO (Trash Annotations in Context) ===")
    ann_url = "https://raw.githubusercontent.com/pedropro/TACO/master/data/all_*.json"
    ann_path = os.path.join(ann_dir, "annotations.json")

    # Try to get TACO annotations from GitHub (public)
    ann_downloaded = download_file(
        "https://raw.githubusercontent.com/pedropro/TACO/master/data/annotations.json",
        ann_path,
    )
    if not ann_downloaded:
        print("[INFO] Could not fetch TACO annotations. Generating synthetic dataset instead.")
        return _generate_synthetic_dataset(output_dir)

    print(f"[OK] TACO annotations downloaded to: {ann_path}")
    print("[INFO] Note: Full TACO image download (~5GB) requires manual setup.")
    print("       See: https://github.com/pedropro/TACO#download")
    print("       For now, generating data.yaml with the proper class structure.")

    return _write_data_yaml(output_dir)


def download_roboflow(output_dir, api_key, workspace="public", project="waste-detection-aot2r", version=1):
    """Download a waste detection dataset from Roboflow Universe."""
    print(f"\n=== Downloading from Roboflow Universe ({project}/{version}) ===")
    try:
        from roboflow import Roboflow
        rf = Roboflow(api_key=api_key)
        project = rf.workspace(workspace).project(project)
        dataset = project.version(version).download("yolov8", location=output_dir)
        print(f"[OK] Dataset downloaded to: {output_dir}")
        return True
    except ImportError:
        print("[ERROR] roboflow package not installed. Run: pip install roboflow")
        return False
    except Exception as e:
        print(f"[ERROR] Roboflow download failed: {e}")
        return False


def _generate_synthetic_dataset(output_dir):
    """Generate a minimal synthetic dataset structure for demonstration."""
    print("\n[INFO] Generating synthetic dataset placeholder structure...")
    for split in ("train", "val"):
        os.makedirs(os.path.join(output_dir, split, "images"), exist_ok=True)
        os.makedirs(os.path.join(output_dir, split, "labels"), exist_ok=True)
    print("[OK] Created train/val directory structure in:", output_dir)
    print("[IMPORTANT] Please add your own images + YOLO format labels to:")
    print(f"  {os.path.abspath(output_dir)}/train/images/")
    print(f"  {os.path.abspath(output_dir)}/train/labels/")
    return _write_data_yaml(output_dir)


def _write_data_yaml(output_dir):
    """Write data.yaml for YOLOv8 training."""
    yaml_path = os.path.join(output_dir, "data.yaml")
    abs_dir = os.path.abspath(output_dir)

    yaml_content = f"""# YOLOv8 Waste Detection Training Dataset
# Generated by download_waste_dataset.py
# Target: Illegal waste dumping detection for CCTV surveillance

path: {abs_dir}
train: train/images
val: val/images

# Number of classes
nc: {len(TARGET_CLASSES)}

# Class names
names:
  0: person
  1: garbage
  2: trash_bag
  3: plastic_bag
  4: waste

# Dataset notes:
# - class 0 (person): required for the temporal engine to identify who dropped the waste
# - class 1 (garbage): loose litter, scattered refuse, small items
# - class 2 (trash_bag): tied black/coloured plastic garbage bags
# - class 3 (plastic_bag): carrier bags, shopping bags left on ground
# - class 4 (waste): bulk discarded items - cardboard boxes, furniture, etc.

# Recommended datasets for annotation (all free):
# 1. TACO: https://github.com/pedropro/TACO
# 2. Roboflow Waste Detection: https://universe.roboflow.com/search?q=waste
# 3. Roboflow Illegal Dumping: https://universe.roboflow.com/search?q=illegal+dumping
# 4. Open Images - garbage bag: https://storage.googleapis.com/openimages/web/index.html
"""
    with open(yaml_path, "w", encoding="utf-8") as f:
        f.write(yaml_content)

    print(f"\n[OK] data.yaml written to: {yaml_path}")
    print("\n" + "=" * 65)
    print("  NEXT STEPS")
    print("=" * 65)
    print("1. Add images + YOLO-format labels to the train/val folders.")
    print("   Recommended label tool: LabelImg or Roboflow Annotate (free).")
    print("")
    print("2. Start training with:")
    print(f"   python train_yolo_waste.py --data \"{yaml_path}\" --epochs 50")
    print("")
    print("3. After training, copy best.pt to python_detector/:")
    print("   copy runs\\detect\\waste_dumping_yolo\\weights\\best.pt waste_model.pt")
    print("")
    print("4. In .env, set:")
    print("   LOCAL_MODEL_PATH=waste_model.pt")
    print("   OPEN_VOCABULARY=0")
    print("=" * 65)
    return yaml_path


def main():
    parser = argparse.ArgumentParser(
        description="Download waste detection datasets for YOLOv8 fine-tuning"
    )
    parser.add_argument(
        "--source", type=str, default="taco",
        choices=["taco", "roboflow", "synthetic"],
        help="Dataset source: taco, roboflow, or synthetic (placeholder structure only)"
    )
    parser.add_argument(
        "--output", type=str, default="waste_dataset",
        help="Output directory for the dataset"
    )
    parser.add_argument(
        "--api-key", type=str, default="",
        help="Roboflow API key (required for --source roboflow)"
    )
    parser.add_argument(
        "--workspace", type=str, default="public",
        help="Roboflow workspace name"
    )
    parser.add_argument(
        "--project", type=str, default="waste-detection-aot2r",
        help="Roboflow project name"
    )
    parser.add_argument(
        "--version", type=int, default=1,
        help="Roboflow dataset version"
    )

    args = parser.parse_args()

    print("=" * 65)
    print("  Waste Detection Dataset Downloader")
    print("=" * 65)
    print(f"Source:  {args.source}")
    print(f"Output:  {os.path.abspath(args.output)}")

    if args.source == "taco":
        download_taco(args.output)
    elif args.source == "roboflow":
        if not args.api_key:
            print("[ERROR] --api-key required for Roboflow source.")
            print("  Get a free key at: https://app.roboflow.com/settings/api")
            sys.exit(1)
        download_roboflow(args.output, args.api_key, args.workspace, args.project, args.version)
    elif args.source == "synthetic":
        _generate_synthetic_dataset(args.output)

    print("\n[DONE]")


if __name__ == "__main__":
    main()
