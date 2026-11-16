"""Fine-tune VideoMAE on videos arranged in train/val/class_name folders.

Example layout:
  datasets/ur-fall/train/fall/*.mp4
  datasets/ur-fall/train/normal/*.mp4
  datasets/ur-fall/val/fall/*.mp4
  datasets/ur-fall/val/normal/*.mp4

Add fight clips in matching train/fight and val/fight folders when licensed
RWF-2000, UBI-Fights, NTU CCTV-Fights or XD-Violence files are available.
"""

from __future__ import annotations

import argparse
import random
from collections import Counter
from contextlib import nullcontext
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from transformers import AutoImageProcessor, AutoModelForVideoClassification
from model_cache import resolve_model_directory


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = "MCG-NJU/videomae-base-finetuned-kinetics"
VIDEO_SUFFIXES = {".mp4", ".avi", ".mov", ".mkv", ".webm"}


class VideoFolderDataset(Dataset):
    def __init__(self, directories: list[Path], split: str, labels: list[str], frame_count: int, processor: Any, training: bool, max_per_class: int = 0) -> None:
        self.directories = directories
        self.split = split
        self.labels = labels
        self.label_to_id = {label: index for index, label in enumerate(labels)}
        self.frame_count = frame_count
        self.processor = processor
        self.training = training
        entries_by_label: dict[int, list[tuple[Path, int]]] = {index: [] for index in range(len(labels))}
        for directory in directories:
            split_directory = directory / split
            if not split_directory.is_dir():
                continue
            for class_directory in split_directory.iterdir():
                label = canonical_label(class_directory.name)
                if not class_directory.is_dir() or label not in self.label_to_id:
                    continue
                entries_by_label[self.label_to_id[label]].extend(
                    (path, self.label_to_id[label])
                    for path in sorted(class_directory.glob("**/*"))
                    if path.is_file() and path.suffix.lower() in VIDEO_SUFFIXES
                )
        self.entries = []
        for label_id, entries in entries_by_label.items():
            if max_per_class and len(entries) > max_per_class:
                entries = random.Random(42 + label_id).sample(entries, max_per_class)
            self.entries.extend(entries)
        if not self.entries:
            raise SystemExit(f"No supported videos found in the {split} split under: {', '.join(map(str, directories))}.")

    def __len__(self) -> int:
        return len(self.entries)

    def __getitem__(self, index: int) -> tuple[list[np.ndarray], int]:
        path, label = self.entries[index]
        capture = cv2.VideoCapture(str(path))
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if not capture.isOpened() or total <= 0:
            capture.release()
            raise RuntimeError(f"Could not decode video: {path}")
        if self.training and total > self.frame_count:
            start = random.randrange(0, max(1, total - self.frame_count + 1))
            positions = np.linspace(start, total - 1, self.frame_count).astype(int)
        else:
            positions = np.linspace(0, total - 1, self.frame_count).astype(int)
        frames: list[np.ndarray] = []
        last_frame = None
        frame_index = 0
        wanted = iter(positions.tolist())
        next_position = next(wanted, None)
        while next_position is not None:
            ok, frame = capture.read()
            if not ok:
                break
            last_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            if frame_index == next_position:
                frames.append(last_frame)
                next_position = next(wanted, None)
            frame_index += 1
        capture.release()
        if not frames or last_frame is None:
            raise RuntimeError(f"Could not read frames from: {path}")
        while len(frames) < self.frame_count:
            frames.append(frames[-1])
        return frames, label


def canonical_label(folder_name: str) -> str:
    key = folder_name.strip().lower().replace("_", "").replace("-", "").replace(" ", "")
    # RWF-2000 names its class directories Train_Fight, Train_NonFight,
    # Val_Fight and Val_NonFight; the split is already represented by the
    # parent directory, so normalize away that redundant prefix.
    for prefix in ("train", "validation", "val"):
        if key.startswith(prefix):
            key = key[len(prefix):]
            break
    if key in {"fight", "fighting", "violent", "violence"}:
        return "fight"
    if key in {"nonfight", "nonviolent", "normal", "adl", "nonviolence"}:
        return "normal"
    if key in {"fall", "falls", "falling"}:
        return "fall"
    return folder_name.strip().lower().replace(" ", "_")


