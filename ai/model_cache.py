"""Small helpers for resolving Hugging Face models without surprise network calls."""

from __future__ import annotations

import os
from pathlib import Path


def cached_model_directory(repo_id: str) -> Path | None:
    home = Path(os.getenv("HF_HOME", Path.home() / ".cache" / "huggingface"))
    repo_cache = home / "hub" / f"models--{repo_id.replace('/', '--')}"
    ref_file = repo_cache / "refs" / "main"
    commit = ref_file.read_text(encoding="utf-8").strip() if ref_file.is_file() else ""
    candidates = [repo_cache / "snapshots" / commit] if commit else []
    snapshots = repo_cache / "snapshots"
    if snapshots.is_dir():
        candidates.extend(path for path in snapshots.iterdir() if path.is_dir())
    for candidate in candidates:
        if all((candidate / filename).is_file() for filename in ("config.json", "preprocessor_config.json", "model.safetensors")):
            return candidate
    return None


def resolve_model_directory(model_ref: str, download_if_missing: bool = True) -> str:
    local = Path(model_ref).expanduser()
    if local.is_dir():
        return str(local.resolve())
    cached = cached_model_directory(model_ref)
    if cached:
        return str(cached)
    if not download_if_missing:
        raise FileNotFoundError(f"Model {model_ref} is not cached. Run ai/download_videomae.py while online first.")
    from huggingface_hub import snapshot_download

    return snapshot_download(repo_id=model_ref)
