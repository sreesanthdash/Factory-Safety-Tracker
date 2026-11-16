"""Download the official pretrained VideoMAE checkpoint for local use."""

from __future__ import annotations

import argparse

from model_cache import resolve_model_directory


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="MCG-NJU/videomae-base-finetuned-kinetics")
    args = parser.parse_args()
    path = resolve_model_directory(args.model, download_if_missing=True)
    print(f"VideoMAE model available at: {path}")
    print("Review the model card license before use. No API key is required for this public checkpoint.")


if __name__ == "__main__":
    main()
