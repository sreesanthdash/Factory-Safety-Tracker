"""Download and extract the RWF-2000 multipart archive from Zenodo.

This dataset is about 9.4 GB compressed. Part files are resumed and checked
against the MD5 checksums published by Zenodo before extraction.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
RECORD_ID = "15687512"
API_URL = f"https://zenodo.org/api/records/{RECORD_ID}"
DEFAULT_OUTPUT = ROOT / "datasets" / "rwf2000"
PROGRESS_LOCK = threading.Lock()
PROGRESS_BYTES = 0
PRINTED_MILESTONE = 0
CHUNK_SIZE = 4 * 1024 * 1024


def download_part(file_info: dict, directory: Path, total_size: int) -> Path:
    global PROGRESS_BYTES, PRINTED_MILESTONE
    name = file_info["key"]
    destination = directory / name
    checksum_type, expected_checksum = file_info["checksum"].split(":", 1)
    if checksum_type.lower() != "md5":
        raise SystemExit(f"Unsupported checksum for {name}: {checksum_type}")
    if destination.is_file() and destination.stat().st_size == file_info["size"]:
        existing_digest = hashlib.md5()
        with destination.open("rb") as existing_file:
            while data := existing_file.read(CHUNK_SIZE):
                existing_digest.update(data)
        if existing_digest.hexdigest() == expected_checksum:
            print(f"Verified existing part {name}", flush=True)
            return destination
    partial = destination.with_suffix(destination.suffix + ".part")
    url = f"https://zenodo.org/records/{RECORD_ID}/files/{name}?download=1"
    for attempt in range(1, 6):
        offset = partial.stat().st_size if partial.is_file() else 0
        headers = {"User-Agent": "FactorySafetyConsoleDatasetSetup/1.0"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        try:
            request = Request(url, headers=headers)
            with urlopen(request, timeout=120) as response:
                append = offset > 0 and getattr(response, "status", 200) == 206
                if offset and not append:
                    offset = 0
                mode = "ab" if append else "wb"
                with partial.open(mode) as output:
                    while data := response.read(CHUNK_SIZE):
                        output.write(data)
                        with PROGRESS_LOCK:
                            PROGRESS_BYTES += len(data)
                            milestone = int(PROGRESS_BYTES / (512 * 1024 * 1024))
                            if milestone > PRINTED_MILESTONE:
                                PRINTED_MILESTONE = milestone
                                print(f"RWF-2000 download: {PROGRESS_BYTES / (1024**3):.1f} / {total_size / (1024**3):.1f} GiB", flush=True)
            if partial.stat().st_size != file_info["size"]:
                raise OSError(f"{name} has {partial.stat().st_size} bytes; expected {file_info['size']}.")
            digest = hashlib.md5()
            with partial.open("rb") as input_file:
                while data := input_file.read(CHUNK_SIZE):
                    digest.update(data)
            if digest.hexdigest() != expected_checksum:
                partial.unlink(missing_ok=True)
                raise OSError(f"MD5 mismatch for {name}.")
            partial.replace(destination)
            print(f"Downloaded and verified {name}", flush=True)
            return destination
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            if attempt == 5:
                raise SystemExit(f"Could not download {name}: {error}") from error
            print(f"Retrying {name} ({attempt}/5): {error}", flush=True)
            time.sleep(attempt * 3)
    raise RuntimeError(f"Failed to download {name}.")


def find_7zip() -> str | None:
    return shutil.which("7z") or next((path for path in (
        Path(r"C:\Program Files\7-Zip\7z.exe"),
        Path(r"C:\Program Files (x86)\7-Zip\7z.exe"),
    ) if path.is_file()), None)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--workers", type=int, default=3, help="Parallel part downloads (default: 3).")
    parser.add_argument("--no-extract", action="store_true", help="Download and verify archive parts without extracting them.")
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    parts_dir = output / "parts"
    parts_dir.mkdir(parents=True, exist_ok=True)
    with urlopen(Request(API_URL, headers={"User-Agent": "FactorySafetyConsoleDatasetSetup/1.0"}), timeout=30) as response:
        record = __import__("json").load(response)
    license_id = (record.get("metadata", {}).get("license") or {}).get("id", "")
    files = sorted(
        (item for item in record.get("files", []) if item.get("key", "").startswith("RWF-2000.7z.")),
        key=lambda item: item["key"],
    )
    if license_id != "cc-by-4.0":
        raise SystemExit(f"Zenodo license changed or is missing ({license_id!r}); review the record before downloading.")
    if not files:
        raise SystemExit("The Zenodo record did not return the expected RWF-2000 multipart files.")
    total_size = sum(item["size"] for item in files)
    print(f"RWF-2000: {len(files)} parts, {total_size / (1024**3):.1f} GiB compressed, CC BY 4.0.", flush=True)
    with ThreadPoolExecutor(max_workers=max(1, min(6, args.workers))) as executor:
        futures = [executor.submit(download_part, item, parts_dir, total_size) for item in files]
        for future in as_completed(futures):
            future.result()
    if args.no_extract:
        print(f"Verified archive parts are in {parts_dir}", flush=True)
        return
    seven_zip = find_7zip()
    if not seven_zip:
        raise SystemExit(f"All parts are downloaded. Install 7-Zip to extract {parts_dir / files[0]['key']}.")
    extract_dir = output / "extracted"
    extract_dir.mkdir(parents=True, exist_ok=True)
    first_part = parts_dir / files[0]["key"]
    print(f"Extracting RWF-2000 to {extract_dir} ...", flush=True)
    subprocess.run([seven_zip, "x", str(first_part), f"-o{extract_dir}", "-y"], check=True)
    print(f"Extraction complete: {extract_dir}", flush=True)


if __name__ == "__main__":
    main()
