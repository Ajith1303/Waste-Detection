# Model Training & Accuracy Improvement Guide: Illegal Waste Dumping

This guide explains why pretrained general-purpose models fail on waste dumping detection, analyzes dataset requirements, and provides step-by-step instructions to train a high-accuracy custom YOLOv8 model for production CCTV surveillance.

---

## 1. Why Pretrained COCO Models Cannot Reliably Detect Illegal Dumping

Standard object detection models (such as `yolov8n.pt`, `yolov8s.pt`, YOLOv9, YOLOv11) are pretrained on the **MS COCO dataset**, which contains 80 classes:
`person`, `bicycle`, `car`, `motorcycle`, `dog`, `backpack`, `handbag`, `suitcase`, `bottle`, `cup`, `chair`, `book`, etc.

### The Critical Limitations for Waste Dumping:
1. **No Native `garbage` or `waste` Class**:
   - COCO does not have a class for garbage piles, litter, or trash bags.
2. **Class Confusion / Misclassification**:
   - Tied plastic garbage bags are frequently misclassified as luggage items (`backpack`, `handbag`, `suitcase`) or sports balls.
   - Piles of street waste or scattered refuse are either completely missed (background) or trigger low-confidence false alarms on irrelevant classes.
3. **Person Conflation**:
   - If a detection pipeline treats any detected bounding box outside a bin as waste, a person walking down the street immediately triggers a false illegal dumping alert.
4. **Conclusion**:
   - While COCO proxy classes (`backpack`, `handbag`, `suitcase`) can be used for initial testing and prototyping, **a production-grade CCTV illegal dumping detector MUST be fine-tuned on dedicated waste datasets**.

---

## 2. Recommended Target Classes

For maximum detection accuracy and separation in CCTV camera footage, train on the following 5 classes:

| Class Name | Description | Example Visuals |
|---|---|---|
| `person` | Humans entering the CCTV frame | Pedestrians, residents, offenders |
| `garbage` | Piles of loose refuse, street trash, scattered litter | Organic waste, dumped papers, mixed debris |
| `trash_bag` | Tied plastic trash bags, sacks, polythene garbage bags | Black/blue/green refuse bags on curbs or ground |
| `plastic_bag` | Small plastic carry bags, shopping bags | Discarded grocery polythene bags |
| `waste` | Bulky discarded items, boxes, packaging containers | Cardboard cartons, discarded household items |

> **Pro Tip**: Grouping rare items into these 4 waste categories yields significantly higher mAP (mean Average Precision) than having 30 granular classes like `banana_peel`, `paper_cup`, etc.

---

## 3. Recommended Open-Source Datasets

Instead of collecting and labeling thousands of images from scratch, leverage these existing public datasets:

1. **TACO (Trash Annotations in Context)**:
   - **URL**: <https://github.com/pedropro/TACO>
   - High-quality open-source dataset with thousands of labeled waste objects in diverse outdoor and urban settings.
2. **Roboflow Universe - Waste & Illegal Dumping Datasets**:
   - **Search**: <https://universe.roboflow.com/search?q=waste+detection> or <https://universe.roboflow.com/search?q=illegal+dumping>
   - Features pre-labeled datasets specifically captured from street CCTV and roadside cameras.
3. **Mendeley Waste Dataset**:
   - **URL**: <https://data.mendeley.com/datasets/v5ndmt22gx/1>
   - Thousands of categorized images of street trash and illegal dumping sites.
4. **Your Own Captured CCTV Frames**:
   - Frames collected by this system are automatically saved in `backend/uploads/`.
   - Run `node scripts/build_training_dataset.js` to deduplicate and export frames captured from your actual cameras.

---

## 4. Fine-Tuning YOLOv8 on Custom Waste Datasets

A dedicated training script is provided at `backend/python_detector/train_yolo_waste.py`.

### Step 1: Create `data.yaml`
Organize your dataset in YOLO format and create a `data.yaml` file:

```yaml
path: /path/to/dataset  # Dataset root directory
train: images/train     # Train images (relative to 'path')
val: images/val         # Validation images (relative to 'path')

names:
  0: person
  1: garbage
  2: trash_bag
  3: plastic_bag
  4: waste
```

### Step 2: Run Training
Execute fine-tuning with transfer learning from `yolov8n.pt` (or `yolov8s.pt` for higher accuracy):

```bash
cd backend/python_detector

# Fast training (Nano model):
python train_yolo_waste.py --data path/to/data.yaml --epochs 50 --model yolov8n.pt

# Higher accuracy on GPU (Small model):
python train_yolo_waste.py --data path/to/data.yaml --epochs 80 --model yolov8s.pt --batch 16 --device 0
```

The script trains the model, saves training metric plots (loss, precision-recall curve, confusion matrix), and automatically exports `best.pt` and `best.onnx`.

---

## 5. Deploying Your Fine-Tuned Model

Once training is complete:

1. Copy the generated `best.pt` into `backend/python_detector/`:
   ```powershell
   copy runs\detect\waste_dumping_yolo\weights\best.pt backend\python_detector\waste_model.pt
   ```

2. Update `backend/python_detector/.env`:
   ```ini
   DETECTOR_BACKEND=yolov8
   LOCAL_MODEL_PATH=waste_model.pt
   WASTE_CLASSES=garbage,trash_bag,plastic_bag,waste
   ```

3. Restart the Python detector service:
   ```powershell
   python detector.py
   ```
   Or run the CCTV detector directly:
   ```powershell
   python cctv_detector.py --source 0 --display
   ```

---

## 6. Real-Time Detection Checklist for Production Accuracy

- **Camera Angle & Mounting**: Mount cameras 2.5m–4m above ground with a 30°–45° tilt. This provides clear views of both persons and dropped objects while minimizing occlusion.
- **Stationary Duration Threshold**: Keep `STATIONARY_DURATION_SEC` between `5.0` and `10.0` seconds to distinguish temporary stops (e.g. setting down a backpack to tie a shoe) from permanent dumping.
- **Departure Distance**: Keep `LEAVE_DISTANCE_THRESHOLD` between `0.30` and `0.40` normalized distance.
- **Spatial Cooldown**: Set `COOLDOWN_MINUTES=15.0` and `SPATIAL_COOLDOWN_RADIUS=0.08` to prevent duplicate alerts on the same discarded object.