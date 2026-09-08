"""
Google Colab Training Script for YOLOv8 Waste Detection Model.

This script is designed to run on Google Colab (free T4 GPU).
Copy-paste each section into a Colab cell, or run the whole file.

Steps:
  1. Open https://colab.research.google.com
  2. Runtime -> Change runtime type -> T4 GPU
  3. Paste and run each cell block below
  4. Download waste_model.pt and copy it to backend/python_detector/
  5. In .env: LOCAL_MODEL_PATH=waste_model.pt, OPEN_VOCABULARY=0
"""

# ==============================================================================
# CELL 1: Install dependencies
# ==============================================================================
# !pip install ultralytics roboflow --quiet

# ==============================================================================
# CELL 2: Download a waste dataset from Roboflow Universe (FREE)
# Get your API key at https://app.roboflow.com/settings/api (free account)
# ==============================================================================
ROBOFLOW_API_KEY = "YOUR_ROBOFLOW_API_KEY"  # <-- Replace with your key

# from roboflow import Roboflow
# rf = Roboflow(api_key=ROBOFLOW_API_KEY)
#
# Option A: Illegal Dumping Detection dataset
# project = rf.workspace("roboflow-universe-projects").project("illegal-dumping-detection")
# dataset = project.version(1).download("yolov8")
#
# Option B: Waste / Garbage Detection dataset
# project = rf.workspace("roboflow-universe-projects").project("garbage-classification-3")
# dataset = project.version(12).download("yolov8")

# ==============================================================================
# CELL 3: (Alternative) Use TACO dataset
# ==============================================================================
# !git clone https://github.com/pedropro/TACO.git
# %cd TACO
# !pip install -r requirements.txt
# !python download.py

# ==============================================================================
# CELL 4: Create data.yaml (5 waste classes)
# Adjust paths to match where dataset was downloaded
# ==============================================================================
DATA_YAML = """
path: /content/dataset
train: train/images
val: valid/images

nc: 5
names:
  0: person
  1: garbage
  2: trash_bag
  3: plastic_bag
  4: waste
"""

# with open("waste_data.yaml", "w") as f:
#     f.write(DATA_YAML)
# print("data.yaml created!")

# ==============================================================================
# CELL 5: Fine-tune YOLOv8 on the waste dataset
# Using YOLOv8s (small) as base - good balance of speed and accuracy for CCTV
# ==============================================================================
TRAINING_CONFIG = {
    "model":   "yolov8s.pt",    # Base weights (auto-downloaded)
    "data":    "waste_data.yaml",
    "epochs":  50,
    "imgsz":   640,
    "batch":   16,
    "name":    "waste_dumping_detector",
    "device":  0,               # GPU 0 (T4 on Colab)
    # CCTV-optimised augmentations
    "degrees":  10.0,
    "flipud":   0.0,
    "fliplr":   0.5,
    "mosaic":   1.0,
    "mixup":    0.1,
}

# from ultralytics import YOLO
# model = YOLO(TRAINING_CONFIG["model"])
# results = model.train(**TRAINING_CONFIG)
# print("Training complete!")
# print("Best weights:", results.save_dir + "/weights/best.pt")

# ==============================================================================
# CELL 6: Evaluate on validation set
# ==============================================================================
# metrics = model.val()
# print(f"mAP50: {metrics.box.map50:.3f}")
# print(f"mAP50-95: {metrics.box.map:.3f}")

# ==============================================================================
# CELL 7: Export model + Download to your PC
# ==============================================================================
# import shutil
# best_pt = str(results.save_dir) + "/weights/best.pt"
# shutil.copy(best_pt, "/content/waste_model.pt")
# print("Saved to /content/waste_model.pt")
#
# # Download to your local PC
# from google.colab import files
# files.download("/content/waste_model.pt")

# ==============================================================================
# DEPLOYMENT: After downloading waste_model.pt to your PC
# ==============================================================================
# 1. Copy to detector folder:
#    copy waste_model.pt c:\Users\ASUS\OneDrive\Desktop\ibm\backend\python_detector\
#
# 2. Update .env:
#    LOCAL_MODEL_PATH=waste_model.pt
#    OPEN_VOCABULARY=0
#    WASTE_CLASSES=garbage,trash_bag,plastic_bag,waste
#    ROBOFLOW_CONFIDENCE=0.35
#
# 3. Restart the Python detector:
#    python detector.py
#
# Your custom model will then detect actual waste bags, garbage piles,
# and litter directly — trained on real CCTV surveillance data!

if __name__ == "__main__":
    print("=" * 65)
    print("  Colab Training Guide for Waste Dumping Detection Model")
    print("=" * 65)
    print()
    print("This file is a guide. To train:")
    print("1. Open Google Colab: https://colab.research.google.com")
    print("2. Runtime -> Change runtime type -> T4 GPU (free)")
    print("3. Copy each CELL block into a new Colab cell and run it")
    print()
    print("Or run locally with GPU:")
    print("   python train_yolo_waste.py \\")
    print("     --data waste_dataset/data.yaml \\")
    print("     --epochs 50 \\")
    print("     --model yolov8s.pt \\")
    print("     --device 0")
    print("=" * 65)
