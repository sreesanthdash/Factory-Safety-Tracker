"""Download the public local YOLO26 fire/smoke checkpoint without an API key."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

from huggingface_hub import hf_hub_download


ROOT = Path(__file__).resolve().parents[1]
REPO_ID = "seawsurf/fire_yolo"
FILENAME = "weights/best.pt"
OUTPUT = ROOT / "ai" / "models" / "hazards" / "fire_smoke.pt"


def main() -> None:
    cached_path = Path(hf_hub_download(repo_id=REPO_ID, filename=FILENAME, repo_type="model"))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with cached_path.open("rb") as source, tempfile.NamedTemporaryFile(prefix="fire-smoke-", suffix=".pt.part", dir=OUTPUT.parent, delete=False) as target:
            temporary_path = Path(target.name)
            shutil.copyfileobj(source, target)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary_path, OUTPUT)
        temporary_path = None
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()

    print(f"Downloaded and verified {REPO_ID} to {OUTPUT}.")
    print("The checkpoint detects fire and smoke. Electrical spark/arc detection requires spark-labeled custom weights or a connected electrical sensor.")


if __name__ == "__main__":
    main()