def collate(processor: Any):
    def apply(batch: list[tuple[list[np.ndarray], int]]) -> tuple[torch.Tensor, torch.Tensor]:
        clips, labels = zip(*batch, strict=False)
        processed = processor(images=list(clips), return_tensors="pt")
        return processed["pixel_values"], torch.tensor(labels, dtype=torch.long)
    return apply


def run_epoch(model: Any, loader: DataLoader, device: torch.device, class_names: list[str], optimizer: Any = None, scaler: Any = None) -> tuple[float, float, dict[str, dict[str, float]]]:
    training = optimizer is not None
    model.train(training)
    loss_total = 0.0
    correct = 0
    examples = 0
    confusion = torch.zeros((len(class_names), len(class_names)), dtype=torch.int64)
    for pixels, labels in loader:
        pixels = pixels.to(device, non_blocking=True)
        labels = labels.to(device, non_blocking=True)
        if training:
            optimizer.zero_grad(set_to_none=True)
        amp_context = torch.autocast("cuda", dtype=torch.float16) if device.type == "cuda" else nullcontext()
        with torch.set_grad_enabled(training), amp_context:
            output = model(pixel_values=pixels, labels=labels)
            loss = output.loss
        if training:
            if scaler is not None:
                scaler.scale(loss).backward()
                scaler.step(optimizer)
                scaler.update()
            else:
                loss.backward()
                optimizer.step()
        batch_size = labels.shape[0]
        loss_total += float(loss.detach().item()) * batch_size
        predicted = output.logits.argmax(dim=-1)
        correct += int((predicted == labels).sum().item())
        for actual, guess in zip(labels.detach().cpu().tolist(), predicted.detach().cpu().tolist(), strict=False):
            confusion[actual, guess] += 1
        examples += batch_size
    metrics: dict[str, dict[str, float]] = {}
    for index, label in enumerate(class_names):
        true_positive = int(confusion[index, index])
        support = int(confusion[index].sum())
        predicted_count = int(confusion[:, index].sum())
        precision = true_positive / predicted_count if predicted_count else 0.0
        recall = true_positive / support if support else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        metrics[label] = {"precision": precision, "recall": recall, "f1": f1, "support": float(support)}
    return loss_total / max(1, examples), correct / max(1, examples), metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, action="append", default=None, help="Dataset root with train/<class> and val/<class>; repeat to combine datasets.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Kinetics-pretrained VideoMAE id or local model folder")
    parser.add_argument("--output", type=Path, default=ROOT / "ai" / "models" / "action")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=1, help="Use 1-2 on 6 GB laptop GPUs")
    parser.add_argument("--frames", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--device", default="auto", help="auto, cuda, or cpu; defaults to CUDA when available")
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--max-per-class", type=int, default=0, help="Cap clips per training class; 0 uses every clip.")
    args = parser.parse_args()
    data_dirs = [path.expanduser().resolve() for path in (args.data or [ROOT / "datasets" / "ur-fall"])]
    output_dir = args.output.expanduser().resolve()
    train_dirs = [directory / "train" for directory in data_dirs if (directory / "train").is_dir()]
    if not train_dirs:
        parser.error(f"None of the dataset roots contain a train split: {data_dirs}")
    labels = sorted({canonical_label(path.name) for directory in train_dirs for path in directory.iterdir() if path.is_dir()})
    if len(labels) < 2:
        parser.error("Training data needs at least two class folders, for example fall and normal.")
    if args.device.lower() == "cpu":
        device = torch.device("cpu")
        print("Training explicitly requested on CPU.")
    elif args.device.lower() in {"auto", "cuda", "0"}:
        if not torch.cuda.is_available():
            raise SystemExit("CUDA is unavailable in this environment; training stopped instead of silently falling back to CPU.")
        device = torch.device("cuda:0")
        print(f"Training on GPU {torch.cuda.get_device_name(0)} (CUDA {torch.version.cuda}).")
    else:
        device = torch.device(args.device)
        if device.type == "cuda" and not torch.cuda.is_available():
            raise SystemExit("CUDA is unavailable in this environment.")

    model_ref = resolve_model_directory(args.model, download_if_missing=True)
    processor = AutoImageProcessor.from_pretrained(model_ref, local_files_only=True)
    id_to_label = {index: label for index, label in enumerate(labels)}
    label_to_id = {label: index for index, label in id_to_label.items()}
    model = AutoModelForVideoClassification.from_pretrained(
        model_ref,
        num_labels=len(labels),
        id2label=id_to_label,
        label2id=label_to_id,
        ignore_mismatched_sizes=True,
        local_files_only=True,
    ).to(device)
    train_data = VideoFolderDataset(data_dirs, "train", labels, args.frames, processor, training=True, max_per_class=args.max_per_class)
    val_data = VideoFolderDataset(data_dirs, "val", labels, args.frames, processor, training=False)
    validation_labels = {labels[label_id] for _, label_id in val_data.entries}
    missing_validation_labels = set(labels) - validation_labels
    if missing_validation_labels:
        raise SystemExit(f"Validation data is missing classes: {', '.join(sorted(missing_validation_labels))}. Keep a held-out video split for each class.")
    class_counts = Counter(label_id for _, label_id in train_data.entries)
    if len(class_counts) != len(labels):
        missing_train_classes = [label for label_id, label in enumerate(labels) if class_counts[label_id] == 0]
        raise SystemExit(f"Training videos are missing for classes: {', '.join(missing_train_classes)}.")
    print(f"Training clips: {len(train_data)}; validation clips: {len(val_data)}; classes: {', '.join(labels)}.")
    for label_id, label in enumerate(labels):
        train_count = class_counts[label_id]
        validation_count = sum(1 for _, target in val_data.entries if target == label_id)
        if train_count < 100 or validation_count < 20:
            print(f"WARNING: {label} has only {train_count} training and {validation_count} validation clips; its recall estimate and checkpoint selection are unstable.")
    loader_options = {"num_workers": args.workers, "pin_memory": device.type == "cuda", "collate_fn": collate(processor)}
    sample_weights = [1.0 / class_counts[label_id] for _, label_id in train_data.entries]
    sampler = WeightedRandomSampler(sample_weights, num_samples=len(train_data), replacement=True)
    train_loader = DataLoader(train_data, batch_size=args.batch_size, sampler=sampler, **loader_options)
    val_loader = DataLoader(val_data, batch_size=args.batch_size, shuffle=False, **loader_options)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=0.01)
    scaler = torch.amp.GradScaler("cuda") if device.type == "cuda" else None
    best_balanced_accuracy = -1.0
    output_dir.mkdir(parents=True, exist_ok=True)
    for epoch in range(args.epochs):
        train_loss, train_accuracy, _ = run_epoch(model, train_loader, device, labels, optimizer, scaler)
        val_loss, val_accuracy, val_metrics = run_epoch(model, val_loader, device, labels)
        balanced_accuracy = sum(item["recall"] for item in val_metrics.values()) / len(val_metrics)
        class_summary = " ".join(f"{name}:P{item['precision']:.2f}/R{item['recall']:.2f}/F1{item['f1']:.2f} (n={int(item['support'])})" for name, item in val_metrics.items())
        print(f"Epoch {epoch + 1:02d}/{args.epochs}: train loss={train_loss:.4f} acc={train_accuracy:.3f}; val loss={val_loss:.4f} acc={val_accuracy:.3f} balanced-acc={balanced_accuracy:.3f}; {class_summary}")
        if balanced_accuracy >= best_balanced_accuracy:
            best_balanced_accuracy = balanced_accuracy
            model.save_pretrained(output_dir, safe_serialization=True)
            processor.save_pretrained(output_dir)
            print(f"Saved best checkpoint to {output_dir} (validation balanced accuracy {best_balanced_accuracy:.3f}).")
    print(f"Add ACTION_MODEL_PATH=ai/models/action to .env.local and restart the Python vision service.")
    print("Validation accuracy is only a small-set development check; confirm performance on separate workplace CCTV footage before use.")


if __name__ == "__main__":
    main()
