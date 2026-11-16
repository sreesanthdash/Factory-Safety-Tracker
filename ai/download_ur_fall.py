"""Download the public UR Fall RGB camera-0 clips into train/validation folders.

The dataset is CC BY-NC-SA 4.0 and is for non-commercial academic use. The
script only fetches the RGB MP4s linked from the official dataset page.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
SOURCE = "https://fenix.ur.edu.pl/~mkepski/ds/data"
DEFAULT_OUTPUT = ROOT / "datasets" / "ur-fall"


def target_for(kind: str, sequence: int) -> tuple[str, Path]:
    # Keep complete sequences together to avoid near-identical train/val clips.
    split = "val" if sequence >= (26 if kind == "fall" else 33) else "train"
    filename = f"{kind}-{sequence:02d}-cam0.mp4"
    return f"{SOURCE}/{filename}", Path(split) / ("fall" if kind == "fall" else "normal") / filename


def download(url: str, destination: Path, retries: int = 3) -> None:
    if destination.is_file() and destination.stat().st_size > 50_000:
        print(f"Already present: {destination}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    for attempt in range(1, retries + 1):
        request = Request(url, headers={"User-Agent": "FactorySafetyConsoleDatasetSetup/1.0"})
        try:
            with urlopen(request, timeout=45) as response, partial.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if partial.stat().st_size <= 50_000:
                raise OSError("The response was too small to be an MP4 video.")
            partial.replace(destination)
            print(f"Downloaded: {destination}")
            return
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            partial.unlink(missing_ok=True)
            if attempt == retries:
                raise SystemExit(f"Could not download {url}: {error}") from error
            time.sleep(attempt * 2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--limit", type=int, default=0, help="Only fetch the first N sequences of each class (useful for a quick setup check).")
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    print("Source: https://fenix.ur.edu.pl/~mkepski/ds/uf.html")
    print("License: CC BY-NC-SA 4.0; non-commercial academic use only.")
    for kind, total in (("fall", 30), ("adl", 40)):
        limit = min(total, args.limit) if args.limit > 0 else total
        for sequence in range(1, limit + 1):
            url, relative_target = target_for(kind, sequence)
            destination = output / relative_target
            download(url, destination)
    print(f"Dataset ready at {output}")
    print("The sequence-level split is train/{fall,normal} and val/{fall,normal}.")


if __name__ == "__main__":
    main()
