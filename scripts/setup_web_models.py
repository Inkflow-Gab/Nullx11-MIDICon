#!/usr/bin/env python3
"""Download and verify the pinned piano ONNX mirror. No executable model code.

The original Kong et al. weights are CC BY 4.0. This mirror splits the external
ONNX tensor file for GitHub's file-size limit. Basic Pitch ships with its wheel.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from webapp.config import MODEL_DIR

COMMIT = "921b86b73c72161892ee414048792d50de77fafe"
URL = f"https://codeload.github.com/pratham-jain33/kongML-optimized/tar.gz/{COMMIT}"
HASHES = {
    "model.onnx": "bcbbfeff7950e9d2665336b60105b4767e9d7b8de1de14ce607c616b72668414",
    "kong_notes_2s5_fp32.onnx.data": "21e9437c5f4c55737126e13778c804faff4b2eca49a9a7cc4ea49fd99804f001",
}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use an already downloaded tar.gz")
    args = parser.parse_args()
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if all((MODEL_DIR / name).exists() and digest(MODEL_DIR / name) == sha for name, sha in HASHES.items()):
        print(f"Verified piano model already installed: {MODEL_DIR}")
        from setup_beat_model import main as setup_beat

        setup_beat()
        return
    print("Downloading the pinned piano model mirror (~85 MB)…")
    if args.archive:
        blob = args.archive.read_bytes()
    else:
        request = urllib.request.Request(URL, headers={"User-Agent": "Nullx-MIDICon-setup/1.0"})
        with urllib.request.urlopen(request, timeout=120) as response:
            blob = response.read(130 * 1024 * 1024 + 1)
    if len(blob) > 130 * 1024 * 1024:
        raise RuntimeError("Model archive exceeds the download limit.")
    prefix = f"kongML-optimized-{COMMIT}/"
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as archive:
        member = archive.extractfile(prefix + "models/kong_notes_2s5_fp32.onnx")
        if member is None:
            raise RuntimeError("Model graph missing from archive")
        graph = MODEL_DIR / "model.onnx.tmp"
        graph.write_bytes(member.read())
        data = MODEL_DIR / "kong_notes_2s5_fp32.onnx.data.tmp"
        with data.open("wb") as output:
            for suffix in "abcdefghij":
                part = archive.extractfile(prefix + f"models/kong_notes_2s5_fp32.onnx.data.part-a{suffix}")
                if part is None:
                    raise RuntimeError(f"Missing model shard {suffix}")
                while chunk := part.read(1024 * 1024):
                    output.write(chunk)
    for tmp, name in ((graph, "model.onnx"), (data, "kong_notes_2s5_fp32.onnx.data")):
        actual = digest(tmp)
        if actual != HASHES[name]:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"Checksum mismatch for {name}: {actual}")
        tmp.replace(MODEL_DIR / name)
    print(f"Piano model verified and installed: {MODEL_DIR}")
    from setup_beat_model import main as setup_beat

    setup_beat()


if __name__ == "__main__":
    main()
