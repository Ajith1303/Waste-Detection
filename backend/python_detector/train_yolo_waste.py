"""
Custom YOLOv8 Training Script for Waste & Illegal Dumping Detection.

Fine-tunes a YOLOv8 object detection model on waste/garbage datasets.

Target Classes:
  0: person
  1: garbage          (loose litter, debris, scattered trash)
  2: trash_bag        (tied plastic garbage bags, black/blue bags)
  3: plastic_bag      (carry bags, grocery bags on ground)
  4: waste            (cardboard boxes, bulky discarded items)

Usage:
  # 1. Prepare data.yaml pointing to train/val image directories
  # 2. Run fine-tuning with pretrained YOLOv8 nano:
  python train_yolo_waste.py --data path/to/data.yaml --epochs 50 --model yolov8n.pt

  # 3. For higher accuracy on GPU:
  python train_yolo_waste.py --data path/to/data.yaml --epochs 80 --model yolov8s.pt --batch 16
"""

import os
import sys
import argparse


def train(args):
    print("=" * 65)
    print("  YOLOv8 Fine-Tuning for Illegal Waste Dumping Detection")
    print("=" * 65)
    print(f"Base Weights:   {args.model}")
    print(f"Dataset YAML:   {args.data}")
    print(f"Epochs:         {args.epochs}")
    print(f"Image Size:     {args.imgsz}")
    print(f"Batch Size:     {args.batch}")
    print(f"Output Name:    {args.name}")
    print("=" * 65)

    try:
        from ultralytics import YOLO
    except ImportError:
        print("[ERROR] ultralytics is not installed. Run: pip install ultralytics")
        return 1

    if not os.path.exists(args.data):
        print(f"[ERROR] Dataset configuration file '{args.data}' does not exist.")
        print("Please provide a valid data.yaml file following YOLO format.")
        return 1

    # Load base model (transfer learning from pretrained weights)
    print(f"[INFO] Loading base weights: {args.model}...")
    model = YOLO(args.model)

    # Train
    print("[INFO] Starting training...")
    results = model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        name=args.name,
        device=args.device if args.device else None,
        save=True,
        plots=True,
        # Recommended data augmentations for CCTV outdoor surveillance:
        degrees=10.0,
        flipud=0.0,
        fliplr=0.5,
        mosaic=1.0,
        mixup=0.1,
    )

    # Export best model
    best_weights_path = os.path.join(model.trainer.save_dir, "weights", "best.pt")
    print(f"\n[INFO] Training complete! Best weights saved at: {best_weights_path}")

    if args.export_onnx:
        print("[INFO] Exporting to ONNX format for fast inference...")
        try:
            best_model = YOLO(best_weights_path)
            onnx_path = best_model.export(format="onnx")
            print(f"[INFO] ONNX model exported to: {onnx_path}")
        except Exception as e:
            print(f"[WARNING] ONNX export failed: {e}")

    print("\n" + "=" * 65)
    print("  HOW TO DEPLOY YOUR TRAINED MODEL:")
    print("=" * 65)
    print("1. Copy best.pt into backend/python_detector/:")
    print(f"   copy \"{best_weights_path}\" backend\\python_detector\\waste_model.pt")
    print("2. In backend/python_detector/.env, set:")
    print("   LOCAL_MODEL_PATH=waste_model.pt")
    print("   DETECTOR_BACKEND=yolov8")
    print("   WASTE_CLASSES=garbage,trash_bag,plastic_bag,waste")
    print("3. Restart detector service:")
    print("   python detector.py")
    print("=" * 65)
    return 0


def main():
    parser = argparse.ArgumentParser(description="Fine-tune YOLOv8 on waste datasets")
    parser.add_argument("--data", type=str, default="data.yaml", help="Path to data.yaml dataset definition")
    parser.add_argument("--model", type=str, default="yolov8n.pt", help="Pretrained base model (yolov8n.pt, yolov8s.pt, etc.)")
    parser.add_argument("--epochs", type=int, default=50, help="Number of training epochs")
    parser.add_argument("--imgsz", type=int, default=640, help="Input image resolution")
    parser.add_argument("--batch", type=int, default=16, help="Batch size")
    parser.add_argument("--device", type=str, default="", help="Device: '0', 'cpu', etc.")
    parser.add_argument("--name", type=str, default="waste_dumping_yolo", help="Run experiment name")
    parser.add_argument("--export-onnx", action="store_true", default=True, help="Export best.pt to ONNX")

    args = parser.parse_args()
    return train(args)


if __name__ == "__main__":
    sys.exit(main())
