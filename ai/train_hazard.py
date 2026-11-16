"""Fine-tune a YOLO26 hazard detector using a user-provided dataset YAML."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from ultralytics import YOLO


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "ai" / "models" / "hazards" / "best.pt"


def resolve_device(requested: str | None) -> int | str:
    import torch

    if requested and requested.lower() == "cpu":
        print("Training explicitly requested on CPU.")
        return "cpu"
    if not torch.cuda.is_available():
        raise SystemExit(
            "CUDA is unavailable in this Python environment, so training was stopped instead of falling back to CPU. "
            "Install a CUDA-enabled PyTorch build in this environment, then check torch.cuda.is_available()."
        )
    device: int | str = 0 if requested is None or requested.lower() == "auto" else requested
    print(f"Training on GPU {torch.cuda.get_device_name(0)} (CUDA {torch.version.cuda}), device={device}.")
    return device


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, help="Path to a YOLO-format dataset YAML")
    parser.add_argument("--model", default="yolo26s.pt", help="Pretrained YOLO26 base checkpoint")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=4)
    parser.add_argument("--device", default="0", help="CUDA device index (default: 0), auto, or cpu")
    args = parser.parse_args()
    device = resolve_device(args.device)

    dataset = Path(args.data).expanduser()
    if not dataset.is_absolute():
        dataset = (Path.cwd() / dataset).resolve()
    if not dataset.is_file():
        parser.error(f"Dataset YAML does not exist: {dataset}")

    model = YOLO(args.model)
    model.train(
        data=str(dataset),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        project=str(ROOT / "ai" / "runs"),
        name="hazards",
        exist_ok=True,
    )
    source = ROOT / "ai" / "runs" / "hazards" / "weights" / "best.pt"
    if not source.is_file():
        raise FileNotFoundError(f"Training finished but best.pt was not found at {source}")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, OUTPUT)
    print(f"Model saved to: {OUTPUT}")
    print("Add HAZARD_MODEL_PATH=ai/models/hazards/best.pt to .env.local, then restart the local vision service.")


if __name__ == "__main__":
    main()
